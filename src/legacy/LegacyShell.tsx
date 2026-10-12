import { useEffect, useRef } from 'react';
import { bootUi, renderCurrentView } from '../ui/app.js';
import type { useAuthRouter } from '../auth/useAuthRouter.js';

type Router = ReturnType<typeof useAuthRouter>;

let uiBooted = false;

/**
 * The dashboard shell, unported. Same markup and ids the old static
 * `index.html` had, so `bootUi()` - every view, action and keyboard
 * shortcut in `src/ui/` - runs completely unchanged. React only owns the
 * auth gate and the org switcher for now; see docs/react-migration.md for
 * the plan to bring each view in `src/ui/views/` across one at a time.
 */
export function LegacyShell({ router }: { router: Router }) {
    const selectRef = useRef<HTMLSelectElement>(null);

    useEffect(() => {
        if (uiBooted) {
            renderCurrentView();
            return;
        }
        uiBooted = true;
        bootUi();
    }, []);

    useEffect(() => {
        if (selectRef.current && router.activeOrgId) selectRef.current.value = router.activeOrgId;
    }, [router.activeOrgId]);

    const showSwitcher = router.memberships.length > 0;

    return (
        <div id="app-container" className="flex h-full overflow-hidden">
            <aside id="sidebar" className="bg-slate-900 text-white w-64 flex-shrink-0 transition-transform transform -translate-x-full fixed inset-y-0 left-0 z-40 md:relative md:translate-x-0 flex flex-col">
                <div className="p-5 border-b border-slate-800 flex justify-between items-center">
                    <div>
                        <p className="text-xl font-bold tracking-tight">Trea</p>
                        <p className="text-[11px] text-slate-400">Treasury control</p>
                    </div>
                    <button id="close-sidebar-btn" className="md:hidden text-slate-400 hover:text-white text-2xl leading-none" aria-label="Close menu">&times;</button>
                </div>

                <nav id="sidebar-nav" className="p-3 space-y-1 flex-1 overflow-y-auto" aria-label="Sections" />

                <div className="p-3 border-t border-slate-800 space-y-2">
                    <div className="px-3 py-2 rounded-lg bg-slate-800/60">
                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Total balance</p>
                        <p id="header-balance" className="text-lg font-bold tabular-nums">-</p>
                    </div>
                    <button data-action="palette" className="w-full text-left px-3 py-2 rounded-lg text-xs text-slate-400 hover:bg-slate-800 flex justify-between">
                        <span>Command palette</span><kbd className="font-mono">Ctrl K</kbd>
                    </button>
                    <button data-action="theme:cycle" className="w-full text-left px-3 py-2 rounded-lg text-xs text-slate-400 hover:bg-slate-800">Toggle theme</button>
                    <button id="demo-reset-btn" data-action="demo:reset" className="hidden w-full text-left px-3 py-2 rounded-lg text-xs text-amber-300 hover:bg-slate-800">Reset demo data</button>
                </div>
            </aside>

            <main className="flex-1 flex flex-col h-full overflow-hidden">
                <header className="bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 px-4 py-3 flex items-center justify-between gap-3 z-30 shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                        <button id="hamburger-btn" className="md:hidden text-slate-600 dark:text-slate-300" aria-label="Open menu">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
                        </button>
                        <div id="welcome-msg" className="text-sm truncate">Welcome</div>
                    </div>
                    <div className="flex gap-2 shrink-0 items-center">
                        {showSwitcher && (
                            <select
                                ref={selectRef}
                                aria-label="Switch organisation"
                                className="max-w-[10rem] text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5"
                                defaultValue={router.activeOrgId ?? ''}
                                onChange={(e) => router.switchOrg(e.target.value)}
                            >
                                {router.memberships.map((m) => (
                                    <option key={m.orgId} value={m.orgId}>{m.name}</option>
                                ))}
                                <option value={router.NEW_ORG_VALUE}>+ Join or create</option>
                            </select>
                        )}
                        <button data-action="export:workbook" data-perm="data.export" className="bg-emerald-600 text-white px-3 py-1.5 rounded-lg shadow-sm hover:bg-emerald-700 text-xs font-semibold">Export</button>
                        <button data-action="signout" className="bg-slate-600 text-white px-3 py-1.5 rounded-lg shadow-sm hover:bg-slate-700 text-xs font-semibold">Sign out</button>
                    </div>
                </header>

                <div id="view-root" className="flex-1 overflow-y-auto p-4 md:p-6" />
            </main>
        </div>
    );
}
