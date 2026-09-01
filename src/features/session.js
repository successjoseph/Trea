/**
 * Sign-in, role resolution and session hygiene.
 *
 * Access resolves in two hops: `users/{email}` says which org you belong to,
 * and `orgs/{orgId}/roles/{email}` says what you may do inside it. Splitting
 * them means an owner can change someone's permissions without touching the
 * global user record, and the org's permission list is readable as one
 * collection in the roles console.
 */
import {
    auth, db, doc, getDoc, paths,
    onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
    setPersistence, browserSessionPersistence, reauthenticateWithPopup
} from '../core/fb.js';
import { state, setSession } from '../core/state.js';
import { ROLES } from '../core/rbac.js';
import { emit, EVENTS } from '../core/bus.js';
import { configureCurrency } from '../core/money.js';
import { now } from '../core/time.js';
import { toast, confirmDialog, err } from '../ui/toast.js';
import { loadDemoData } from './demo.js';
import { DEFAULT_SETTINGS } from './records.js';

let idleTimer = null;
let warnTimer = null;

/**
 * Session-scoped auth persistence: closing the tab ends the session. A treasury
 * dashboard left signed in on a shared machine is a standing risk, and the
 * convenience of staying logged in for weeks is not worth it here.
 */
export async function configureAuthPersistence() {
    try {
        await setPersistence(auth, browserSessionPersistence);
    } catch (error) {
        console.warn('[session] could not set session persistence', error);
    }
}

export function signInWithGoogle() {
    const provider = new GoogleAuthProvider();
    // Always show the account chooser: on a shared machine, silently reusing the
    // last Google session is how the wrong person ends up signed in.
    provider.setCustomParameters({ prompt: 'select_account' });
    return signInWithPopup(auth, provider);
}

export function signOutNow() {
    stopIdleWatch();
    return signOut(auth);
}

/**
 * Resolve what this signed-in user may do. Returns null when they have no
 * access at all, which the caller renders as the rejection screen.
 */
export async function resolveAccess(user) {
    const email = String(user.email ?? '').toLowerCase();
    if (!email) return null;

    const userDoc = await getDoc(doc(db, paths.user(email)));
    if (!userDoc.exists()) return null;

    const userData = userDoc.data();
    const orgId = userData.orgId;
    if (!orgId) return null;

    let role = null, grants = [], denies = [], status = 'active', name = userData.name;

    try {
        const roleDoc = await getDoc(doc(db, paths.role(orgId, email)));
        if (roleDoc.exists()) {
            const roleData = roleDoc.data();
            role = roleData.role;
            grants = roleData.grants ?? [];
            denies = roleData.denies ?? [];
            status = roleData.status ?? 'active';
            name = roleData.name ?? name;
        }
    } catch (error) {
        console.warn('[session] roles document unreadable, falling back to the user record', error);
    }

    // Orgs created before RBAC existed only have `users/{email}.role === 'admin'`.
    // Honour that rather than locking an existing treasury out of its own data.
    if (!role) role = userData.role === 'admin' ? ROLES.ADMIN : userData.role;
    if (!Object.values(ROLES).includes(role)) return null;
    if (status === 'suspended') {
        return { email, name: name || email, orgId, role, grants, denies, status, suspended: true };
    }

    return {
        email,
        name: name || email.split('@')[0],
        orgId,
        role,
        grants,
        denies,
        status,
        demo: false,
        signedInAtMs: now()
    };
}

/** Enter the local-only demo sandbox. Touches no remote data at all. */
export function startDemoSession() {
    state.org = { ...DEFAULT_SETTINGS, orgName: 'Demo Treasury', id: 'demo' };
    configureCurrency({
        symbol: state.org.currencySymbol,
        locale: state.org.locale,
        code: state.org.currencyCode
    });
    loadDemoData();
    setSession({
        email: 'you@demo.local',
        name: 'Demo Owner',
        orgId: 'demo',
        role: ROLES.OWNER,
        grants: [],
        denies: [],
        status: 'active',
        demo: true,
        signedInAtMs: now()
    });
}

export function watchAuth(handlers) {
    return onAuthStateChanged(auth, handlers);
}

/* ---------------------------------------------------------- Idle timeout */

/**
 * Idle sign-out with a warning.
 *
 * v1 signed users out after an hour with a blocking `alert()` and no notice.
 * This warns a minute ahead and lets the user stay, which is both kinder and
 * safer - a surprise sign-out mid-entry teaches people to disable the feature.
 */
export function startIdleWatch() {
    const timeoutMs = Number(state.org?.idleTimeoutMs) || DEFAULT_SETTINGS.idleTimeoutMs;
    const warnAtMs = Math.max(30000, timeoutMs - 60000);

    const reset = () => {
        clearTimeout(idleTimer);
        clearTimeout(warnTimer);
        warnTimer = setTimeout(async () => {
            const stay = await confirmDialog({
                title: 'Still there?',
                body: 'You will be signed out in about a minute for security. Anything you have already saved is safe.',
                confirmLabel: 'Keep me signed in',
                cancelLabel: 'Sign out now'
            });
            if (stay) reset();
            else signOutNow();
        }, warnAtMs);

        idleTimer = setTimeout(() => {
            toast('Signed out after a period of inactivity.', 'warn', 8000);
            signOutNow();
        }, timeoutMs);
    };

    // `passive` avoids blocking scroll, and pointer/key/scroll together cover
    // every way a person can be present without being noisy about it.
    for (const event of ['pointerdown', 'keydown', 'scroll', 'focus']) {
        window.addEventListener(event, reset, { passive: true });
    }
    reset();
}

export function stopIdleWatch() {
    clearTimeout(idleTimer);
    clearTimeout(warnTimer);
}

/**
 * Force a fresh Google sign-in before a high-consequence action. Used by the
 * roles console: a stolen open laptop should not be enough to appoint an owner.
 */
export async function requireRecentAuth(reason = 'This action needs you to confirm it is you.') {
    if (state.session?.demo) return true;
    const user = auth.currentUser;
    if (!user) return false;

    const lastSignIn = Date.parse(user.metadata?.lastSignInTime ?? '') || 0;
    if (now() - lastSignIn < 5 * 60 * 1000) return true;

    try {
        toast(reason, 'info');
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        await reauthenticateWithPopup(user, provider);
        return true;
    } catch (error) {
        if (error?.code !== 'auth/popup-closed-by-user') {
            console.error('[session] re-authentication failed', error);
        }
        err('Could not confirm your identity, so nothing was changed.');
        return false;
    }
}

export function applyOrgSettings(settings) {
    state.org = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
    configureCurrency({
        symbol: state.org.currencySymbol,
        locale: state.org.locale,
        code: state.org.currencyCode
    });
    emit(EVENTS.SETTINGS_CHANGED, state.org);
}
