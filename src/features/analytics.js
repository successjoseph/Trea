/**
 * Derived intelligence: KPIs, variance, arrears, budget utilisation, goal
 * progress, alerts and integrity checks.
 *
 * Everything here is a pure function over data already in memory. No extra
 * reads, no background jobs - the cost of the whole analytics surface is a few
 * passes over an array we already hold.
 */
import { state } from '../core/state.js';
import { on, emit, EVENTS } from '../core/bus.js';
import { monthKey, monthRange, monthLabel, now } from '../core/time.js';
import { readAmountMinor, fmt } from '../core/money.js';
import {
    computeTotals, groupByMonth, groupByCategory, memberBalances,
    isCounted, effectiveMonthKey, effectiveStatus, STATUS
} from '../data/ledger.js';

/* ------------------------------------------------------------------ KPIs */

/**
 * Average monthly outflow over the trailing window, ignoring the current
 * (incomplete) month so the figure is not artificially low on the 2nd.
 */
export function burnRateMinor(monthsBack = 6) {
    const months = groupByMonth(state.transactions).filter((m) => m.monthKey < monthKey());
    if (months.length === 0) return 0;
    const recent = months.slice(-monthsBack);
    const total = recent.reduce((s, m) => s + m.outMinor, 0);
    return Math.round(total / recent.length);
}

export function averageIncomeMinor(monthsBack = 6) {
    const months = groupByMonth(state.transactions).filter((m) => m.monthKey < monthKey());
    if (months.length === 0) return 0;
    const recent = months.slice(-monthsBack);
    return Math.round(recent.reduce((s, m) => s + m.inMinor, 0) / recent.length);
}

/**
 * Months of cover at the current burn rate, net of income. Returns Infinity
 * when the org is cash-positive, which the UI renders as "not burning down".
 */
export function runwayMonths() {
    const burn = burnRateMinor();
    const income = averageIncomeMinor();
    const net = burn - income;
    if (net <= 0) return Infinity;
    return state.totals.balanceMinor / net;
}

export function netFlowThisMonth() {
    const mk = monthKey();
    let net = 0, inflow = 0, outflow = 0;
    for (const tx of state.transactions) {
        if (!isCounted(tx) || effectiveMonthKey(tx) !== mk) continue;
        const amount = readAmountMinor(tx);
        net += amount;
        if (amount >= 0) inflow += amount; else outflow += Math.abs(amount);
    }
    return { net, inflow, outflow };
}

/** This month against last month, per bucket. */
export function monthOverMonth() {
    const months = groupByMonth(state.transactions);
    const current = months.find((m) => m.monthKey === monthKey())
        ?? { monthKey: monthKey(), netMinor: 0, inMinor: 0, outMinor: 0, count: 0 };
    const previousKey = months.filter((m) => m.monthKey < monthKey()).pop()?.monthKey;
    const previous = months.find((m) => m.monthKey === previousKey)
        ?? { netMinor: 0, inMinor: 0, outMinor: 0, count: 0 };

    const delta = (a, b) => ({
        absolute: a - b,
        percent: b === 0 ? (a === 0 ? 0 : 100) : ((a - b) / Math.abs(b)) * 100
    });

    return {
        currentKey: current.monthKey,
        previousKey: previousKey ?? null,
        income: delta(current.inMinor, previous.inMinor),
        spend: delta(current.outMinor, previous.outMinor),
        net: delta(current.netMinor, previous.netMinor)
    };
}

/* -------------------------------------------------------------- Budgets */

export function budgetUtilisation(mk = monthKey()) {
    const spendByCategory = new Map(
        groupByCategory(state.transactions, { monthKey: mk }).map((r) => [r.category, r.totalMinor])
    );
    return state.budgets
        .filter((b) => b.active !== false)
        .map((b) => {
            const spentMinor = spendByCategory.get(b.category) ?? 0;
            const limitMinor = Number(b.limitMinor) || 0;
            return {
                ...b,
                spentMinor,
                limitMinor,
                remainingMinor: limitMinor - spentMinor,
                ratio: limitMinor ? spentMinor / limitMinor : 0,
                breached: limitMinor > 0 && spentMinor > limitMinor
            };
        })
        .sort((a, b) => b.ratio - a.ratio);
}

/* ---------------------------------------------------------------- Goals */

export function goalProgress() {
    const balance = state.totals.balanceMinor;
    return state.goals
        .filter((g) => g.status !== 'archived')
        .map((g) => {
            const targetMinor = Number(g.targetMinor) || 0;
            const ratio = targetMinor ? Math.max(0, balance) / targetMinor : 0;
            const daysLeft = g.deadline
                ? Math.ceil((Date.parse(g.deadline + 'T23:59:59') - now()) / 86400000)
                : null;
            const shortfall = Math.max(0, targetMinor - Math.max(0, balance));
            return {
                ...g, targetMinor, ratio, daysLeft, shortfall,
                monthlyNeededMinor: daysLeft && daysLeft > 0
                    ? Math.ceil(shortfall / Math.max(1, daysLeft / 30))
                    : shortfall
            };
        })
        .sort((a, b) => b.ratio - a.ratio);
}

