/**
 * Sign-in, role resolution and session hygiene.
 *
 * Access is per org. `users/{uid}/memberships` says which orgs you belong to,
 * and `orgs/{orgId}/roles/{uid}` says what you may do inside each one. The
 * switcher chooses the active org; the rules check every request against the
 * org it targets, so a session can never reach another org's data.
 */
import {
    auth, db, doc, getDoc, paths,
    onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
    setPersistence, browserSessionPersistence, reauthenticateWithPopup,
    createUserWithEmailAndPassword, signInWithEmailAndPassword, sendEmailVerification,
    sendPasswordResetEmail, reload
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

export function signInWithEmail(email, password) {
    return signInWithEmailAndPassword(auth, String(email).trim(), password);
}

/**
 * Create an account and send the verification email. Nothing is granted until
 * the address is verified: the rules refuse every read and write for an
 * unverified token, so an account created with someone else's address is inert.
 */
export async function signUpWithEmail(email, password) {
    const cred = await createUserWithEmailAndPassword(auth, String(email).trim(), password);
    await sendEmailVerification(cred.user);
    return cred.user;
}

export function resendVerification(user) {
    return sendEmailVerification(user);
}

/** Refresh the cached token so a verification done in another tab is picked up. */
export function reloadUser(user) {
    return reload(user);
}

export function sendPasswordReset(email) {
    return sendPasswordResetEmail(auth, String(email).trim());
}

export function signOutNow() {
    stopIdleWatch();
    return signOut(auth);
}

/**
 * Resolve what this user may do in one org. Returns null when they hold no role
 * there (the membership is stale or has been revoked), which the caller treats
 * as "not a member of that org".
 *
 * The role document is keyed by uid, so this is one read, and it fails closed:
 * if the read is refused, the user gets no access rather than a fallback.
 */
export async function resolveAccess(user, orgId) {
    const email = String(user.email ?? '').toLowerCase();
    if (!email || !orgId) return null;

    const roleSnap = await getDoc(doc(db, paths.role(orgId, user.uid)));
    if (!roleSnap.exists()) return null;

    const data = roleSnap.data();
    const role = data.role;
    if (!Object.values(ROLES).includes(role)) return null;

    const status = data.status ?? 'active';
    const session = {
        uid: user.uid,
        email,
        name: data.name || email.split('@')[0],
        orgId,
        role,
        grants: data.grants ?? [],
        denies: data.denies ?? [],
        status,
        demo: false,
        signedInAtMs: now()
    };
    if (status === 'suspended') return { ...session, suspended: true };
    return session;
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
let idleStarted = false;

export function startIdleWatch() {
    // Switching orgs calls this again. Listeners are attached once; the timer
    // is simply restarted from the new org's timeout.
    if (idleStarted) {
        resetIdle();
        return;
    }
    idleStarted = true;

    const reset = resetIdle;

    // `passive` avoids blocking scroll, and pointer/key/scroll together cover
    // every way a person can be present without being noisy about it.
    for (const event of ['pointerdown', 'keydown', 'scroll', 'focus']) {
        window.addEventListener(event, reset, { passive: true });
    }
    reset();
}

function resetIdle() {
    // Nobody to time out once signed out; the window listeners outlive sign-out.
    if (!state.session) return;
    const timeoutMs = Number(state.org?.idleTimeoutMs) || DEFAULT_SETTINGS.idleTimeoutMs;
    const warnAtMs = Math.max(30000, timeoutMs - 60000);
    clearTimeout(idleTimer);
    clearTimeout(warnTimer);

    warnTimer = setTimeout(async () => {
        const stay = await confirmDialog({
            title: 'Still there?',
            body: 'You will be signed out in about a minute for security. Anything you have already saved is safe.',
            confirmLabel: 'Keep me signed in',
            cancelLabel: 'Sign out now'
        });
        if (stay) resetIdle();
        else signOutNow();
    }, warnAtMs);

    idleTimer = setTimeout(() => {
        toast('Signed out after a period of inactivity.', 'warn', 8000);
        signOutNow();
    }, timeoutMs);
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
