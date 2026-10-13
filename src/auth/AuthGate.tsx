import { forwardRef, useRef, useState } from 'react';
import type { FormEvent, InputHTMLAttributes } from 'react';
import type { useAuthRouter } from './useAuthRouter.js';

type Router = ReturnType<typeof useAuthRouter>;

/**
 * The sign-in / verify / onboard screens. One component, four modes, matching
 * the four panels the old static `index.html` toggled with `hidden`.
 */
export function AuthGate({ router }: { router: Router }) {
    return (
        <div
            id="auth-guard"
            className="h-full flex flex-col items-center justify-center z-50 fixed inset-0 bg-cover bg-center px-4 overflow-y-auto"
            style={{
                backgroundImage:
                    "linear-gradient(rgba(15, 23, 42, 0.88), rgba(15, 23, 42, 0.92)), url('/image.png')"
            }}
        >
            <h1 className="text-6xl md:text-7xl font-extrabold tracking-tighter mb-2 drop-shadow-2xl">
                <span className="text-blue-500">T</span>
                <span className="text-white">R</span>
                <span className="text-red-500">E</span>
                <span className="text-green-500">A</span>
            </h1>
            <p className="text-slate-300 text-sm mb-6 text-center max-w-md">
                A treasury that seals its own months, holds every entry for a correction window,
                and never trusts the browser with permissions.
            </p>

            {router.gate === 'loading' && (
                <div className="text-lg font-semibold text-slate-200">
                    <span>Checking your access&hellip;</span>
                </div>
            )}
            {router.gate === 'signin' && <SignInPanel router={router} />}
            {router.gate === 'verify' && <VerifyPanel router={router} />}
            {router.gate === 'onboard' && <OnboardPanel router={router} />}

            {router.rejected && (
                <div className="mt-6 text-sm font-semibold text-rose-300 bg-rose-500/10 px-6 py-3 rounded-lg border border-rose-500/20 max-w-md text-center">
                    {router.rejected}
                </div>
            )}
        </div>
    );
}

const Field = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>((props, ref) => (
    <input
        {...props}
        ref={ref}
        className="w-full rounded-lg bg-slate-900/60 border border-white/15 text-white placeholder-slate-400 px-3 py-2 text-sm"
    />
));

function SignInPanel({ router }: { router: Router }) {
    const [mode, setMode] = useState<'signin' | 'signup'>('signin');
    const nameRef = useRef<HTMLInputElement>(null);
    const emailRef = useRef<HTMLInputElement>(null);
    const passwordRef = useRef<HTMLInputElement>(null);

    const submit = (e: FormEvent) => {
        e.preventDefault();
        const email = emailRef.current?.value.trim() ?? '';
        const password = passwordRef.current?.value ?? '';
        if (!email || !password) return;
        if (mode === 'signup') {
            router.signUp(email, password, nameRef.current?.value.trim() ?? '');
        } else {
            router.signIn(email, password);
        }
    };

    return (
        <div className="w-full max-w-sm bg-white/5 border border-white/10 rounded-xl p-6 backdrop-blur-md">
            <h2 className="text-white text-lg font-bold mb-4">{mode === 'signup' ? 'Create an account' : 'Sign in'}</h2>
            <form className="space-y-3" onSubmit={submit} noValidate>
                {mode === 'signup' && (
                    <Field ref={nameRef} type="text" autoComplete="name" maxLength={80} placeholder="Your name" />
                )}
                <Field ref={emailRef} type="email" autoComplete="email" required placeholder="Email address" />
                <Field
                    ref={passwordRef}
                    type="password"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    required
                    minLength={10}
                    placeholder="Password"
                />
                <button
                    type="submit"
                    disabled={router.busy}
                    className="w-full bg-blue-600 text-white px-4 py-2.5 rounded-lg font-bold hover:bg-blue-700 transition disabled:opacity-60"
                >
                    {mode === 'signup' ? 'Create account' : 'Sign in'}
                </button>
            </form>
            <div className="flex justify-between text-xs mt-3">
                <button type="button" className="text-blue-300 hover:text-white" onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')}>
                    {mode === 'signup' ? 'I already have an account' : 'Create an account'}
                </button>
                <button type="button" className="text-slate-300 hover:text-white" onClick={() => router.forgotPassword(emailRef.current?.value.trim() ?? '')}>
                    Forgot password?
                </button>
            </div>
            <div className="flex items-center gap-3 my-4 text-xs text-slate-400">
                <span className="flex-1 h-px bg-white/10" />or<span className="flex-1 h-px bg-white/10" />
            </div>
            <button
                type="button"
                disabled={router.busy}
                className="w-full bg-white text-slate-800 px-4 py-2.5 rounded-lg font-bold hover:bg-slate-100 transition disabled:opacity-60"
                onClick={() => router.signInGoogle()}
            >
                Continue with Google
            </button>
            <button
                type="button"
                className="w-full mt-2 bg-white/10 text-white border border-white/20 px-4 py-2.5 rounded-lg font-bold hover:bg-white/20 transition"
                onClick={() => router.startDemo()}
            >
                Try the demo
            </button>
            <p className="text-xs text-slate-400 mt-4 text-center">
                The demo runs entirely in your browser with sample data. Nothing is sent anywhere.
            </p>
        </div>
    );
}

