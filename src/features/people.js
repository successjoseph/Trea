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

/** Owners are never assignable through a role change: ownership is only created by org creation. */
export const ASSIGNABLE_ROLES = [ROLES.ADMIN, ROLES.TRUSTEE, ROLES.VIEWER];

/** The role record for a person in the active org, found by email for display. */
function roleRecordFor(email) {
    const record = state.roles.find((r) => (r.email ?? r.id) === email);
    if (!record) throw new ValidationError('That person does not have access to this org.');
    return record;
}

function assertRoleManagement(targetRole, targetEmail) {
    const denied = requireCan('roles.manage');
    if (denied) throw new ValidationError(denied);
    if (targetEmail === state.session.email) {
        // Without this an owner can demote themselves and lock the org out of
        // its own settings with no way back.
        throw new ValidationError('You cannot change your own role. Ask another owner.');
    }
    if (targetRole === ROLES.OWNER) {
        throw new ValidationError('Ownership cannot be handed out this way.');
    }
    if (targetRole && !ASSIGNABLE_ROLES.includes(targetRole)) {
        throw new ValidationError('Unknown role.');
    }
}

/** Change someone's role. The rules refuse this for anyone at or above the actor. */
export async function changeUserRole(email, role) {
    const id = normaliseEmail(email);
    assertRoleManagement(role, id);

    const existing = roleRecordFor(id);
    if (existing.role === ROLES.OWNER) {
        throw new ValidationError('Owners cannot be changed here.');
    }

    const update = { role, updatedAtMs: now(), updatedBy: state.session.email };
    if (isDemo()) demoUpdate('roles', id, update);
    else await updateDoc(doc(db, paths.role(state.session.orgId, existing.uid)), update);

    await logAudit(`Changed ${id} from ${ROLE_LABELS[existing.role]} to ${ROLE_LABELS[role]}`, {
        category: AUDIT_CATEGORY.GOVERNANCE, targetId: id
    });
}

/** Per-user permission overrides, on top of whatever the role already gives. */
export async function setPermissionOverrides(email, { grants, denies }) {
    const id = normaliseEmail(email);
    assertRoleManagement(null, id);

    const existing = roleRecordFor(id);
    if (existing.role === ROLES.OWNER) throw new ValidationError('Owners already hold every permission.');

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
    else await updateDoc(doc(db, paths.role(state.session.orgId, existing.uid)), update);

    await logAudit(`Adjusted permissions for ${id}`, {
        category: AUDIT_CATEGORY.GOVERNANCE, targetId: id,
        detail: `+[${update.grants.join(', ')}] -[${update.denies.join(', ')}]`
    });
}

/** Suspend keeps the audit trail attributable; revoke removes access outright. */
export async function suspendUser(email, suspended = true) {
    const id = normaliseEmail(email);
    assertRoleManagement(null, id);

    const existing = roleRecordFor(id);
    if (existing.role === ROLES.OWNER) throw new ValidationError('Owners cannot be suspended here.');

    const update = { status: suspended ? 'suspended' : 'active', updatedAtMs: now() };
    if (isDemo()) demoUpdate('roles', id, update);
    else await updateDoc(doc(db, paths.role(state.session.orgId, existing.uid)), update);

    await logAudit(`${suspended ? 'Suspended' : 'Reinstated'} access for ${id}`, {
        category: AUDIT_CATEGORY.SECURITY, targetId: id
    });
}

/**
 * Remove someone's access to this org.
 *
 * Deleting the role document is what ends access: the rules check it on every
 * request. Their membership document lives under their own uid, which an owner
 * cannot write, so it is left behind. It is harmless: switching to that org
 * finds no role and simply reports "no access".
 */
export async function revokeUser(email) {
    const id = normaliseEmail(email);
    assertRoleManagement(null, id);

    const existing = roleRecordFor(id);
    if (existing.role === ROLES.OWNER) throw new ValidationError('Owners cannot be removed here.');

    if (isDemo()) demoDelete('roles', id);
    else await deleteDoc(doc(db, paths.role(state.session.orgId, existing.uid)));

    await logAudit(`Revoked all access for ${id}`, {
        category: AUDIT_CATEGORY.SECURITY, targetId: id
    });
}

function sanitisePermissions(list) {
    return Array.from(new Set((list ?? []).filter((p) => Object.hasOwn(PERMISSIONS, p))));
}
