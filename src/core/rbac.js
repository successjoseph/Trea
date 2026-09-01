/**
 * Role-based access control.
 *
 * Four roles, one permission matrix, and per-user grant/deny overrides so an
 * owner can hand a single extra capability to one person without inventing a
 * new role. Everything here is a *UX* gate - the authoritative copy of this
 * matrix lives in firestore.rules, because anything enforced only in the
 * browser is enforced nowhere.
 */
import { state } from './state.js';

export const ROLES = {
    OWNER: 'owner',
    ADMIN: 'admin',
    TRUSTEE: 'trustee',
    VIEWER: 'viewer'
};

export const ROLE_LABELS = {
    owner: 'Owner',
    admin: 'Admin',
    trustee: 'Trustee',
    viewer: 'Viewer'
};

export const ROLE_DESCRIPTIONS = {
    owner: 'Full control, including managing people and org settings. Cannot be removed by anyone but another owner.',
    admin: 'Runs day-to-day treasury: records money in and out, manages members, budgets and goals.',
    trustee: 'Oversight only. Reviews and approves large spends, reconciles against the bank, reads the full audit trail.',
    viewer: 'Read-only access to balances and reports.'
};

/** Every capability the app checks. Grouped by area for the roles console. */
export const PERMISSIONS = {
    'tx.create': 'Record transactions',
    'tx.correct': 'Correct own entries inside the window',
    'tx.correct.any': 'Correct anyone’s entries inside the window',
    'tx.void': 'Reverse a published transaction',
    'tx.approve': 'Approve transactions above the threshold',
    'member.manage': 'Add, edit and archive members',
    'snapshot.create': 'Take a manual balance snapshot',
    'budget.manage': 'Create and edit budgets',
    'goal.manage': 'Create and edit savings goals',
    'recurring.manage': 'Manage recurring entries',
    'reconcile.manage': 'Record bank reconciliations',
    'audit.view': 'Read the audit log',
    'data.export': 'Export ledger data',
    'data.import': 'Bulk-import transactions',
    'roles.manage': 'Add and remove people, change roles',
    'settings.manage': 'Change org settings'
};

const MATRIX = {
    owner: Object.keys(PERMISSIONS),
    admin: [
        'tx.create', 'tx.correct', 'tx.void', 'member.manage', 'snapshot.create',
        'budget.manage', 'goal.manage', 'recurring.manage', 'audit.view',
        'data.export', 'data.import'
    ],
    trustee: [
        'tx.approve', 'reconcile.manage', 'audit.view', 'data.export', 'snapshot.create'
    ],
    viewer: []
};

/** Permissions a role holds before overrides. */
export function basePermissions(role) {
    return MATRIX[role] ?? [];
}

/** Effective permission set for a session, after grants and denies. */
export function effectivePermissions(session = state.session) {
    if (!session) return new Set();
    const set = new Set(basePermissions(session.role));
    for (const g of session.grants ?? []) if (PERMISSIONS[g]) set.add(g);
    for (const d of session.denies ?? []) set.delete(d);
    return set;
}

export function can(permission, session = state.session) {
    if (!session) return false;
    if (session.status === 'suspended') return false;
    return effectivePermissions(session).has(permission);
}

export function isOwner(session = state.session) {
    return session?.role === ROLES.OWNER;
}

/**
 * Guard for write paths. Returns an explanatory string when blocked so callers
 * can surface *why* rather than silently doing nothing.
 */
export function requireCan(permission) {
    if (can(permission)) return null;
    return `Your role (${ROLE_LABELS[state.session?.role] ?? 'unknown'}) cannot ${PERMISSIONS[permission]?.toLowerCase() ?? permission}.`;
}

/**
 * Hide or disable any element tagged `data-perm="…"`. Called after every render
 * so newly-created nodes are gated too.
 */
export function applyPermissionsToDom(root = document) {
    for (const node of root.querySelectorAll('[data-perm]')) {
        const allowed = node.dataset.perm.split(/\s+/).every((p) => can(p));
        node.classList.toggle('hidden', !allowed);
    }
    for (const node of root.querySelectorAll('[data-perm-disable]')) {
        const allowed = node.dataset.permDisable.split(/\s+/).every((p) => can(p));
        node.toggleAttribute('disabled', !allowed);
        node.classList.toggle('opacity-50', !allowed);
        node.classList.toggle('cursor-not-allowed', !allowed);
    }
}