function VerifyPanel({ router }: { router: Router }) {
    return (
        <div className="w-full max-w-sm bg-white/5 border border-white/10 rounded-xl p-6 backdrop-blur-md text-center">
            <h2 className="text-white text-lg font-bold mb-2">Verify your email</h2>
            <p className="text-slate-300 text-sm mb-1">We sent a link to</p>
            <p className="text-white font-semibold text-sm mb-4 break-all">{router.user?.email ?? ''}</p>
            <p className="text-slate-400 text-xs mb-5">Open the link, then come back here and continue.</p>
            <div className="space-y-2">
                <button
                    type="button"
                    disabled={router.busy}
                    className="w-full bg-blue-600 text-white px-4 py-2.5 rounded-lg font-bold hover:bg-blue-700 disabled:opacity-60"
                    onClick={() => router.checkVerified()}
                >
                    I have verified, continue
                </button>
                <button
                    type="button"
                    disabled={router.busy}
                    className="w-full bg-white/10 text-white border border-white/20 px-4 py-2 rounded-lg text-sm hover:bg-white/20 disabled:opacity-60"
                    onClick={() => router.resendVerify()}
                >
                    Send the link again
                </button>
                <button type="button" className="text-xs text-slate-300 hover:text-white" onClick={() => router.signOut()}>
                    Sign out
                </button>
            </div>
        </div>
    );
}

function OnboardPanel({ router }: { router: Router }) {
    const codeRef = useRef<HTMLInputElement>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const typeRef = useRef<HTMLSelectElement>(null);

    const submitJoin = (e: FormEvent) => {
        e.preventDefault();
        const code = codeRef.current?.value ?? '';
        if (!code) return;
        router.joinCode(code).then(() => { if (codeRef.current) codeRef.current.value = ''; });
    };

    const submitCreate = (e: FormEvent) => {
        e.preventDefault();
        router.createOrgSubmit(nameRef.current?.value ?? '', typeRef.current?.value ?? 'company');
    };

    return (
        <div className="w-full max-w-sm bg-white/5 border border-white/10 rounded-xl p-6 backdrop-blur-md">
            <h2 className="text-white text-lg font-bold mb-1">Join or create an organisation</h2>
            <p className="text-slate-400 text-xs mb-5">
                Enter a passcode from someone in an organisation, or start a new one.
            </p>
            {router.onboardCanGoBack && (
                <button type="button" className="block mb-4 text-xs text-blue-300 hover:text-white" onClick={() => router.backToOrg()}>
                    &larr; Back to my organisation
                </button>
            )}

            <form className="space-y-2 mb-6" onSubmit={submitJoin} noValidate>
                <p className="text-slate-200 text-sm font-semibold">I have a passcode</p>
                <input
                    ref={codeRef}
                    type="text"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    placeholder="XXXXX-XXXXX"
                    className="w-full rounded-lg bg-slate-900/60 border border-white/15 text-white placeholder-slate-500 px-3 py-2 font-mono tracking-widest uppercase text-center"
                />
                <button type="submit" disabled={router.busy} className="w-full bg-blue-600 text-white px-4 py-2.5 rounded-lg font-bold hover:bg-blue-700 disabled:opacity-60">
                    Join
                </button>
            </form>

            <form className="space-y-2" onSubmit={submitCreate} noValidate>
                <p className="text-slate-200 text-sm font-semibold">Create a new one</p>
                <input
                    ref={nameRef}
                    type="text"
                    maxLength={80}
                    placeholder="Name, e.g. Thrivers Trybe"
                    className="w-full rounded-lg bg-slate-900/60 border border-white/15 text-white placeholder-slate-500 px-3 py-2 text-sm"
                />
                <select ref={typeRef} className="w-full rounded-lg bg-slate-900/60 border border-white/15 text-white px-3 py-2 text-sm">
                    <option value="company">Company or group</option>
                    <option value="personal">Personal (just me)</option>
                </select>
                <button type="submit" disabled={router.busy} className="w-full bg-white/10 text-white border border-white/20 px-4 py-2.5 rounded-lg font-bold hover:bg-white/20 disabled:opacity-60">
                    Create
                </button>
            </form>

            {router.onboardError && <p className="mt-4 text-sm text-rose-300">{router.onboardError}</p>}
            <button type="button" className="block mx-auto mt-5 text-xs text-slate-300 hover:text-white" onClick={() => router.signOut()}>
                Sign out
            </button>
        </div>
    );
}
