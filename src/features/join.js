/**
 * Getting into an organisation: profile, memberships, creating an org, and the
 * one-time passcodes that let someone join one.
 *
 * Every write here is also checked by firestore.rules. The checks in this file
 * exist to give a clear message early; the rules are what actually decide.
 */
import {
    auth, db, doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where,
    writeBatch, paths
} from '../core/fb.js';
import { state, isDemo } from '../core/state.js';
import { can, ROLES, ROLE_LABELS } from '../core/rbac.js';
import { logAudit, AUDIT_CATEGORY } from '../data/audit.js';
import { ValidationError } from '../data/transactions.js';
import { DEFAULT_SETTINGS } from './records.js';
import {
    generatePasscode, hashPasscode, normalizePasscode, isWellFormed,
    formatPasscode, passcodeExpiresAtMs
} from './passcodes.js';

const RANK = { owner: 4, admin: 3, trustee: 2, viewer: 1 };
const ORG_TYPES = ['personal', 'company'];

/** Roles a person may hand out: strictly below their own. Owners are never issued. */
export function issuableRoles(issuerRole) {
    return [ROLES.ADMIN, ROLES.TRUSTEE, ROLES.VIEWER]
        .filter((r) => (RANK[r] ?? 0) < (RANK[issuerRole] ?? 0));
}

const GENERIC_BAD_CODE = 'That code is not valid. It may have expired or already been used. Ask for a new one.';

function clean(value, max = 80) {
    return String(value ?? '').trim().slice(0, max);
}

function isPermissionDenied(error) {
    return error?.code === 'permission-denied';
}

function randomId(bytes = 10) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------- Profile */

/**
 * Create the `users/{uid}` profile on first sign-in. The rules only allow the
 * profile to be written by its owner, with the email from their verified token.
 */
export async function ensureProfile(user, name) {
    const ref = doc(db, paths.user(user.uid));
    const snap = await getDoc(ref);
    if (snap.exists()) return;
    const email = String(user.email ?? '').toLowerCase();
    await setDoc(ref, {
        email,
        name: clean(name) || email.split('@')[0],
        createdAtMs: Date.now()
    });
}

/* -------------------------------------------------------- Memberships */

/**
 * Orgs this user belongs to, with names for the switcher. A membership alone
 * does not grant access: `resolveAccess` checks the role document as well, so
 * a stale membership (after revocation) simply fails to open.
 */
