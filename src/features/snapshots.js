/**
 * Automatic month-end snapshots - no cron, no scheduled function, no server.
 *
 * The rule you asked for: when something new is recorded, compare the month of
 * the new entry against the month of the newest existing entry. If they differ,
 * seal the intervening month(s) *before* the new entry is allowed to move the
 * balance. The snapshot therefore always captures the true closing position of
 * a month, and the first transaction of a new month is what triggers it.
 *
 * Two properties make this safe without a coordinator:
 *
 * 1. Idempotence. The snapshot document ID *is* the month key ("2026-08"), so
 *    two admins recording the first August entry at the same second write the
 *    same document rather than creating duplicates.
 * 2. Gap-filling. If an org records nothing for three months, the next entry
 *    seals all three, each with its own correct closing balance - not one
 *    lumped snapshot.
 *
 * Snapshots are computed only from *counted* transactions, so an entry still
 * inside its correction window can never be baked into a sealed month.
 */
import { db, doc, getDoc, setDoc, paths, serverTimestamp } from '../core/fb.js';
import { state, isDemo } from '../core/state.js';
import { emit, EVENTS } from '../core/bus.js';
import {
    monthKey, monthEndMs, monthLabel, monthRange, now
} from '../core/time.js';
import { balanceAsOf, effectiveMonthKey, isCounted, groupByMonth } from '../data/ledger.js';
import { readAmountMinor } from '../core/money.js';
import { logAudit, AUDIT_CATEGORY } from '../data/audit.js';
import { demoSet } from './demo.js';

/** Guards against two concurrent rollovers in the same tab. */
let rolloverInFlight = null;

/** The newest month that already has a counted transaction in it. */
export function latestEntryMonth() {
    let latest = null;
    for (const tx of state.transactions) {
        if (!isCounted(tx)) continue;
        const key = effectiveMonthKey(tx);
        if (!latest || key > latest) latest = key;
    }
    return latest;
}

/** The oldest month with activity - the starting point for gap-filling. */
export function earliestEntryMonth() {
    let earliest = null;
    for (const tx of state.transactions) {
        if (!isCounted(tx)) continue;
        const key = effectiveMonthKey(tx);
        if (!earliest || key < earliest) earliest = key;
    }
    return earliest;
}

export function hasSnapshot(mk) {
    return state.snapshots.some((s) => (s.monthKey ?? s.id) === mk);
}

/** Everything a sealed month records about itself. */
function buildSnapshotPayload(mk, { auto }) {
    const cutoff = monthEndMs(mk);
    const closingBalanceMinor = balanceAsOf(state.transactions, cutoff);
    const openingBalanceMinor = balanceAsOf(state.transactions, monthEndMs(prevMonthKey(mk)));

    let incomeMinor = 0, creditsMinor = 0, debitsMinor = 0, txCount = 0;
    for (const tx of state.transactions) {
        if (!isCounted(tx) || effectiveMonthKey(tx) !== mk) continue;
        const amount = readAmountMinor(tx);
        txCount += 1;
        if (tx.type === 'income') incomeMinor += amount;
        else if (tx.type === 'credit') creditsMinor += amount;
        else if (amount < 0) debitsMinor += Math.abs(amount);
        else incomeMinor += amount;
    }

    return {
        monthKey: mk,
        monthYear: monthLabel(mk),
        openingBalanceMinor,
        closingBalanceMinor,
        incomeMinor,
        creditsMinor,
        debitsMinor,
        netMinor: closingBalanceMinor - openingBalanceMinor,
        txCount,
        memberCount: state.members.filter((m) => m.status !== 'archived').length,
        auto,
        generatedBy: state.session?.email ?? 'system',
        createdAtMs: now(),
        timestamp: serverTimestamp(),
        // v1 read `total_balance` in major units; keep it so old views and any
        // existing exports still resolve.
        total_balance: closingBalanceMinor / 100
    };
}

function prevMonthKey(mk) {
    const [y, m] = mk.split('-').map(Number);
    return monthKey(new Date(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2, 1));
}

/**
 * Seal every month that is complete but unsealed, up to (not including)
 * `targetMonth`. Returns the list of month keys it sealed.
 *
 * Call this *before* writing a new transaction and pass the new transaction's
 * month - that ordering is what guarantees the sealed figure excludes the entry
 * that triggered the rollover.
 */
