/**
 * Entry point.
 *
 * Responsible for exactly three things: deciding whether the visitor gets in,
 * starting the data listeners for their org, and handing control to the UI.
 * Everything else lives in `src/`.
 */
import { state, setSession } from './src/core/state.js';
import { $, show } from './src/core/dom.js';
import { EVENTS, on } from './src/core/bus.js';
import { db, doc, getDoc, paths } from './src/core/fb.js';
import { monthKey } from './src/core/time.js';
import {
    watchAuth, resolveAccess, signInWithGoogle, startDemoSession,
    configureAuthPersistence, startIdleWatch, applyOrgSettings
} from './src/features/session.js';
import { subscribeAll, stopAllListeners } from './src/data/live.js';
import { backfillOnOpen } from './src/features/snapshots.js';
import { runDueRecurring } from './src/features/records.js';
import { recomputeTotals, refreshAlerts } from './src/features/analytics.js';
import { bootUi, renderCurrentView } from './src/ui/app.js';
import { toast, err, info } from './src/ui/toast.js';

let uiStarted = false;

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

function showGate({ loading = false, rejected = null } = {}) {
    document.getElementById('auth-guard').style.display = 'flex';
    show('#app-container', false);
    show('#loading-text', loading);
    show('#login-btn', !loading);
    const rejectedNode = $('#rejected-text');
    show(rejectedNode, Boolean(rejected));
    if (rejected) rejectedNode.textContent = rejected;
}

/* ----------------------------------------------------------------- Demo */

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

/* ----------------------------------------------------------------- Auth */

$('#login-btn')?.addEventListener('click', async () => {
    try {
        show('#login-btn', false);
        show('#loading-text', true);
        await signInWithGoogle();
    } catch (error) {
        show('#loading-text', false);
        show('#login-btn', true);
        if (error?.code !== 'auth/popup-closed-by-user' && error?.code !== 'auth/cancelled-popup-request') {
            console.error('[auth] sign-in failed', error);
            err('Sign-in did not complete.');
        }
    }
});

$('#signout-btn')?.addEventListener('click', () => {
    document.querySelector('[data-action="signout"]')?.click();
});

await configureAuthPersistence();

watchAuth(async (user) => {
    if (!user) {
        stopAllListeners();
        setSession(null);
        showGate({ loading: false });
        return;
    }

    showGate({ loading: true });

    try {
        const session = await resolveAccess(user);

        if (!session) {
            showGate({
                loading: false,
                rejected: 'This account has no access to any organisation. Ask an owner to grant it.'
            });
            return;
        }
        if (session.suspended) {
            showGate({
                loading: false,
                rejected: 'Your access has been suspended. Contact an owner of your organisation.'
            });
            return;
        }

        // Load org settings before the first render so currency, the correction
        // window and the idle timeout are right from the very first paint.
        try {
            const settings = await getDoc(doc(db, paths.settings(session.orgId)));
            applyOrgSettings(settings.exists() ? settings.data() : {});
        } catch {
            applyOrgSettings({});
        }

        setSession(session);
        subscribeAll(session.orgId);
        startIdleWatch();
        enterApp();

        // Deferred until the first snapshot of data has arrived - both of these
        // read from `state`, and running them against an empty store would
        // decide, wrongly, that there is nothing to seal.
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
    } catch (error) {
        console.error('[auth] could not resolve access', error);
        showGate({
            loading: false,
            rejected: 'Could not reach the database. Check your connection and reload.'
        });
    }
});

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