export async function listMemberships(user) {
    const snap = await getDocs(collection(db, paths.memberships(user.uid)));
    const rows = snap.docs
        .map((d) => ({ orgId: d.id, ...d.data() }))
        .filter((m) => m.status === 'active');

    for (const row of rows) {
        try {
            const org = await getDoc(doc(db, paths.org(row.orgId)));
            row.name = org.exists() ? (org.data().name ?? row.orgId) : row.orgId;
        } catch {
            row.name = row.orgId;
        }
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------- Creating an org */

/**
 * Create a new org with the signed-in user as its first owner. The org, the
 * owner role and the owner membership are written in one batch, so there is
 * never an org without an owner. Settings are written afterwards, once the
 * owner role exists, because the rules require it.
 */
export async function createOrg({ name, type, displayName }) {
    const label = clean(name);
    if (!label) throw new ValidationError('Give the organisation a name.');
    if (!ORG_TYPES.includes(type)) throw new ValidationError('Choose personal or company.');

    const user = auth.currentUser;
    if (!user) throw new ValidationError('Sign in first.');
    const uid = user.uid;
    const email = String(user.email ?? '').toLowerCase();
    const orgId = 'org-' + randomId(10);
    const now = Date.now();

    const batch = writeBatch(db);
    batch.set(doc(db, paths.org(orgId)), { name: label, type, createdByUid: uid, createdAtMs: now });
    batch.set(doc(db, paths.role(orgId, uid)), {
        uid, email, name: clean(displayName) || email.split('@')[0],
        role: ROLES.OWNER, status: 'active', grants: [], denies: [],
        invitedBy: 'self', createdAtMs: now
    });
    batch.set(doc(db, paths.membership(uid, orgId)), {
        orgId, role: ROLES.OWNER, status: 'active', joinedVia: 'create', joinedAtMs: now
    });
    await batch.commit();

    await setDoc(doc(db, paths.settings(orgId)), { ...DEFAULT_SETTINGS, orgName: label });
    return orgId;
}

/* ------------------------------------------------------------ Passcodes */

/**
 * Issue a passcode bound to one email. The plain code is returned once, for the
 * issuer to copy; only its SHA-256 is stored.
 */
export async function createInvite({ email, role }) {
    const denied = can('invite.create') ? null : 'Your role cannot invite people.';
    if (denied) throw new ValidationError(denied);
    if (isDemo()) throw new ValidationError('Invites are not available in the demo sandbox.');

    const id = String(email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(id) || id.length > 254) {
        throw new ValidationError('That is not a valid email address.');
    }
    if (!issuableRoles(state.session.role).includes(role)) {
        throw new ValidationError(`You cannot issue the ${ROLE_LABELS[role] ?? role} role.`);
    }
    if (state.roles.some((r) => (r.email ?? r.id) === id)) {
        throw new ValidationError('That person already has access. Change their role instead.');
    }

    const code = generatePasscode();
    const hash = await hashPasscode(code);
    const createdAtMs = Date.now();
    const expiresAtMs = passcodeExpiresAtMs(createdAtMs);

    await setDoc(doc(db, paths.passcode(hash)), {
        orgId: state.session.orgId,
        role,
        boundEmail: id,
        createdByUid: state.session.uid,
        createdAtMs,
        expiresAtMs,
        status: 'pending'
    });

    await logAudit(`Issued a ${ROLE_LABELS[role]} passcode for ${id}`, {
        category: AUDIT_CATEGORY.GOVERNANCE, targetId: id,
        detail: 'Valid for 35 minutes or one use, whichever comes first.'
    });

    return { code: formatPasscode(code), hash, email: id, role, expiresAtMs };
}

/**
 * Passcodes for this org. Only owners can list them (the rules say so), so for
 * anyone else this returns an empty list rather than an error.
 */
export async function listPasscodes(orgId) {
    try {
        const snap = await getDocs(query(collection(db, paths.passcodes), where('orgId', '==', orgId)));
        return snap.docs
            .map((d) => ({ hash: d.id, ...d.data() }))
            .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
    } catch (error) {
        if (isPermissionDenied(error)) return [];
        throw error;
    }
}

export async function revokePasscode(hash) {
    await updateDoc(doc(db, paths.passcode(hash)), { status: 'revoked' });
    await logAudit('Revoked an unused passcode', { category: AUDIT_CATEGORY.GOVERNANCE, targetId: hash.slice(0, 12) });
}

/**
 * Redeem a passcode. The bound-email check happens in the rules: anyone else
 * who tries gets the same generic message as a wrong code, so the screen never
 * reveals whether a code exists or who it was issued to.
 *
 * Passcode, role and membership change in one batch, so either all of them
 * apply or none do.
 */
export async function joinWithPasscode(input, displayName) {
    const normalized = normalizePasscode(input);
    if (!isWellFormed(normalized)) throw new ValidationError(GENERIC_BAD_CODE);

    const user = auth.currentUser;
    if (!user) throw new ValidationError('Sign in first.');
    const uid = user.uid;
    const email = String(user.email ?? '').toLowerCase();

    const hash = await hashPasscode(normalized);
    let snap;
    try {
        snap = await getDoc(doc(db, paths.passcode(hash)));
    } catch (error) {
        if (isPermissionDenied(error)) throw new ValidationError(GENERIC_BAD_CODE);
        throw error;
    }
    if (!snap.exists()) throw new ValidationError(GENERIC_BAD_CODE);

    const p = snap.data();
    if (p.status !== 'pending' || p.expiresAtMs <= Date.now()) {
        throw new ValidationError(GENERIC_BAD_CODE);
    }

    // Already a member? Then the batch would be an update the rules refuse, so
    // say so plainly. A read the rules refuse means "not a member", which is fine.
    try {
        const existing = await getDoc(doc(db, paths.role(p.orgId, uid)));
        if (existing.exists()) throw new ValidationError('You already have access to that organisation.');
    } catch (error) {
        if (error instanceof ValidationError) throw error;
        if (!isPermissionDenied(error)) throw error;
    }

    const now = Date.now();
    const name = clean(displayName) || email.split('@')[0];
    const batch = writeBatch(db);
    batch.update(doc(db, paths.passcode(hash)), { status: 'used', usedByUid: uid, usedAtMs: now });
    batch.set(doc(db, paths.role(p.orgId, uid)), {
        uid, email, name, role: p.role, status: 'active', grants: [], denies: [],
        passcodeId: hash, invitedBy: p.createdByUid, createdAtMs: now
    });
    batch.set(doc(db, paths.membership(uid, p.orgId)), {
        orgId: p.orgId, role: p.role, status: 'active', joinedVia: 'passcode',
        passcodeId: hash, joinedAtMs: now
    });
    await batch.commit();
    return p.orgId;
}
