/**
 * Firestore subscription layer.
 *
 * Two deliberate cost decisions live here:
 *
 * 1. Bounded listeners. The audit log and the transaction ledger are capped, so
 *    an org with tens of thousands of rows does not stream all of them into a
 *    phone. Everything beyond the cap is reachable through explicit paged loads.
 * 2. One listener per collection, ever. Views read from `state`; they never
 *    open their own subscription. That is what stops the read count growing
 *    with the number of screens.
 *
 * None of these listeners use `orderBy` on a field that might not exist on
 * every document. Firestore's `orderBy` silently excludes any document missing
 * the ordered field from the result set entirely, with no error and nothing to
 * catch - it just returns fewer documents. A collection written partly by an
 * older version of this app (which had no `createdAtMs`, `monthKey`, etc.)
 * would have entire months of real transactions vanish from the ledger while
 * still sitting untouched in Firestore. Sorting happens client-side instead,
 * using the tolerant helpers in `ledger.js` / `time.js` that already handle
 * both document shapes.
 */
import {
    db, collection, query, limit, onSnapshot, doc, getDocs, orderBy, startAfter, paths
} from '../core/fb.js';
import { state } from '../core/state.js';
import { emit, EVENTS } from '../core/bus.js';
import { setServerOffset, txMillis } from '../core/time.js';

/** How many of the newest documents each live listener holds. */
export const LIMITS = {
    transactions: 3000,
    auditLogs: 1000,
    snapshots: 240
};

const unsubscribes = [];

function track(unsub) {
    unsubscribes.push(unsub);
    return unsub;
}

export function stopAllListeners() {
    while (unsubscribes.length) {
        try { unsubscribes.pop()(); } catch { /* already torn down */ }
    }
}

function docsOf(snapshot) {
    return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Estimate the clock skew between this device and the server, using the first
 * server-written timestamp we see. The correction window depends on it, so a
 * user cannot buy themselves extra edit time by setting their clock back.
 */
function calibrateClock(rows) {
    for (const data of rows) {
        const serverMs = data.timestamp?.toMillis?.() ?? data.createdAt?.toMillis?.();
        const clientMs = data.createdAtMs;
        if (serverMs && clientMs) {
            setServerOffset(serverMs - clientMs);
            return;
        }
    }
}

/**
 * Newest-first, without trusting every document to carry the same sort field.
 * `limit` is applied client-side after sorting so a document written by an
 * older schema still competes fairly for a spot in the window instead of being
 * silently pre-filtered by the database.
 */
function newestFirst(rows, count, keyFn) {
    return rows
        .slice()
        .sort((a, b) => keyFn(b) - keyFn(a))
        .slice(0, count);
}

export function subscribeAll(orgId) {
    stopAllListeners();

    track(onSnapshot(
        collection(db, paths.transactions(orgId)),
        (snap) => {
            const rows = docsOf(snap);
            calibrateClock(rows);
            state.transactions = newestFirst(rows, LIMITS.transactions, txMillis);
            emit(EVENTS.TX_CHANGED, state.transactions);
        },
        (error) => onListenerError('transactions', error)
    ));

    track(onSnapshot(collection(db, paths.members(orgId)), (snap) => {
        state.members = docsOf(snap).map((m) => ({ email: m.id, ...m }));
        emit(EVENTS.MEMBERS_CHANGED, state.members);
    }, (e) => onListenerError('members', e)));

    track(onSnapshot(
        collection(db, paths.snapshots(orgId)),
        (snap) => {
            const rows = docsOf(snap);
            // A snapshot's own document ID is its month key in v2, but a v1
            // document's ID is a random Firestore auto-ID, not a sortable
            // date. Fall back to its timestamp for those.
            state.snapshots = newestFirst(rows, LIMITS.snapshots, (s) =>
                (typeof s.monthKey === 'string' && /^\d{4}-\d{2}$/.test(s.monthKey))
                    ? Date.parse(s.monthKey + '-01T00:00:00')
                    : txMillis(s));
            emit(EVENTS.SNAPSHOTS_CHANGED, state.snapshots);
        },
        (e) => onListenerError('snapshots', e)
    ));

    track(onSnapshot(
        collection(db, paths.auditLogs(orgId)),
        (snap) => {
            const rows = docsOf(snap);
            state.auditLogs = newestFirst(rows, LIMITS.auditLogs, txMillis);
            emit(EVENTS.AUDIT_CHANGED, state.auditLogs);
        },
        (e) => onListenerError('audit log', e)
    ));

    track(onSnapshot(collection(db, paths.roles(orgId)), (snap) => {
        state.roles = docsOf(snap).map((r) => ({ email: r.id, ...r }));
        emit(EVENTS.ROLES_CHANGED, state.roles);
    }, (e) => onListenerError('roles', e)));

    for (const [key, pathFn, event] of [
        ['budgets', paths.budgets, EVENTS.BUDGETS_CHANGED],
        ['goals', paths.goals, EVENTS.GOALS_CHANGED],
        ['recurring', paths.recurring, EVENTS.RECURRING_CHANGED],
        ['reconciliations', paths.reconciliations, EVENTS.RECONCILE_CHANGED]
    ]) {
        track(onSnapshot(collection(db, pathFn(orgId)), (snap) => {
            state[key] = docsOf(snap);
            emit(event, state[key]);
        }, (e) => onListenerError(key, e)));
    }

    track(onSnapshot(doc(db, paths.settings(orgId)), (snap) => {
        state.org = { id: orgId, ...(snap.data() ?? {}) };
        emit(EVENTS.SETTINGS_CHANGED, state.org);
    }, (e) => onListenerError('settings', e)));
}

function onListenerError(label, error) {
    if (error?.code === 'permission-denied') {
        // Expected for a viewer or trustee whose rules deny a collection. Not
        // an error condition - the UI simply will not show that section.
        console.info(`[live] no access to ${label}`);
        return;
    }
    console.error(`[live] ${label} listener failed`, error);
}

/**
 * Explicit paged load for history beyond the live window. Used by exports and
 * the full-ledger view, never on first paint. Unlike the live listener this
 * one does need server-side ordering to page correctly, so it is limited to
 * documents that actually carry `createdAtMs` - i.e. never for a collection
 * still holding un-migrated legacy documents.
 */
export async function loadOlderTransactions(orgId, afterDoc = null, pageSize = 500) {
    const base = [collection(db, paths.transactions(orgId)), orderBy('createdAtMs', 'desc')];
    const q = afterDoc
        ? query(...base, startAfter(afterDoc), limit(pageSize))
        : query(...base, limit(pageSize));
    const snap = await getDocs(q);
    return { rows: docsOf(snap), lastDoc: snap.docs[snap.docs.length - 1] ?? null, done: snap.size < pageSize };
}
