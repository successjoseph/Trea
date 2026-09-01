/**
 * The ledger engine: the single source of truth for what a transaction is
 * *worth* right now.
 *
 * A transaction has a stored `status`, but its *effective* status is derived,
 * because two of the four states are time- or approval-dependent:
 *
 *   void     - reversed or discarded. Never counted.
 *   pending  - inside its correction window. Deliberately NOT counted, so a
 *              mistake never touches the balance, any report, or any export
 *              while it can still be fixed.
 *   held     - over the approval threshold and not yet approved. Not counted.
 *   active   - counted everywhere.
 *
 * Deriving rather than trusting the stored flag matters: it means the balance is
 * correct the instant a window expires, with no cron job, no cloud function and
 * no client needing to have written anything back. The write-back in
 * `pending.js` is an optimisation for query-ability, not a correctness
 * requirement.
 */
import { now, txMillis, monthKey } from '../core/time.js';
import { readAmountMinor } from '../core/money.js';

export const STATUS = {
    PENDING: 'pending',
    ACTIVE: 'active',
    HELD: 'held',
    VOID: 'void'
};

export function effectiveStatus(tx, atMs = now()) {
    if (!tx) return STATUS.VOID;
    if (tx.status === STATUS.VOID) return STATUS.VOID;

    const releaseAt = Number(tx.releaseAtMs);
    if (tx.status === STATUS.PENDING && Number.isFinite(releaseAt) && atMs < releaseAt) {
        return STATUS.PENDING;
    }
    if (tx.approvalRequired && !tx.approvedAtMs) return STATUS.HELD;
    return STATUS.ACTIVE;
}

export function isCounted(tx, atMs = now()) {
    return effectiveStatus(tx, atMs) === STATUS.ACTIVE;
}

/** Milliseconds left in the correction window; 0 once it has closed. */
export function windowRemainingMs(tx, atMs = now()) {
    if (tx?.status !== STATUS.PENDING) return 0;
    const releaseAt = Number(tx.releaseAtMs);
    if (!Number.isFinite(releaseAt)) return 0;
    return Math.max(0, releaseAt - atMs);
}

export function isCorrectable(tx, atMs = now()) {
    return windowRemainingMs(tx, atMs) > 0;
}

/**
 * The date a transaction belongs to for reporting. Defaults to when it was
 * created, but an explicit `effectiveDate` lets you back-date a cheque that
 * cleared last week without lying about when it was entered.
 */
export function effectiveMs(tx) {
    if (tx?.effectiveDate) {
        const parsed = Date.parse(tx.effectiveDate + 'T12:00:00');
        if (Number.isFinite(parsed)) return parsed;
    }
    return txMillis(tx);
}

export function effectiveMonthKey(tx) {
    return tx?.monthKey || monthKey(effectiveMs(tx));
}

/** Aggregate totals over a transaction list. One pass, no intermediate arrays. */
export function computeTotals(transactions, atMs = now()) {
    const totals = {
        balanceMinor: 0, incomeMinor: 0, creditsMinor: 0, debitsMinor: 0,
        pendingMinor: 0, pendingCount: 0, heldMinor: 0, heldCount: 0,
        voidCount: 0, activeCount: 0
    };

    for (const tx of transactions) {
        const amount = readAmountMinor(tx);
        const status = effectiveStatus(tx, atMs);

        if (status === STATUS.PENDING) {
            totals.pendingMinor += amount;
            totals.pendingCount += 1;
            continue;
        }
        if (status === STATUS.HELD) {
            totals.heldMinor += amount;
            totals.heldCount += 1;
            continue;
        }
        if (status === STATUS.VOID) {
            totals.voidCount += 1;
            continue;
        }

        totals.activeCount += 1;
        totals.balanceMinor += amount;
        if (tx.type === 'income') totals.incomeMinor += amount;
        else if (tx.type === 'credit') totals.creditsMinor += amount;
        else if (tx.type === 'debit') totals.debitsMinor += Math.abs(amount);
        else if (amount < 0) totals.debitsMinor += Math.abs(amount);
        else totals.incomeMinor += amount;
    }

    return totals;
}

/** Closing balance at an instant - the basis for every snapshot. */
export function balanceAsOf(transactions, cutoffMs, atMs = now()) {
    let sum = 0;
    for (const tx of transactions) {
        if (!isCounted(tx, atMs)) continue;
        if (effectiveMs(tx) >= cutoffMs) continue;
        sum += readAmountMinor(tx);
    }
    return sum;
}

/** Per-month aggregates, keyed `YYYY-MM`, for charts and variance reporting. */
export function groupByMonth(transactions, atMs = now()) {
    const months = new Map();
    for (const tx of transactions) {
        if (!isCounted(tx, atMs)) continue;
        const key = effectiveMonthKey(tx);
        if (!months.has(key)) {
            months.set(key, { monthKey: key, netMinor: 0, inMinor: 0, outMinor: 0, count: 0 });
        }
        const bucket = months.get(key);
        const amount = readAmountMinor(tx);
        bucket.netMinor += amount;
        bucket.count += 1;
        if (amount >= 0) bucket.inMinor += amount;
        else bucket.outMinor += Math.abs(amount);
    }
    return Array.from(months.values()).sort((a, b) => a.monthKey.localeCompare(b.monthKey));
}

/** Totals per category, used by budgets and the breakdown chart. */
export function groupByCategory(transactions, { monthKey: mk = null, spendOnly = true, atMs = now() } = {}) {
    const cats = new Map();
    for (const tx of transactions) {
        if (!isCounted(tx, atMs)) continue;
        if (mk && effectiveMonthKey(tx) !== mk) continue;
        const amount = readAmountMinor(tx);
        if (spendOnly && amount >= 0) continue;
        const key = tx.category || 'Uncategorised';
        cats.set(key, (cats.get(key) ?? 0) + Math.abs(amount));
    }
    return Array.from(cats.entries())
        .map(([category, totalMinor]) => ({ category, totalMinor }))
        .sort((a, b) => b.totalMinor - a.totalMinor);
}

/** Per-member balance, for the members list and arrears detection. */
export function memberBalances(transactions, atMs = now()) {
    const map = new Map();
    for (const tx of transactions) {
        if (!isCounted(tx, atMs)) continue;
        if (!tx.userId || tx.userId === 'org') continue;
        const cur = map.get(tx.userId) ?? { totalMinor: 0, count: 0, lastMs: 0 };
        cur.totalMinor += readAmountMinor(tx);
        cur.count += 1;
        cur.lastMs = Math.max(cur.lastMs, effectiveMs(tx));
        map.set(tx.userId, cur);
    }
    return map;
}

/**
 * Attach a running balance to a chronological list. Pending and held entries
 * carry the running total forward unchanged, which is exactly the point: the
 * ledger reads the same whether or not an uncommitted entry is on screen.
 */
export function withRunningBalance(sortedAscending, openingMinor = 0, atMs = now()) {
    let running = openingMinor;
    return sortedAscending.map((tx) => {
        const counted = isCounted(tx, atMs);
        if (counted) running += readAmountMinor(tx);
        return { ...tx, runningMinor: running, counted };
    });
}

/** Chronological sort helper used by every view that lists transactions. */
export function sortByTime(transactions, direction = 'desc') {
    const sign = direction === 'asc' ? 1 : -1;
    return transactions.slice().sort((a, b) => sign * (effectiveMs(a) - effectiveMs(b)));
}
