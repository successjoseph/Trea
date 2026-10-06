/**
 * Entry point.
 *
 * Responsible for four things: signing the visitor in or up, deciding which
 * organisation they are working in (and letting them switch), starting the data
 * listeners for that org, and handing control to the UI. Everything else lives
 * in `src/`.
 */
import { state, setSession } from './src/core/state.js';
import { $, show } from './src/core/dom.js';
import { EVENTS, on } from './src/core/bus.js';
import { db, doc, getDoc, paths } from './src/core/fb.js';
import { monthKey } from './src/core/time.js';
import {
    watchAuth, resolveAccess, signInWithGoogle, signInWithEmail, signUpWithEmail,
    resendVerification, reloadUser, sendPasswordReset, startDemoSession,
    configureAuthPersistence, startIdleWatch, applyOrgSettings, signOutNow
} from './src/features/session.js';
import { ensureProfile, listMemberships, createOrg, joinWithPasscode } from './src/features/join.js';
import { ValidationError } from './src/data/transactions.js';
import { subscribeAll, stopAllListeners } from './src/data/live.js';
import { backfillOnOpen } from './src/features/snapshots.js';
import { runDueRecurring } from './src/features/records.js';
import { recomputeTotals, refreshAlerts } from './src/features/analytics.js';
import { bootUi, renderCurrentView } from './src/ui/app.js';
import { toast, err, info, ok } from './src/ui/toast.js';

let uiStarted = false;
let routeToken = 0;
let pendingName = null;
let authMode = 'signin';

const LAST_ORG_KEY = (uid) => `trea:lastOrg:${uid}`;

function startUi() {
    if (uiStarted) return;
    uiStarted = true;
    bootUi();
}

function enterApp() {
    document.getElementById('auth-guard').style.display = 'none';
    show('#app-container', true);
    startUi();
    renderCurrentView();
}

const GATE_PANELS = ['loading', 'signin', 'verify', 'onboard'];

function showGate(panel, { rejected = null, verifyEmail = '' } = {}) {
    document.getElementById('auth-guard').style.display = 'flex';
    show('#app-container', false);
    for (const name of GATE_PANELS) show('#auth-' + name, name === panel);
    const rejectedNode = $('#rejected-text');
    show(rejectedNode, Boolean(rejected));
    if (rejected) rejectedNode.textContent = rejected;
    if (verifyEmail) $('#verify-email').textContent = verifyEmail;
}

function setOnboardError(message) {
    const node = $('#onboard-error');
    show(node, Boolean(message));
    if (message) node.textContent = message;
}

const AUTH_MESSAGES = {
    'auth/invalid-credential': 'That email and password do not match.',
    'auth/invalid-login-credentials': 'That email and password do not match.',
    'auth/invalid-email': 'That is not a valid email address.',
    'auth/email-already-in-use': 'An account already exists for that email. Sign in instead.',
    'auth/weak-password': 'Use at least 10 characters for your password.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/network-request-failed': 'No connection. Check your network and try again.',
    'auth/user-disabled': 'This account has been disabled.'
};

function authMessage(error) {
    return AUTH_MESSAGES[error?.code] ?? 'Something went wrong. Please try again.';
}

/* ----------------------------------------------------------- Org handling */

function rememberOrg(uid, orgId) {
    try { localStorage.setItem(LAST_ORG_KEY(uid), orgId); } catch { /* storage blocked */ }
}

function rememberedOrg(uid) {
    try { return localStorage.getItem(LAST_ORG_KEY(uid)); } catch { return null; }
}

/** Clear the previous org's data before the next one loads, so nothing leaks across. */
function resetOrgState() {
    for (const key of ['transactions', 'members', 'snapshots', 'auditLogs', 'roles', 'passcodes', 'budgets', 'goals', 'recurring', 'reconciliations']) {
        state[key] = [];
    }
}

/**
 * Make `orgId` the active org: resolve the role there, load settings, start the
 * listeners and render. Returns a reason string when the org cannot be entered.
 */
