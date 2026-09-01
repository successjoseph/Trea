/**
 * Minimal pub/sub. Feature modules publish facts ("transactions changed") and
 * views subscribe; nothing imports a view directly, so the render graph stays
 * a DAG and modules can be loaded in any order.
 */
const listeners = new Map();

export function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => off(event, handler);
}

export function off(event, handler) {
    listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) {
        try {
            handler(payload);
        } catch (err) {
            console.error(`[bus] handler for "${event}" threw`, err);
        }
    }
}

export const EVENTS = {
    TX_CHANGED: 'tx:changed',
    MEMBERS_CHANGED: 'members:changed',
    SNAPSHOTS_CHANGED: 'snapshots:changed',
    AUDIT_CHANGED: 'audit:changed',
    ROLES_CHANGED: 'roles:changed',
    BUDGETS_CHANGED: 'budgets:changed',
    GOALS_CHANGED: 'goals:changed',
    RECURRING_CHANGED: 'recurring:changed',
    RECONCILE_CHANGED: 'reconcile:changed',
    SETTINGS_CHANGED: 'settings:changed',
    PENDING_TICK: 'pending:tick',
    ALERTS_CHANGED: 'alerts:changed',
    VIEW_CHANGED: 'view:changed',
    SESSION_READY: 'session:ready'
};