/* -------------------------------------------------------------- Members */

/**
 * Dues arrears. A member owes for every whole month since they joined in which
 * no dues credit was recorded for them.
 */
export function arrearsReport() {
    const byMember = new Map();
    for (const tx of state.transactions) {
        if (!isCounted(tx) || tx.type !== 'credit' || !tx.userId || tx.userId === 'org') continue;
        if (!byMember.has(tx.userId)) byMember.set(tx.userId, new Set());
        byMember.get(tx.userId).add(effectiveMonthKey(tx));
    }

    const currentMonth = monthKey();
    return state.members
        .filter((m) => m.status !== 'archived' && Number(m.duesMonthlyMinor) > 0)
        .map((m) => {
            const joined = m.joinDateMs ? monthKey(m.joinDateMs) : currentMonth;
            // The current month is not yet late.
            const upTo = monthRange(joined, currentMonth).slice(0, -1);
            const paid = byMember.get(m.email ?? m.id) ?? new Set();
            const missed = upTo.filter((mk) => !paid.has(mk));
            return {
                email: m.email ?? m.id,
                name: m.name ?? m.id,
                missedMonths: missed,
                missedCount: missed.length,
                owedMinor: missed.length * (Number(m.duesMonthlyMinor) || 0)
            };
        })
        .filter((r) => r.missedCount > 0)
        .sort((a, b) => b.owedMinor - a.owedMinor);
}

export function memberSummaries() {
    const balances = memberBalances(state.transactions);
    return state.members.map((m) => {
        const key = m.email ?? m.id;
        const stats = balances.get(key) ?? { totalMinor: 0, count: 0, lastMs: 0 };
        return { ...m, email: key, ...stats };
    }).sort((a, b) => b.totalMinor - a.totalMinor);
}

/* --------------------------------------------------------------- Alerts */

/**
 * The notification centre. Derived fresh every time rather than stored, so an
 * alert disappears the moment its cause is fixed and nothing needs cleaning up.
 */
export function computeAlerts() {
    const alerts = [];
    const totals = state.totals;

    if (totals.balanceMinor < 0) {
        alerts.push({
            level: 'critical', title: 'Balance is negative',
            body: `The treasury is showing ${fmt(totals.balanceMinor)}. Something has been recorded twice or a debit is wrong.`,
            view: 'ledger'
        });
    }

    for (const b of budgetUtilisation()) {
        if (b.breached) {
            alerts.push({
                level: 'critical', title: `${b.category} is over budget`,
                body: `${fmt(b.spentMinor)} spent against a ${fmt(b.limitMinor)} limit this month.`,
                view: 'budgets'
            });
        } else if (b.ratio >= 0.85) {
            alerts.push({
                level: 'warn', title: `${b.category} is at ${Math.round(b.ratio * 100)}% of budget`,
                body: `${fmt(b.remainingMinor)} left of this month's ${b.category} budget.`,
                view: 'budgets'
            });
        }
    }

    const held = state.transactions.filter((tx) => effectiveStatus(tx) === STATUS.HELD);
    if (held.length) {
        alerts.push({
            level: 'warn', title: `${held.length} entr${held.length === 1 ? 'y' : 'ies'} awaiting approval`,
            body: `${fmt(held.reduce((s, tx) => s + Math.abs(readAmountMinor(tx)), 0))} is held out of the balance until a trustee approves it.`,
            view: 'approvals'
        });
    }

    const arrears = arrearsReport();
    if (arrears.length) {
        alerts.push({
            level: 'info', title: `${arrears.length} member${arrears.length === 1 ? '' : 's'} behind on dues`,
            body: `${fmt(arrears.reduce((s, a) => s + a.owedMinor, 0))} outstanding in total.`,
            view: 'members'
        });
    }

    const unsealed = unsealedClosedMonths();
    if (unsealed.length) {
        alerts.push({
            level: 'info', title: `${unsealed.length} closed month${unsealed.length === 1 ? '' : 's'} not yet sealed`,
            body: `${unsealed.map(monthLabel).join(', ')} will be sealed automatically the next time an entry is recorded.`,
            view: 'snapshots'
        });
    }

    const runway = runwayMonths();
    if (Number.isFinite(runway) && runway < 3) {
        alerts.push({
            level: 'warn', title: 'Under three months of runway',
            body: `At the current burn rate the balance covers about ${runway.toFixed(1)} more months.`,
            view: 'reports'
        });
    }

    for (const g of goalProgress()) {
        if (g.daysLeft !== null && g.daysLeft < 0 && g.ratio < 1) {
            alerts.push({
                level: 'warn', title: `Goal "${g.name}" passed its deadline`,
                body: `${Math.round(g.ratio * 100)}% funded, ${fmt(g.shortfall)} short.`,
                view: 'goals'
            });
        }
    }

    return alerts;
}