async function enterOrg(orgId) {
    const user = window.__treaUser;
    if (!user) return 'signed-out';

    const session = await resolveAccess(user, orgId);
    if (!session) return 'no-access';
    if (session.suspended) return 'suspended';

    resetOrgState();
    try {
        const settings = await getDoc(doc(db, paths.settings(orgId)));
        applyOrgSettings(settings.exists() ? settings.data() : {});
    } catch {
        applyOrgSettings({});
    }

    setSession(session);
    subscribeAll(orgId);
    startIdleWatch();
    rememberOrg(user.uid, orgId);
    syncSwitcher(orgId);
    enterApp();

    // Deferred until the first snapshot of this org's data has arrived: both
    // operations read from `state`, and running them early would decide,
    // wrongly, that there is nothing to seal.
    const once = on(EVENTS.TX_CHANGED, async () => {
        once();
        const sealed = await backfillOnOpen();
        if (sealed.length) {
            toast(`Sealed ${sealed.length} closed month${sealed.length === 1 ? '' : 's'} that had been left open.`, 'info', 7000);
        }
        const created = await runDueRecurring();
        if (created.length) {
            toast(`${created.length} recurring entr${created.length === 1 ? 'y' : 'ies'} recorded for ${monthKey()}.`, 'info', 7000);
        }
    });
    return null;
}

let switcherRows = [];

function syncSwitcher(activeOrgId) {
    const select = $('#org-switcher');
    if (!select) return;
    select.value = activeOrgId;
}

const NEW_ORG_VALUE = '__new__';

function populateSwitcher(memberships) {
    const select = $('#org-switcher');
    if (!select) return;
    switcherRows = memberships;
    select.innerHTML = [
        ...memberships.map((m) => `<option value="${escapeText(m.orgId)}">${escapeText(m.name)}</option>`),
        `<option value="${NEW_ORG_VALUE}">+ Join or create</option>`
    ].join('');
    select.classList.remove('hidden');
}

function showOnboard({ canGoBack }) {
    showGate('onboard');
    show('#onboard-back', canGoBack);
}

function escapeText(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

$('#org-switcher')?.addEventListener('change', async (event) => {
    const orgId = event.target.value;
    if (orgId === NEW_ORG_VALUE) {
        syncSwitcher(state.session?.orgId ?? '');
        showOnboard({ canGoBack: Boolean(state.session) });
        return;
    }
    const reason = await enterOrg(orgId);
    if (reason) {
        err(reason === 'suspended'
            ? 'Your access to that organisation is suspended.'
            : 'You no longer have access to that organisation.');
        await route(window.__treaUser);
    }
});

/* ------------------------------------------------------------- Routing */

/**
 * Decide where a signed-in user goes. Called on every auth change and after
 * every join, create or verify, so the answer is always the current one.
 */
async function route(user) {
    const token = ++routeToken;
    window.__treaUser = user ?? null;

    if (!user) {
        stopAllListeners();
        setSession(null);
        showGate('signin');
        return;
    }
    if (!user.emailVerified) {
        showGate('verify', { verifyEmail: user.email ?? '' });
        return;
    }

    showGate('loading');
    try {
        await ensureProfile(user, pendingName);
        const memberships = await listMemberships(user);
        if (token !== routeToken) return;

        if (memberships.length === 0) {
            showOnboard({ canGoBack: false });
            return;
        }
        populateSwitcher(memberships);

        const remembered = rememberedOrg(user.uid);
        const target = memberships.find((m) => m.orgId === remembered) ?? memberships[0];
        const reason = await enterOrg(target.orgId);
        if (token !== routeToken) return;

        if (reason === 'no-access' || reason === 'suspended') {
            // The membership exists but the role does not (revoked, or suspended).
            // Try the other orgs before giving up.
            for (const other of memberships.filter((m) => m.orgId !== target.orgId)) {
                if (!(await enterOrg(other.orgId))) return;
            }
            showOnboard({ canGoBack: false });
            setOnboardError(reason === 'suspended'
                ? 'Your access is suspended. Contact an owner of your organisation.'
                : 'Your access to your organisation has been removed. Join with a new passcode, or create one.');
        }
    } catch (error) {
        console.error('[auth] could not resolve access', error);
        showGate('signin', { rejected: 'Could not reach the database. Check your connection and reload.' });
    }
}

/* ------------------------------------------------------- Sign-in screen */

function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === 'signup';
    show('#signin-name', signup);
    $('#signin-title').textContent = signup ? 'Create an account' : 'Sign in';
    $('#signin-submit').textContent = signup ? 'Create account' : 'Sign in';
    $('#signin-password').autocomplete = signup ? 'new-password' : 'current-password';
    $('#toggle-mode').textContent = signup ? 'I already have an account' : 'Create an account';
}

$('#toggle-mode')?.addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));

$('#signin-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = $('#signin-email').value.trim();
    const password = $('#signin-password').value;
    if (!email || !password) return err('Enter your email and password.');

    try {
        if (authMode === 'signup') {
            const name = $('#signin-name').value.trim();
            if (!name) return err('Enter your name.');
            if (password.length < 10) return err('Use at least 10 characters for your password.');
            pendingName = name;
            await signUpWithEmail(email, password);
            info('Account created. We sent a verification link to your email.');
        } else {
            await signInWithEmail(email, password);
        }
    } catch (error) {
        err(authMessage(error));
    }
});