export async function ensureRolloverSnapshots(targetMonth = monthKey()) {
    if (rolloverInFlight) return rolloverInFlight;
    rolloverInFlight = (async () => {
        const latest = latestEntryMonth();
        // Nothing has ever been recorded: there is no closed month to seal.
        if (!latest) return [];

        // Every month that has activity, is complete relative to the incoming
        // entry, and has not been sealed yet. Working from the full range rather
        // than only from `latest` matters: an org that seals August but was
        // never open during September still gets September sealed when the first
        // October entry lands.
        const earliest = earliestEntryMonth() ?? latest;
        const active = new Set(state.transactions.filter(isCounted).map(effectiveMonthKey));
        const monthsToSeal = monthRange(earliest, latest)
            .filter((mk) => mk < targetMonth && active.has(mk) && !hasSnapshot(mk));

        // The overwhelmingly common case: the new entry is in the same month as
        // the last one and every earlier month is already sealed. Costs a few
        // string comparisons and zero reads.
        if (monthsToSeal.length === 0) return [];

        const sealed = [];
        for (const mk of monthsToSeal) {
            const payload = buildSnapshotPayload(mk, { auto: true });
            if (isDemo()) {
                demoSet('snapshots', mk, payload);
                sealed.push(mk);
                continue;
            }
            try {
                const ref = doc(db, paths.snapshot(state.session.orgId, mk));
                // Another tab or admin may have sealed it a moment ago; the
                // document ID makes that a no-op rather than a duplicate.
                const existing = await getDoc(ref);
                if (existing.exists()) continue;
                await setDoc(ref, payload);
                sealed.push(mk);
            } catch (error) {
                console.error('[snapshots] failed to seal ' + mk, error);
            }
        }

        if (sealed.length) {
            await logAudit(
                `Auto-sealed month-end balance for ${sealed.map(monthLabel).join(', ')}`,
                { category: AUDIT_CATEGORY.MONEY, targetId: sealed.join(','), detail: 'Triggered by first entry in ' + monthLabel(targetMonth) }
            );
            emit(EVENTS.SNAPSHOTS_CHANGED, state.snapshots);
        }
        return sealed;
    })();

    try {
        return await rolloverInFlight;
    } finally {
        rolloverInFlight = null;
    }
}

/**
 * Manual snapshot of the *current* month-to-date position. Distinct from an
 * auto-sealed month: it is marked `auto: false` and overwrites, because a
 * mid-month checkpoint is a live figure, not a sealed one.
 */
export async function takeManualSnapshot() {
    const mk = monthKey();
    const payload = { ...buildSnapshotPayload(mk, { auto: false }), sealed: false };

    if (isDemo()) {
        demoSet('snapshots', mk, payload);
        return payload;
    }

    await setDoc(doc(db, paths.snapshot(state.session.orgId, mk)), payload, { merge: true });
    await logAudit(`Took a manual balance snapshot for ${monthLabel(mk)}`, {
        category: AUDIT_CATEGORY.MONEY, targetId: mk
    });
    return payload;
}

/**
 * Backfill on open. Purely an idempotent safety net for an org that went quiet
 * across a month boundary - it writes nothing if every closed month is already
 * sealed, which is the normal case, so it costs a single local comparison.
 */
export async function backfillOnOpen() {
    if (state.org?.autoSnapshotOnOpen === false) return [];
    return ensureRolloverSnapshots(monthKey());
}

/**
 * Month-over-month series for charts, merging sealed snapshots with live months
 * so the current (unsealed) month still appears on the trend line.
 */
export function balanceSeries() {
    const sealed = new Map(
        state.snapshots
            .filter((s) => s.auto !== false)
            .map((s) => [s.monthKey ?? s.id, closingOf(s)])
    );

    const months = groupByMonth(state.transactions);
    if (months.length === 0) return [];

    const first = months[0].monthKey;
    const last = monthKey() > months[months.length - 1].monthKey
        ? monthKey()
        : months[months.length - 1].monthKey;

    const series = [];
    let running = 0;
    const byMonth = new Map(months.map((m) => [m.monthKey, m]));

    for (const mk of monthRange(first, last)) {
        running += byMonth.get(mk)?.netMinor ?? 0;
        series.push({
            monthKey: mk,
            closingMinor: sealed.has(mk) ? sealed.get(mk) : running,
            netMinor: byMonth.get(mk)?.netMinor ?? 0,
            inMinor: byMonth.get(mk)?.inMinor ?? 0,
            outMinor: byMonth.get(mk)?.outMinor ?? 0,
            sealed: sealed.has(mk)
        });
    }
    return series;
}

/** Reads closing balance from either the v2 or the legacy snapshot shape. */
export function closingOf(snap) {
    if (Number.isFinite(snap?.closingBalanceMinor)) return snap.closingBalanceMinor;
    if (Number.isFinite(snap?.total_balance)) return Math.round(snap.total_balance * 100);
    return 0;
}