function unsealedClosedMonths() {
    const months = groupByMonth(state.transactions).map((m) => m.monthKey);
    if (months.length === 0) return [];
    const sealed = new Set(state.snapshots.filter((s) => s.auto !== false).map((s) => s.monthKey ?? s.id));
    return monthRange(months[0], monthKey())
        .filter((mk) => mk < monthKey() && months.includes(mk) && !sealed.has(mk));
}

/* ------------------------------------------------------------ Integrity */

/**
 * Data-quality sweep. Every finding names the specific record so it can be
 * acted on, rather than reporting a bare count.
 */
export function integrityReport() {
    const findings = [];
    const memberIds = new Set(state.members.map((m) => m.email ?? m.id));

    for (const tx of state.transactions) {
        const amount = readAmountMinor(tx);
        if (!Number.isFinite(amount)) {
            findings.push({ level: 'critical', id: tx.id, message: 'Amount is not a number - this row is corrupting the balance.' });
        }
        if (tx.type === 'debit' && amount > 0) {
            findings.push({ level: 'critical', id: tx.id, message: 'A debit is stored as a positive amount, so it is adding to the balance instead of subtracting.' });
        }
        if (tx.type === 'credit' && tx.userId && tx.userId !== 'org' && !memberIds.has(tx.userId)) {
            findings.push({ level: 'warn', id: tx.id, message: `Credit belongs to "${tx.userId}", who is not on the members list.` });
        }
        if (!tx.monthKey && !tx.createdAtMs && !tx.timestamp) {
            findings.push({ level: 'warn', id: tx.id, message: 'No usable date - this row cannot be placed in any month.' });
        }
    }

    // Same amount, same member, same day, same reason: almost always a
    // double-click on the submit button.
    const seen = new Map();
    for (const tx of state.transactions) {
        if (!isCounted(tx)) continue;
        const key = [tx.userId, readAmountMinor(tx), tx.effectiveDate, tx.reason ?? ''].join('|');
        if (seen.has(key)) {
            findings.push({
                level: 'warn', id: tx.id,
                message: `Looks like a duplicate of ${seen.get(key)} - same member, amount, date and reason.`
            });
        } else {
            seen.set(key, tx.id);
        }
    }

    for (const snap of state.snapshots) {
        if (snap.auto === false) continue;
        const mk = snap.monthKey ?? snap.id;
        const recomputed = groupByMonth(state.transactions).find((m) => m.monthKey === mk);
        if (recomputed && Number.isFinite(snap.netMinor) && snap.netMinor !== recomputed.netMinor) {
            findings.push({
                level: 'warn', id: mk,
                message: `Sealed snapshot for ${monthLabel(mk)} says ${fmt(snap.netMinor)} net, but the transactions now total ${fmt(recomputed.netMinor)} - a back-dated entry landed in a sealed month.`
            });
        }
    }

    return {
        findings,
        checked: state.transactions.length,
        clean: findings.length === 0
    };
}

/* ------------------------------------------------------------ Refreshers */

export function recomputeTotals() {
    state.totals = computeTotals(state.transactions);
    return state.totals;
}

export function refreshAlerts() {
    state.alerts = computeAlerts();
    return state.alerts;
}

/**
 * Derived state has exactly one owner.
 *
 * Totals and alerts are recomputed here, in response to the same events every
 * view listens to, rather than at each write site. Doing it per call site is
 * how the demo sandbox ended up with a stale balance while the month-to-date
 * figures beside it were correct: one path recomputed and the other did not.
 *
 * Registered before the views subscribe, so by the time anything re-renders,
 * `state.totals` and `state.alerts` already reflect the new data.
 */
export function initDerivedState() {
    const refresh = () => {
        recomputeTotals();
        refreshAlerts();
        emit(EVENTS.ALERTS_CHANGED, state.alerts);
    };
    for (const event of [
        EVENTS.TX_CHANGED, EVENTS.MEMBERS_CHANGED, EVENTS.BUDGETS_CHANGED,
        EVENTS.GOALS_CHANGED, EVENTS.SNAPSHOTS_CHANGED, EVENTS.SETTINGS_CHANGED
    ]) {
        on(event, refresh);
    }
    refresh();
}