$('#login-btn')?.addEventListener('click', async () => {
    try {
        await signInWithGoogle();
    } catch (error) {
        if (error?.code !== 'auth/popup-closed-by-user' && error?.code !== 'auth/cancelled-popup-request') {
            console.error('[auth] sign-in failed', error);
            err('Sign-in did not complete.');
        }
    }
});

$('#forgot-btn')?.addEventListener('click', async () => {
    const email = $('#signin-email').value.trim();
    if (!email) return err('Type your email above first, then click Forgot password.');
    try {
        await sendPasswordReset(email);
    } catch (error) {
        if (error?.code !== 'auth/user-not-found') console.warn('[auth] reset', error?.code);
    }
    // Same message whether or not the account exists, so this reveals nothing.
    ok('If an account exists for that email, a reset link is on its way.');
});

$('#demo-btn')?.addEventListener('click', async () => {
    startDemoSession();
    recomputeTotals();
    refreshAlerts();
    enterApp();
    info('Demo sandbox - everything stays in this browser and nothing is sent anywhere.');

    // The seeded year spans months that were never sealed, so the backfill has
    // real work to do here - which is also the clearest way to show what it does.
    const sealed = await backfillOnOpen();
    if (sealed.length) {
        toast(`Sealed ${sealed.length} closed months automatically on open.`, 'info', 6000);
        recomputeTotals();
        refreshAlerts();
        renderCurrentView();
    }
});

/* ------------------------------------------------------ Verify screen */

$('#verify-check')?.addEventListener('click', async () => {
    const user = window.__treaUser;
    if (!user) return;
    try {
        await reloadUser(user);
        if (user.emailVerified) await route(user);
        else err('Not verified yet. Open the link in your email, then try again.');
    } catch (error) {
        err(authMessage(error));
    }
});

$('#verify-resend')?.addEventListener('click', async () => {
    const user = window.__treaUser;
    if (!user) return;
    try {
        await resendVerification(user);
        ok('A new verification link is on its way.');
    } catch (error) {
        err(authMessage(error));
    }
});

$('#verify-signout')?.addEventListener('click', () => signOutNow());
$('#onboard-signout')?.addEventListener('click', () => signOutNow());

/* ----------------------------------------------------- Onboarding */

async function afterJoin(orgId) {
    ok('You are in. Welcome.');
    // Remember the new org so route() opens it, not the previous one.
    rememberOrg(window.__treaUser.uid, orgId);
    await route(window.__treaUser);
    return orgId;
}

$('#onboard-back')?.addEventListener('click', () => {
    setOnboardError('');
    if (state.session?.orgId) {
        enterOrg(state.session.orgId).then((reason) => reason && route(window.__treaUser));
    } else {
        route(window.__treaUser);
    }
});

$('#join-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    setOnboardError('');
    const code = $('#join-code').value;
    try {
        const orgId = await joinWithPasscode(code, pendingName);
        $('#join-code').value = '';
        await afterJoin(orgId);
    } catch (error) {
        setOnboardError(error instanceof ValidationError ? error.message : 'Could not join. Check the code and try again.');
        if (!(error instanceof ValidationError)) console.error('[join]', error);
    }
});

$('#create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    setOnboardError('');
    const name = $('#create-name').value;
    const type = $('#create-type').value;
    try {
        const orgId = await createOrg({ name, type, displayName: pendingName });
        await afterJoin(orgId);
    } catch (error) {
        setOnboardError(error instanceof ValidationError ? error.message : 'Could not create the organisation. Try again.');
        if (!(error instanceof ValidationError)) console.error('[create-org]', error);
    }
});

/* ------------------------------------------------------------- Session */

setAuthMode('signin');
await configureAuthPersistence();

watchAuth((user) => route(user));

/* --------------------------------------------------------- Offline / PWA */

if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // Registered only over HTTPS: a service worker on a plain-http origin is
    // either refused or, worse, cached from an origin an attacker can occupy.
    navigator.serviceWorker.register('./sw.js').catch((error) => {
        console.info('[pwa] service worker not registered', error?.message);
    });
}

window.addEventListener('online', () => toast('Back online - syncing.', 'success'));
window.addEventListener('offline', () => toast('Offline. You can keep reading; changes will sync when you reconnect.', 'warn', 6000));

// Surface the ledger state for debugging without exposing any write path.
Object.defineProperty(window, 'treaState', { get: () => structuredClone({ totals: state.totals, view: state.ui.view }) });
