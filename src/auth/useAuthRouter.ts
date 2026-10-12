/**
 * The session state machine, as a hook instead of DOM panel-toggling.
 *
 * This replaces the routing half of the old root `app.js` (still in git
 * history on `main` before this migration - see docs/react-migration.md).
 * The dashboard itself is not ported yet: once `gate` reaches 'app', <LegacyShell>
 * takes over and calls the existing `bootUi()`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { db, doc, getDoc, paths } from '../core/fb.js';
import { state as legacyState, setSession } from '../core/state.js';
import {
    watchAuth, resolveAccess, signInWithGoogle, signInWithEmail, signUpWithEmail,
    resendVerification, reloadUser, sendPasswordReset, startDemoSession,
    configureAuthPersistence, startIdleWatch, applyOrgSettings, signOutNow
} from '../features/session.js';
import { ensureProfile, listMemberships, createOrg, joinWithPasscode } from '../features/join.js';
import { subscribeAll, stopAllListeners } from '../data/live.js';
import { ValidationError } from '../data/transactions.js';
import { on } from '../core/bus.js';
import { backfillOnOpen } from '../features/snapshots.js';
import { runDueRecurring } from '../features/records.js';
import { recomputeTotals, refreshAlerts } from '../features/analytics.js';
import { monthKey } from '../core/time.js';
import { toast, err as toastErr, info, ok } from '../ui/toast.js';

export type GateState = 'loading' | 'signin' | 'verify' | 'onboard' | 'app';

export interface Membership {
    orgId: string;
    name: string;
    [key: string]: unknown;
}

const NEW_ORG_VALUE = '__new__';
const LAST_ORG_KEY = (uid: string) => `trea:lastOrg:${uid}`;

function rememberOrg(uid: string, orgId: string) {
    try { localStorage.setItem(LAST_ORG_KEY(uid), orgId); } catch { /* storage blocked */ }
}
function rememberedOrg(uid: string): string | null {
    try { return localStorage.getItem(LAST_ORG_KEY(uid)); } catch { return null; }
}

const AUTH_MESSAGES: Record<string, string> = {
    'auth/invalid-credential': 'That email and password do not match.',
    'auth/invalid-login-credentials': 'That email and password do not match.',
    'auth/invalid-email': 'That is not a valid email address.',
    'auth/email-already-in-use': 'An account already exists for that email. Sign in instead.',
    'auth/weak-password': 'Use at least 10 characters for your password.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/network-request-failed': 'No connection. Check your network and try again.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/admin-restricted-operation': 'New sign-ups are turned off for this app. Sign in with an account that already exists, or ask an owner for a passcode.',
    'auth/operation-not-allowed': 'Google sign-in is not turned on for this app yet. Use email and password instead.',
    'auth/account-exists-with-different-credential': 'That email already has an account with a password. Sign in with email and password.',
    'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups for this site and try again.'
};

function authMessage(error: unknown): string {
    const code = (error as { code?: string } | null)?.code;
    return (code && AUTH_MESSAGES[code]) ?? 'Something went wrong. Please try again.';
}

