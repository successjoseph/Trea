/**
 * People: financial *members* and system *users*.
 *
 * These are deliberately separate collections. A member is someone whose money
 * flows through the treasury; a user is someone who can sign in and act on it.
 * Conflating them is how a treasury ends up granting write access to everyone
 * who ever paid dues.
 */
import { db, doc, setDoc, updateDoc, deleteDoc, paths, serverTimestamp } from '../core/fb.js';
import { state, isDemo } from '../core/state.js';
import { requireCan, ROLES, ROLE_LABELS, PERMISSIONS, basePermissions } from '../core/rbac.js';
import { now } from '../core/time.js';
import { toMinor } from '../core/money.js';
import { logAudit, AUDIT_CATEGORY } from '../data/audit.js';
import { demoSet, demoUpdate, demoDelete } from './demo.js';
import { ValidationError } from '../data/transactions.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normaliseEmail(value) {
    const email = String(value ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ValidationError('That is not a valid email address.');
    if (email.length > 254) throw new ValidationError('That email address is too long.');
    return email;
}

/* -------------------------------------------------------------- Members */

export async function addMember({ email, name, duesMonthly }) {
    const denied = requireCan('member.manage');
    if (denied) throw new ValidationError(denied);

    const id = normaliseEmail(email);
    const displayName = String(name ?? '').trim().slice(0, 80);
    if (!displayName) throw new ValidationError('A member needs a name.');
    if (state.members.some((m) => (m.email ?? m.id) === id)) {
        throw new ValidationError('That member is already on the list.');
    }

    const payload = {
        email: id,
        name: displayName,
        role: 'member',
        status: 'active',
        duesMonthlyMinor: Math.abs(toMinor(duesMonthly) || 0),
        joinDateMs: now(),
        joinDate: serverTimestamp(),
        tags: []
    };

    if (isDemo()) demoSet('members', id, payload);
    else await setDoc(doc(db, paths.member(state.session.orgId, id)), payload);

    await logAudit(`Added member ${displayName} (${id})`, {
        category: AUDIT_CATEGORY.PEOPLE, targetId: id
    });
    return payload;
}

export async function updateMember(email, patch) {
    const denied = requireCan('member.manage');
    if (denied) throw new ValidationError(denied);

    const id = normaliseEmail(email);
    const update = {};
    if (patch.name !== undefined) update.name = String(patch.name).trim().slice(0, 80);
    if (patch.duesMonthly !== undefined) update.duesMonthlyMinor = Math.abs(toMinor(patch.duesMonthly) || 0);
    if (patch.status !== undefined) update.status = patch.status === 'archived' ? 'archived' : 'active';
    if (Object.keys(update).length === 0) return;

    if (isDemo()) demoUpdate('members', id, update);
    else await updateDoc(doc(db, paths.member(state.session.orgId, id)), update);

    await logAudit(`Updated member ${id}`, {
        category: AUDIT_CATEGORY.PEOPLE, targetId: id, detail: Object.keys(update).join(', ')
    });
}

/**
 * Archiving, not deleting.
 *
 * A member with transactions cannot be removed - deleting them would orphan
 * every credit they ever paid and silently change historical totals. Archiving
 * hides them from pickers while keeping the ledger intact.
 */
export async function archiveMember(email) {
    const denied = requireCan('member.manage');
    if (denied) throw new ValidationError(denied);

    const id = normaliseEmail(email);
    const hasHistory = state.transactions.some((tx) => tx.userId === id);

    if (!hasHistory) {
        if (isDemo()) demoDelete('members', id);
        else await deleteDoc(doc(db, paths.member(state.session.orgId, id)));
        await logAudit(`Removed member ${id} (no transaction history)`, {
            category: AUDIT_CATEGORY.PEOPLE, targetId: id
        });
        return 'deleted';
    }

    if (isDemo()) demoUpdate('members', id, { status: 'archived', archivedAtMs: now() });
    else await updateDoc(doc(db, paths.member(state.session.orgId, id)), { status: 'archived', archivedAtMs: now() });

    await logAudit(`Archived member ${id}`, {
        category: AUDIT_CATEGORY.PEOPLE, targetId: id, detail: 'Ledger history preserved.'
    });
    return 'archived';
}

/* ------------------------------------------------------- Users and roles */

export const ASSIGNABLE_ROLES = [ROLES.ADMIN, ROLES.TRUSTEE, ROLES.VIEWER];

function assertRoleManagement(targetRole, targetEmail) {
    const denied = requireCan('roles.manage');
    if (denied) throw new ValidationError(denied);
    if (targetEmail === state.session.email) {
        // Without this an owner can demote themselves and lock the org out of
        // its own settings with no way back.
        throw new ValidationError('You cannot change your own role. Ask another owner.');
    }
    if (targetRole === ROLES.OWNER && state.session.role !== ROLES.OWNER) {
        throw new ValidationError('Only an owner can appoint another owner.');
    }
}

/**
 * Grant someone access to the org.
 *
 * Two documents are written: the org-scoped role (authoritative for what they
 * can do here) and a `users/{email}` pointer (so sign-in can resolve their org
 * in one read). The pointer is created only if absent, so inviting an existing
 * user to a second org never silently moves them.
 */
