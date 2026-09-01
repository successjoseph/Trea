/**
 * Central in-memory store.
 *
 * Firestore listeners write here; views read from here. Nothing else keeps a
 * private copy of a collection, so a single re-render always reflects the same
 * consistent picture and we never re-query for data we already hold.
 */
import { emit, EVENTS } from './bus.js';

export const state = {
    /** Signed-in identity plus the resolved org role. */
    session: null,          // { email, name, orgId, role, grants[], denies[], demo }
    org: null,              // org settings document
    transactions: [],
    members: [],
    snapshots: [],
    auditLogs: [],
    roles: [],
    budgets: [],
    goals: [],
    recurring: [],
    reconciliations: [],
    alerts: [],
    /** Derived totals, recomputed by the ledger engine on every tx change. */
    totals: {
        balanceMinor: 0, incomeMinor: 0, creditsMinor: 0, debitsMinor: 0,
        pendingMinor: 0, pendingCount: 0, activeCount: 0
    },
    ui: {
        view: 'overview',
        theme: 'light',
        filters: { text: '', type: 'all', status: 'all', category: 'all', member: 'all', from: '', to: '' },
        ledgerPage: 0,
        pageSize: 25
    }
};

export function setCollection(key, value, event) {
    state[key] = value;
    if (event) emit(event, value);
}

export function setSession(session) {
    state.session = session;
    emit(EVENTS.SESSION_READY, session);
}

export function isDemo() {
    return Boolean(state.session?.demo);
}

/** Read-only accessor used by views that should not mutate arrays in place. */
export function snapshotOf(key) {
    return Array.isArray(state[key]) ? state[key].slice() : state[key];
}