export function useAuthRouter() {
    const [gate, setGate] = useState<GateState>('loading');
    const [user, setUser] = useState<any>(null);
    const [memberships, setMemberships] = useState<Membership[]>([]);
    const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
    const [rejected, setRejected] = useState('');
    const [onboardError, setOnboardError] = useState('');
    const [onboardCanGoBack, setOnboardCanGoBack] = useState(false);
    const [busy, setBusy] = useState(false);

    const pendingName = useRef<string | null>(null);
    const routeToken = useRef(0);

    const resetOrgState = useCallback(() => {
        for (const key of ['transactions', 'members', 'snapshots', 'auditLogs', 'roles', 'passcodes', 'budgets', 'goals', 'recurring', 'reconciliations']) {
            (legacyState as any)[key] = [];
        }
    }, []);

    /** Enter one org: resolve the role, load settings, start listeners. */
    const enterOrg = useCallback(async (orgId: string): Promise<'no-access' | 'suspended' | null> => {
        if (!user) return 'no-access';
        const session = await resolveAccess(user, orgId);
        if (!session) return 'no-access';
        if ((session as any).suspended) return 'suspended';

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
        setActiveOrgId(orgId);
        setGate('app');

        const once = on('tx:changed', async () => {
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
    }, [user, resetOrgState]);

    const route = useCallback(async (nextUser: any) => {
        const token = ++routeToken.current;
        setUser(nextUser);

        if (!nextUser) {
            stopAllListeners();
            setSession(null);
            setActiveOrgId(null);
            setGate('signin');
            return;
        }
        if (!nextUser.emailVerified) {
            setGate('verify');
            return;
        }

        setGate('loading');
        try {
            await ensureProfile(nextUser, pendingName.current);
            const rows = await listMemberships(nextUser);
            if (token !== routeToken.current) return;

            if (rows.length === 0) {
                setMemberships([]);
                setOnboardCanGoBack(false);
                setGate('onboard');
                return;
            }
            setMemberships(rows as Membership[]);

            const remembered = rememberedOrg(nextUser.uid);
            const target = rows.find((m: Membership) => m.orgId === remembered) ?? rows[0];
            // enterOrg reads `user` from closure state, which React hasn't committed
            // yet this tick - resolve access directly against nextUser instead.
            const resolveFor = async (orgId: string) => {
                const session = await resolveAccess(nextUser, orgId);
                if (!session) return 'no-access' as const;
                if ((session as any).suspended) return 'suspended' as const;
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
                rememberOrg(nextUser.uid, orgId);
                setActiveOrgId(orgId);
                setGate('app');
                return null;
            };

            const reason = await resolveFor(target.orgId);
            if (token !== routeToken.current) return;

            if (reason) {
                let entered = false;
                for (const other of rows.filter((m: Membership) => m.orgId !== target.orgId)) {
                    if (!(await resolveFor(other.orgId))) { entered = true; break; }
                }
                if (!entered) {
                    setOnboardCanGoBack(false);
                    setGate('onboard');
                    setOnboardError(reason === 'suspended'
                        ? 'Your access is suspended. Contact an owner of your organisation.'
                        : 'Your access to your organisation has been removed. Join with a new passcode, or create one.');
                }
            }
        } catch (error) {
            console.error('[auth] could not resolve access', error);
            setGate('signin');
            setRejected('Could not reach the database. Check your connection and reload.');
        }
    }, [resetOrgState]);

    useEffect(() => {
        let unsub: (() => void) | undefined;
        configureAuthPersistence().then(() => {
            unsub = watchAuth((u: any) => route(u));
        });
        return () => unsub?.();
        // route is stable across the component's life (useCallback deps are stable refs)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const withBusy = useCallback(async (fn: () => Promise<void>) => {
        setBusy(true);
        try { await fn(); } finally { setBusy(false); }
    }, []);

    const signIn = useCallback((email: string, password: string) => withBusy(async () => {
        try { await signInWithEmail(email, password); }
        catch (error) { toastErr(authMessage(error)); }
    }), [withBusy]);

    const signUp = useCallback((email: string, password: string, name: string) => withBusy(async () => {
        if (password.length < 10) { toastErr('Use at least 10 characters for your password.'); return; }
        pendingName.current = name;
        try {
            await signUpWithEmail(email, password);
            info('Account created. We sent a verification link to your email.');
        } catch (error) { toastErr(authMessage(error)); }
    }), [withBusy]);

    const signInGoogle = useCallback(() => withBusy(async () => {
        try { await signInWithGoogle(); }
        catch (error: any) {
            if (error?.code !== 'auth/popup-closed-by-user' && error?.code !== 'auth/cancelled-popup-request') {
                console.error('[auth] sign-in failed', error);
                toastErr(authMessage(error));
            }
        }
    }), [withBusy]);

    const forgotPassword = useCallback((email: string) => withBusy(async () => {
        if (!email) { toastErr('Type your email above first, then click Forgot password.'); return; }
        try { await sendPasswordReset(email); }
        catch (error: any) { if (error?.code !== 'auth/user-not-found') console.warn('[auth] reset', error?.code); }
        ok('If an account exists for that email, a reset link is on its way.');
    }), [withBusy]);

    const checkVerified = useCallback(() => withBusy(async () => {
        if (!user) return;
        try {
            await reloadUser(user);
            if (user.emailVerified) await route(user);
            else toastErr('Not verified yet. Open the link in your email, then try again.');
        } catch (error) { toastErr(authMessage(error)); }
    }), [user, route, withBusy]);

    const resendVerify = useCallback(() => withBusy(async () => {
        if (!user) return;
        try { await resendVerification(user); ok('A new verification link is on its way.'); }
        catch (error) { toastErr(authMessage(error)); }
    }), [user, withBusy]);

    const signOut = useCallback(() => signOutNow(), []);

    const joinCode = useCallback((code: string) => withBusy(async () => {
        setOnboardError('');
        try {
            const orgId = await joinWithPasscode(code, pendingName.current);
            ok('You are in. Welcome.');
            rememberOrg(user.uid, orgId);
            await route(user);
        } catch (error: any) {
            setOnboardError(error instanceof ValidationError ? error.message : 'Could not join. Check the code and try again.');
            if (!(error instanceof ValidationError)) console.error('[join]', error);
        }
    }), [user, route, withBusy]);

    const createOrgSubmit = useCallback((name: string, type: string) => withBusy(async () => {
        setOnboardError('');
        try {
            const orgId = await createOrg({ name, type, displayName: pendingName.current });
            ok('You are in. Welcome.');
            rememberOrg(user.uid, orgId);
            await route(user);
        } catch (error: any) {
            setOnboardError(error instanceof ValidationError ? error.message : 'Could not create the organisation. Try again.');
            if (!(error instanceof ValidationError)) console.error('[create-org]', error);
        }
    }), [user, route, withBusy]);

    const startDemo = useCallback(() => withBusy(async () => {
        startDemoSession();
        recomputeTotals();
        refreshAlerts();
        setGate('app');
        info('Demo sandbox - everything stays in this browser and nothing is sent anywhere.');
        const sealed = await backfillOnOpen();
        if (sealed.length) {
            toast(`Sealed ${sealed.length} closed months automatically on open.`, 'info', 6000);
            recomputeTotals();
            refreshAlerts();
        }
    }), [withBusy]);

    const switchOrg = useCallback((orgId: string) => withBusy(async () => {
        if (orgId === NEW_ORG_VALUE) {
            setOnboardCanGoBack(Boolean(activeOrgId));
            setOnboardError('');
            setGate('onboard');
            return;
        }
        const reason = await enterOrg(orgId);
        if (reason) {
            toastErr(reason === 'suspended'
                ? 'Your access to that organisation is suspended.'
                : 'You no longer have access to that organisation.');
            await route(user);
        }
    }), [enterOrg, route, user, activeOrgId, withBusy]);

    const backToOrg = useCallback(() => withBusy(async () => {
        setOnboardError('');
        if (activeOrgId) {
            const reason = await enterOrg(activeOrgId);
            if (reason) await route(user);
        } else {
            await route(user);
        }
    }), [activeOrgId, enterOrg, route, user, withBusy]);

    return {
        gate, user, memberships, activeOrgId, rejected, onboardError, onboardCanGoBack, busy,
        NEW_ORG_VALUE,
        signIn, signUp, signInGoogle, forgotPassword, checkVerified, resendVerify, signOut,
        joinCode, createOrgSubmit, startDemo, switchOrg, backToOrg
    };
}