export async function inviteUser({ email, name, role, grants = [], denies = [] }) {
    const id = normaliseEmail(email);
    assertRoleManagement(role, id);

    if (!Object.values(ROLES).includes(role)) throw new ValidationError('Unknown role.');
    if (state.roles.some((r) => (r.email ?? r.id) === id)) {
        throw new ValidationError('That person already has access. Edit their role instead.');
    }

    const payload = {
        email: id,
        name: String(name ?? '').trim().slice(0, 80) || id,
        role,
        grants: sanitisePermissions(grants),
        denies: sanitisePermissions(denies),
        status: 'active',
        invitedBy: state.session.email,
        createdAtMs: now(),
        createdAt: serverTimestamp()
    };

    if (isDemo()) {
        demoSet('roles', id, payload);
    } else {
        await setDoc(doc(db, paths.role(state.session.orgId, id)), payload);
        await setDoc(doc(db, paths.user(id)), {
            email: id,
            orgId: state.session.orgId,
            role,
            name: payload.name,
            updatedAt: serverTimestamp()
        }, { merge: true });
    }

    await logAudit(`Granted ${ROLE_LABELS[role]} access to ${id}`, {
        category: AUDIT_CATEGORY.GOVERNANCE, targetId: id,
        detail: grants.length ? 'Extra permissions: ' + grants.join(', ') : null
    });
    return payload;
}

export async function changeUserRole(email, role) {
    const id = normaliseEmail(email);
    assertRoleManagement(role, id);

    const existing = state.roles.find((r) => (r.email ?? r.id) === id);
    if (!existing) throw new ValidationError('That person does not have access to this org.');
    if (existing.role === ROLES.OWNER && countOwners() <= 1) {
        throw new ValidationError('This is the last owner - appoint another owner before changing this one.');
    }

    const update = { role, updatedAtMs: now(), updatedBy: state.session.email };
    if (isDemo()) demoUpdate('roles', id, update);
    else {
        await updateDoc(doc(db, paths.role(state.session.orgId, id)), update);
        await setDoc(doc(db, paths.user(id)), { role }, { merge: true });
    }

    await logAudit(`Changed ${id} from ${ROLE_LABELS[existing.role]} to ${ROLE_LABELS[role]}`, {
        category: AUDIT_CATEGORY.GOVERNANCE, targetId: id
    });
}

/** Per-user permission overrides, on top of whatever the role already gives. */
export async function setPermissionOverrides(email, { grants, denies }) {
    const id = normaliseEmail(email);
    assertRoleManagement(null, id);

    const existing = state.roles.find((r) => (r.email ?? r.id) === id);
    if (!existing) throw new ValidationError('That person does not have access to this org.');

    const base = new Set(basePermissions(existing.role));
    const update = {
        // A grant the role already includes is noise; a deny for a permission
        // the role never had is noise too. Store only meaningful overrides.
        grants: sanitisePermissions(grants).filter((p) => !base.has(p)),
        denies: sanitisePermissions(denies).filter((p) => base.has(p)),
        updatedAtMs: now(),
        updatedBy: state.session.email
    };

    if (isDemo()) demoUpdate('roles', id, update);
    else await updateDoc(doc(db, paths.role(state.session.orgId, id)), update);

    await logAudit(`Adjusted permissions for ${id}`, {
        category: AUDIT_CATEGORY.GOVERNANCE, targetId: id,
        detail: `+[${update.grants.join(', ')}] -[${update.denies.join(', ')}]`
    });
}

/** Suspend keeps the audit trail attributable; revoke removes access outright. */
export async function suspendUser(email, suspended = true) {
    const id = normaliseEmail(email);
    assertRoleManagement(null, id);

    const update = { status: suspended ? 'suspended' : 'active', updatedAtMs: now() };
    if (isDemo()) demoUpdate('roles', id, update);
    else await updateDoc(doc(db, paths.role(state.session.orgId, id)), update);

    await logAudit(`${suspended ? 'Suspended' : 'Reinstated'} access for ${id}`, {
        category: AUDIT_CATEGORY.SECURITY, targetId: id
    });
}

export async function revokeUser(email) {
    const id = normaliseEmail(email);
    assertRoleManagement(null, id);

    const existing = state.roles.find((r) => (r.email ?? r.id) === id);
    if (existing?.role === ROLES.OWNER && countOwners() <= 1) {
        throw new ValidationError('You cannot remove the last owner.');
    }

    if (isDemo()) demoDelete('roles', id);
    else {
        await deleteDoc(doc(db, paths.role(state.session.orgId, id)));
        await deleteDoc(doc(db, paths.user(id))).catch(() => {
            // The pointer may belong to another org now; losing it is harmless.
        });
    }

    await logAudit(`Revoked all access for ${id}`, {
        category: AUDIT_CATEGORY.SECURITY, targetId: id
    });
}

function countOwners() {
    return state.roles.filter((r) => r.role === ROLES.OWNER && r.status !== 'suspended').length;
}

function sanitisePermissions(list) {
    return Array.from(new Set((list ?? []).filter((p) => Object.hasOwn(PERMISSIONS, p))));
}

