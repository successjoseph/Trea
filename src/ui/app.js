/**
 * The application shell: routing, navigation, and every user action.
 *
 * All interaction is delegated from one listener on `[data-action]`, which is
 * why views can be re-rendered wholesale without leaking listeners and why no
 * generated markup ever needs an inline `onclick`.
 */
import { state } from '../core/state.js';
import { $, $$, mount, escapeHtml, onAction, initActionDelegation, debounce } from '../core/dom.js';
import { on, emit, EVENTS } from '../core/bus.js';
import { can, applyPermissionsToDom, basePermissions, ROLE_LABELS, PERMISSIONS, ROLES } from '../core/rbac.js';
import { fmt, toMajor } from '../core/money.js';
import { monthLabel, monthKey, dayKey } from '../core/time.js';

import { ok, err, warn, info, toast, confirmDialog, formDialog } from './toast.js';
import { initTheme, setPreference, cycleTheme } from './theme.js';
import { initShortcuts, registerCommand, openPalette } from './shortcuts.js';
import { badge, card, sectionHeader } from './components.js';

import {
    createTransaction, correctTransaction, discardPending, reverseTransaction,
    approveTransaction, ValidationError, DEFAULT_CATEGORIES
} from '../data/transactions.js';
import { verifyChain } from '../data/audit.js';
import { takeManualSnapshot } from '../features/snapshots.js';
import { initPendingRuntime } from '../features/pending.js';
import { addMember, updateMember, archiveMember, inviteUser, changeUserRole, setPermissionOverrides, suspendUser, revokeUser } from '../features/people.js';
import { saveBudget, deleteBudget, saveGoal, archiveGoal, saveRecurring, toggleRecurring, deleteRecurring, runDueRecurring, recordReconciliation, saveSettings } from '../features/records.js';
import { exportWorkbook, exportCsv, exportJson, exportMemberStatement } from '../features/exports.js';
import { parseCsv, validateRows, summarise, commitImport, downloadTemplate } from '../features/importer.js';
import { applyFilters, knownCategories, EMPTY_FILTERS } from '../features/search.js';
import { signOutNow, requireRecentAuth } from '../features/session.js';
import { resetDemo } from '../features/demo.js';
import { integrityReport, initDerivedState } from '../features/analytics.js';

import * as overview from './views/overview.js';
import * as ledgerView from './views/ledger.js';
import * as recordView from './views/record.js';
import * as membersView from './views/members.js';
import * as planningView from './views/planning.js';
import * as governanceView from './views/governance.js';
import * as accessView from './views/people.js';
import * as reportsView from './views/reports.js';
import * as settingsView from './views/settings.js';

const VIEWS = [
    { id: 'overview', label: 'Overview', key: 'o', module: overview },
    { id: 'record', label: 'Record', key: 'n', module: recordView, perm: 'tx.create' },
    { id: 'ledger', label: 'Ledger', key: 'l', module: ledgerView },
    { id: 'members', label: 'Members', key: 'm', module: membersView },
    { id: 'planning', label: 'Planning', key: 'p', module: planningView },
    { id: 'reports', label: 'Reports', key: 'r', module: reportsView },
    { id: 'governance', label: 'Governance', key: 'g', module: governanceView },
    { id: 'access', label: 'Access', key: 'a', module: accessView },
    { id: 'settings', label: 'Settings', key: 's', module: settingsView }
];

// Aliases so an alert can say `view: 'budgets'` without knowing the layout.
const VIEW_ALIASES = {
    budgets: 'planning', goals: 'planning', recurring: 'planning',
    approvals: 'governance', audit: 'governance', snapshots: 'reports',
    reconcile: 'reports', transactions: 'ledger'
};

let importCandidates = [];

/* ------------------------------------------------------------- Rendering */

/**
 * Render a view without touching browser history. Used both for the initial
 * page load and as the single handler for every `hashchange` - whether that
 * change came from a nav click, the back/forward buttons, or someone editing
 * the URL by hand. Keeping history changes and rendering in one place is what
 * makes the back button work: it never needs a second code path.
 */
function applyView(id) {
    const requested = VIEWS.find((v) => v.id === id) ?? VIEWS[0];
    if (requested.perm && !can(requested.perm)) {
        warn('You do not have access to that section.');
        // Fall back to whatever was already showing rather than a blank view,
        // and correct the URL to match so a later back/forward stays sane.
        const fallback = VIEWS.find((v) => v.id === state.ui.view) ?? VIEWS[0];
        if (location.hash !== '#' + fallback.id) location.hash = fallback.id;
        return fallback;
    }
    state.ui.view = requested.id;
    renderCurrentView();
    emit(EVENTS.VIEW_CHANGED, requested.id);
    if (window.innerWidth < 768) $('#sidebar')?.classList.add('-translate-x-full');
    return requested;
}

/**
 * Go to a view. Setting `location.hash` (rather than `history.replaceState`)
 * is what gives every navigation a real back-button entry - the browser
 * treats a hash assignment as an ordinary navigation, pushes a history entry
 * for it on its own, and fires `hashchange`, which `applyView` is listening
 * for. `navigate` itself never renders directly, so a click and pressing the
 * back button both end up going through the exact same path.
 */
export function navigate(target) {
    const id = VIEW_ALIASES[target] ?? target;
    if (location.hash === '#' + id) {
        // Already there (e.g. clicking the current nav item again) - no hash
        // change will fire, so render directly instead of doing nothing.
        applyView(id);
        return;
    }
    const requested = VIEWS.find((v) => v.id === id) ?? VIEWS[0];
    if (requested.perm && !can(requested.perm)) {
        warn('You do not have access to that section.');
        return;
    }
    location.hash = id;
}

export function renderCurrentView() {
    const view = VIEWS.find((v) => v.id === state.ui.view) ?? VIEWS[0];
    const root = $('#view-root');
    if (!root) return;
    root.innerHTML = view.module.render();
    root.scrollTop = 0;
    renderNav();
    renderHeader();
    applyPermissionsToDom(root);
}

function renderNav() {
    const nav = $('#sidebar-nav');
    if (!nav) return;
    nav.innerHTML = VIEWS
        .filter((v) => !v.perm || can(v.perm))
        .map((v) => `
            <button data-action="nav" data-target="${v.id}"
                class="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition flex items-center justify-between
                    ${state.ui.view === v.id ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'}">
                <span>${escapeHtml(v.label)}</span>
                <kbd class="text-[10px] opacity-50 font-mono">${v.key}</kbd>
            </button>`).join('');
}

function renderHeader() {
    const session = state.session;
    if (!session) return;

    const alertCount = state.alerts.filter((a) => a.level !== 'info').length;
    mount('#welcome-msg', '');
    const node = $('#welcome-msg');
    if (node) {
        node.innerHTML = `
            <span class="font-semibold">${escapeHtml(session.name)}</span>
            <span class="ml-2">${badge(ROLE_LABELS[session.role] ?? session.role, session.role === 'owner' ? 'danger' : 'info')}</span>
            ${session.demo ? badge('Demo sandbox', 'pending') : ''}
            ${alertCount ? badge(`${alertCount} alert${alertCount === 1 ? '' : 's'}`, 'danger') : ''}`;
    }

    const balance = $('#header-balance');
    if (balance) {
        balance.textContent = fmt(state.totals.balanceMinor);
        balance.title = state.totals.pendingCount
            ? `${fmt(state.totals.pendingMinor, { showSign: true })} pending release is not included`
            : 'All entries published';
    }
    $('#demo-reset-btn')?.classList.toggle('hidden', !session.demo);
}

/** Re-render only the pending strip, so a ticking countdown is cheap. */
function refreshPendingStrip() {
    const host = $('#pending-strip');
    if (!host) return;
    host.innerHTML = overview.renderPendingStrip();
    applyPermissionsToDom(host);
}

/* ---------------------------------------------------------------- Errors */

/** Domain errors are the user's problem to fix; anything else is ours. */
function handle(error) {
    if (error instanceof ValidationError) {
        warn(error.message);
        return;
    }
    if (error?.code === 'permission-denied') {
        err('The database rejected that. Your role does not permit it.');
        return;
    }
    console.error('[app]', error);
    err(error?.message ?? 'Something went wrong. Check the console for details.');
}

async function run(fn) {
    try {
        await fn();
    } catch (error) {
        handle(error);
    }
}

/* -------------------------------------------------------------- Actions */

function registerActions() {
    onAction('nav', ({ target }) => navigate(target));
    onAction('signout', () => run(async () => {
        if (state.session?.demo) return location.reload();
        const yes = await confirmDialog({ title: 'Sign out?', body: 'You can sign back in at any time.', confirmLabel: 'Sign out' });
        if (yes) await signOutNow();
    }));
    onAction('theme:set', ({ pref }) => { setPreference(pref); renderCurrentView(); });
    onAction('theme:cycle', () => { const next = cycleTheme(); info(`Theme: ${next}`); renderCurrentView(); });
    onAction('palette', () => openPalette());
    onAction('demo:reset', () => run(async () => {
        const yes = await confirmDialog({
            title: 'Reset the demo?', tone: 'danger',
            body: 'This wipes the sandbox in this browser and reseeds a year of sample data. Nothing outside this browser is touched.',
            confirmLabel: 'Reset'
        });
        if (!yes) return;
        resetDemo();
        ok('Demo reset.');
        renderCurrentView();
    }));

    /* --- transactions --- */
    onAction('tx:create', ({ type }, trigger) => run(async () => {
        trigger.disabled = true;
        try {
            const result = await createTransaction(recordView.readForm(type));
            recordView.clearForm(type);
            if (result.sealedMonths?.length) {
                toast(`${result.sealedMonths.map(monthLabel).join(' and ')} sealed automatically before this entry.`, 'info', 7000);
            }
            ok(`${type[0].toUpperCase() + type.slice(1)} published - correctable for a few more seconds.`);
            navigate('overview');
        } finally {
            trigger.disabled = false;
        }
    }));

    onAction('tx:correct', ({ id }) => run(async () => {
        const tx = state.transactions.find((t) => t.id === id);
        if (!tx) return warn('That entry is gone.');
        const values = await formDialog({
            title: 'Correct this entry',
            submitLabel: 'Save correction',
            fields: [
                { name: 'amount', label: 'Amount', type: 'number', value: String(Math.abs(toMajor(tx.amountMinor ?? 0))), required: true },
                { name: 'reason', label: 'Reason / description', value: tx.reason ?? '' },
                { name: 'category', label: 'Category', type: 'select', value: tx.category ?? '', options: knownCategories(DEFAULT_CATEGORIES).map((c) => ({ value: c, label: c })) },
                { name: 'note', label: 'Note', type: 'textarea', value: tx.note ?? '', hint: 'The window does not restart when you save - it runs from when the entry was first published.' }
            ]
        });
        if (!values) return;
        await correctTransaction(id, values);
        ok('Corrected. Still held out of the balance until the window closes.');
        refreshPendingStrip();
    }));

    onAction('tx:discard', ({ id }) => run(async () => {
        const yes = await confirmDialog({
            title: 'Discard this entry?', tone: 'danger',
            body: 'It never reached the balance, so nothing needs unwinding. It will be removed and the discard recorded in the audit log.',
            confirmLabel: 'Discard'
        });
        if (!yes) return;
        await discardPending(id);
        ok('Discarded before it counted.');
        refreshPendingStrip();
    }));

    onAction('tx:reverse', ({ id }) => run(async () => {
        const tx = state.transactions.find((t) => t.id === id);
        const values = await formDialog({
            title: 'Reverse this entry',
            submitLabel: 'Post reversal',
            fields: [{
                name: 'reason', label: 'Why is this being reversed?', required: true, type: 'textarea',
                hint: `The original ${fmt(tx?.amountMinor ?? 0, { showSign: true })} stays on the ledger. An equal and opposite entry is posted so the pair nets to zero.`
            }]
        });
        if (!values) return;
        await reverseTransaction(id, values.reason);
        ok('Reversal posted.');
    }));

    onAction('tx:approve', ({ id }) => run(async () => {
        const tx = state.transactions.find((t) => t.id === id);
        const yes = await confirmDialog({
            title: 'Approve this spend?',
            body: `${fmt(tx?.amountMinor ?? 0)} - ${tx?.reason ?? ''}. Approving releases it into the balance.`,
            confirmLabel: 'Approve'
        });
        if (!yes) return;
        await approveTransaction(id);
        ok('Approved and released.');
        renderCurrentView();
    }));

    /* --- snapshots --- */
    onAction('snapshot:manual', () => run(async () => {
        const snap = await takeManualSnapshot();
        ok(`Checkpoint saved for ${monthLabel(snap.monthKey)} at ${fmt(snap.closingBalanceMinor)}.`);
        renderCurrentView();
    }));

    /* --- members --- */
    onAction('member:add', () => run(async () => {
        await addMember({
            email: $('#new-user-email')?.value,
            name: $('#new-user-name')?.value,
            duesMonthly: $('#new-user-dues')?.value
        });
        for (const id of ['new-user-email', 'new-user-name', 'new-user-dues']) {
            const node = $('#' + id);
            if (node) node.value = '';
        }
        ok('Member added.');
        renderCurrentView();
    }));

    onAction('member:open', ({ email }) => {
        const host = $('#member-detail');
        if (!host) return;
        host.innerHTML = membersView.renderMemberDetail(email);
        applyPermissionsToDom(host);
        host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    onAction('member:close', () => { const host = $('#member-detail'); if (host) host.innerHTML = ''; });

    onAction('member:edit', ({ email }) => run(async () => {
        const member = state.members.find((m) => (m.email ?? m.id) === email);
        const values = await formDialog({
            title: 'Edit member',
            fields: [
                { name: 'name', label: 'Full name', value: member?.name ?? '', required: true },
                { name: 'duesMonthly', label: 'Monthly dues', type: 'number', value: String(toMajor(member?.duesMonthlyMinor ?? 0)) },
                { name: 'status', label: 'Status', type: 'select', value: member?.status ?? 'active', options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }] }
            ]
        });
        if (!values) return;
        await updateMember(email, values);
        ok('Member updated.');
        renderCurrentView();
    }));

    onAction('member:archive', ({ email }) => run(async () => {
        const hasHistory = state.transactions.some((tx) => tx.userId === email);
        const yes = await confirmDialog({
            title: hasHistory ? 'Archive this member?' : 'Remove this member?',
            tone: 'danger',
            body: hasHistory
                ? 'They have transactions, so their ledger history is kept and they are simply hidden from pickers. Deleting them would silently change historical totals.'
                : 'They have no transactions, so the record can be removed outright.',
            confirmLabel: hasHistory ? 'Archive' : 'Remove'
        });
        if (!yes) return;
        const outcome = await archiveMember(email);
        ok(outcome === 'archived' ? 'Member archived; ledger history kept.' : 'Member removed.');
        renderCurrentView();
    }));

    onAction('member:statement', ({ email }) => run(() => exportMemberStatement(email)));

    /* --- budgets, goals, recurring --- */
    onAction('budget:new', () => run(() => budgetDialog()));
    onAction('budget:edit', ({ id }) => run(() => budgetDialog(state.budgets.find((b) => b.id === id))));
    onAction('budget:delete', ({ id }) => run(async () => {
        const yes = await confirmDialog({ title: 'Delete this budget?', body: 'Spending is unaffected; you simply stop getting warnings for this category.', tone: 'danger', confirmLabel: 'Delete' });
        if (!yes) return;
        await deleteBudget(id);
        ok('Budget deleted.');
        renderCurrentView();
    }));

    onAction('goal:new', () => run(() => goalDialog()));
    onAction('goal:edit', ({ id }) => run(() => goalDialog(state.goals.find((g) => g.id === id))));
    onAction('goal:archive', ({ id }) => run(async () => {
        const yes = await confirmDialog({ title: 'Archive this goal?', body: 'It disappears from the dashboard but is kept on record.', confirmLabel: 'Archive' });
        if (!yes) return;
        await archiveGoal(id);
        ok('Goal archived.');
        renderCurrentView();
    }));

    onAction('recurring:new', () => run(() => recurringDialog()));
    onAction('recurring:edit', ({ id }) => run(() => recurringDialog(state.recurring.find((r) => r.id === id))));
    onAction('recurring:toggle', ({ id, active }) => run(async () => {
        await toggleRecurring(id, active === '1');
        renderCurrentView();
    }));
    onAction('recurring:delete', ({ id }) => run(async () => {
        const yes = await confirmDialog({ title: 'Delete this recurring entry?', body: 'Transactions it has already created are unaffected.', tone: 'danger', confirmLabel: 'Delete' });
        if (!yes) return;
        await deleteRecurring(id);
        ok('Recurring entry deleted.');
        renderCurrentView();
    }));
    onAction('recurring:run', () => run(async () => {
        const created = await runDueRecurring();
        ok(created.length ? `${created.length} recurring entr${created.length === 1 ? 'y' : 'ies'} recorded.` : 'Nothing was due.');
        renderCurrentView();
    }));

    /* --- reconciliation --- */
    onAction('reconcile:record', () => run(async () => {
        const result = await recordReconciliation({
            statementBalance: $('#recon-balance')?.value,
            asOf: $('#recon-date')?.value || dayKey(),
            note: $('#recon-note')?.value
        });
        if (result.diffMinor === 0) ok('Reconciled - the ledger and the bank agree.');
        else warn(`Recorded a ${fmt(Math.abs(result.diffMinor))} discrepancy.`);
        renderCurrentView();
    }));

    /* --- data --- */
    onAction('export:workbook', () => run(() => exportWorkbook()));
    onAction('export:csv', () => run(() => exportCsv()));
    onAction('export:json', () => run(() => exportJson()));
    onAction('export:csv-filtered', () => run(() => exportCsv(applyFilters())));
    onAction('import:template', () => downloadTemplate());
    onAction('import:commit', () => run(async () => {
        const summary = summarise(importCandidates);
        const yes = await confirmDialog({
            title: `Import ${summary.valid} rows?`,
            body: `Net effect ${summary.netLabel} across ${summary.months.length} month(s). Each row gets its own correction window and audit entry.`,
            confirmLabel: 'Import',
            typeToConfirm: summary.valid > 50 ? 'IMPORT' : null
        });
        if (!yes) return;
        const result = await commitImport(importCandidates, {
            onProgress: (done, total) => {
                const node = $('#import-progress');
                if (node) node.textContent = `Importing ${done} of ${total}…`;
            }
        });
        importCandidates = [];
        if (result.failed.length) warn(`${result.created} imported, ${result.failed.length} rejected.`);
        else ok(`${result.created} transactions imported.`);
        renderCurrentView();
    }));
    onAction('import:cancel', () => { importCandidates = []; const node = $('#import-preview'); if (node) node.innerHTML = ''; });

    /* --- governance --- */
    onAction('audit:verify', () => run(async () => {
        const host = $('#audit-verify-result');
        if (host) host.innerHTML = '<p class="text-sm text-slate-500">Recomputing every hash…</p>';
        const result = await verifyChain();
        const cls = result.ok
            ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'
            : 'border-rose-300 bg-rose-50 dark:bg-rose-950/30 text-rose-800 dark:text-rose-200';
        if (host) {
            host.innerHTML = `<div class="rounded-lg border p-3 text-sm ${cls}">
                <strong>${result.ok ? 'Chain intact.' : `Chain broken at entry #${escapeHtml(String(result.brokenAt))}.`}</strong>
                ${escapeHtml(result.reason)}
            </div>`;
        }
        (result.ok ? ok : err)(result.ok ? 'Audit chain verified.' : 'Audit chain is broken - see the detail above.');
    }));

    onAction('integrity:run', () => run(async () => {
        const report = integrityReport();
        const host = $('#integrity-block');
        if (host) {
            host.innerHTML = governanceView.integrityCard();
            applyPermissionsToDom(host);
        }
        (report.clean ? ok : warn)(report.clean
            ? `No problems across ${report.checked} transactions.`
            : `${report.findings.length} finding${report.findings.length === 1 ? '' : 's'} to review.`);
    }));

    /* --- access control --- */
    onAction('people:invite', () => run(async () => {
        if (!await requireRecentAuth('Confirm it is you before granting access.')) return;
        const values = await formDialog({
            title: 'Grant access',
            submitLabel: 'Grant access',
            fields: [
                { name: 'email', label: 'Email address', type: 'email', required: true, hint: 'They sign in with this Google account.' },
                { name: 'name', label: 'Name', required: true },
                {
                    name: 'role', label: 'Role', type: 'select', value: ROLES.VIEWER,
                    options: Object.values(ROLES).map((r) => ({ value: r, label: ROLE_LABELS[r] })),
                    hint: 'Owner: everything, including people and settings. Admin: day-to-day treasury. Trustee: oversight and approvals only. Viewer: read-only.'
                }
            ]
        });
        if (!values) return;
        await inviteUser(values);
        ok(`${values.email} can now sign in as ${ROLE_LABELS[values.role]}.`);
        renderCurrentView();
    }));

    onAction('people:role', ({ email }) => run(async () => {
        if (!await requireRecentAuth('Confirm it is you before changing a role.')) return;
        const person = state.roles.find((r) => (r.email ?? r.id) === email);
        const values = await formDialog({
            title: `Change role for ${email}`,
            submitLabel: 'Change role',
            fields: [{
                name: 'role', label: 'Role', type: 'select', value: person?.role,
                options: Object.values(ROLES).map((r) => ({ value: r, label: ROLE_LABELS[r] }))
            }]
        });
        if (!values) return;
        await changeUserRole(email, values.role);
        ok('Role updated.');
        renderCurrentView();
    }));

    onAction('people:perms', ({ email }) => run(async () => {
        const person = state.roles.find((r) => (r.email ?? r.id) === email);
        if (!person) return warn('That person no longer has access.');
        await permissionsDialog(person);
    }));

    onAction('people:suspend', ({ email, on: turnOn }) => run(async () => {
        const suspend = turnOn === '1';
        const yes = await confirmDialog({
            title: suspend ? `Suspend ${email}?` : `Reinstate ${email}?`,
            body: suspend
                ? 'They keep their role and their audit history stays attributable, but they cannot do anything until reinstated.'
                : 'They regain everything their role allows.',
            tone: suspend ? 'danger' : 'default',
            confirmLabel: suspend ? 'Suspend' : 'Reinstate'
        });
        if (!yes) return;
        await suspendUser(email, suspend);
        ok(suspend ? 'Access suspended.' : 'Access restored.');
        renderCurrentView();
    }));

    onAction('people:revoke', ({ email }) => run(async () => {
        if (!await requireRecentAuth('Confirm it is you before revoking access.')) return;
        const yes = await confirmDialog({
            title: `Revoke access for ${email}?`, tone: 'danger',
            body: 'They will not be able to sign in. Everything they recorded stays on the ledger and in the audit trail.',
            confirmLabel: 'Revoke', typeToConfirm: 'REVOKE'
        });
        if (!yes) return;
        await revokeUser(email);
        ok('Access revoked.');
        renderCurrentView();
    }));

    /* --- settings --- */
    onAction('settings:save', () => run(async () => {
        await saveSettings({
            orgName: $('#set-orgname')?.value,
            currencySymbol: $('#set-symbol')?.value,
            currencyCode: $('#set-code')?.value,
            locale: $('#set-locale')?.value,
            correctionWindowSeconds: $('#set-window')?.value,
            approvalThreshold: $('#set-threshold')?.value,
            idleTimeoutMinutes: $('#set-idle')?.value,
            autoSnapshotOnOpen: $('#set-backfill')?.value === 'on'
        });
        ok('Settings saved.');
        renderCurrentView();
    }));

    /* --- ledger filters --- */
    onAction('ledger:filter', () => { readFilters(); state.ui.ledgerPage = 0; renderCurrentView(); });
    onAction('ledger:clear', () => { state.ui.filters = { ...EMPTY_FILTERS }; state.ui.ledgerPage = 0; renderCurrentView(); });
    onAction('ledger:page', ({ delta }) => { state.ui.ledgerPage += Number(delta); renderCurrentView(); });
}

function readFilters() {
    const value = (id) => $('#' + id)?.value ?? '';
    state.ui.filters = {
        ...EMPTY_FILTERS,
        text: value('filter-text'),
        type: value('filter-type') || 'all',
        status: value('filter-status') || 'all',
        category: value('filter-category') || 'all',
        member: value('filter-member') || 'all',
        from: value('filter-from'),
        to: value('filter-to')
    };
}

/* ------------------------------------------------------------- Dialogs */

async function budgetDialog(existing) {
    const values = await formDialog({
        title: existing ? 'Edit budget' : 'New budget',
        submitLabel: 'Save budget',
        fields: [
            { name: 'category', label: 'Category', type: 'select', value: existing?.category, options: knownCategories(DEFAULT_CATEGORIES).map((c) => ({ value: c, label: c })) },
            { name: 'limit', label: 'Monthly limit', type: 'number', required: true, value: existing ? String(toMajor(existing.limitMinor)) : '' }
        ]
    });
    if (!values) return;
    await saveBudget({ id: existing?.id, ...values });
    ok('Budget saved.');
    renderCurrentView();
}

async function goalDialog(existing) {
    const values = await formDialog({
        title: existing ? 'Edit goal' : 'New savings goal',
        submitLabel: 'Save goal',
        fields: [
            { name: 'name', label: 'Goal name', required: true, value: existing?.name ?? '' },
            { name: 'target', label: 'Target amount', type: 'number', required: true, value: existing ? String(toMajor(existing.targetMinor)) : '' },
            { name: 'deadline', label: 'Deadline', type: 'date', value: existing?.deadline ?? '' },
            { name: 'note', label: 'Note', value: existing?.note ?? '' }
        ]
    });
    if (!values) return;
    await saveGoal({ id: existing?.id, ...values });
    ok('Goal saved.');
    renderCurrentView();
}

async function recurringDialog(existing) {
    const values = await formDialog({
        title: existing ? 'Edit recurring entry' : 'New recurring entry',
        submitLabel: 'Save',
        fields: [
            { name: 'label', label: 'Label', required: true, value: existing?.label ?? '' },
            { name: 'type', label: 'Type', type: 'select', value: existing?.type ?? 'debit', options: [
                { value: 'debit', label: 'Money out' }, { value: 'income', label: 'Money in' }, { value: 'credit', label: 'Member credit' }
            ] },
            { name: 'amount', label: 'Amount', type: 'number', required: true, value: existing ? String(Math.abs(toMajor(existing.amountMinor))) : '' },
            { name: 'category', label: 'Category', type: 'select', value: existing?.category, options: knownCategories(DEFAULT_CATEGORIES).map((c) => ({ value: c, label: c })) },
            { name: 'userId', label: 'Member email (credits only)', value: existing?.userId === 'org' ? '' : (existing?.userId ?? '') },
            { name: 'dayOfMonth', label: 'Day of month', type: 'number', value: String(existing?.dayOfMonth ?? 1), hint: 'Capped at 28 so it fires every month, February included.' }
        ]
    });
    if (!values) return;
    await saveRecurring({ id: existing?.id, ...values });
    ok('Recurring entry saved.');
    renderCurrentView();
}

/**
 * Permission override editor. Renders the role's baseline as pre-ticked and
 * disabled-looking context, so the owner sees what they are adding *to*.
 */
async function permissionsDialog(person) {
    const base = new Set(basePermissions(person.role));
    const grants = new Set(person.grants ?? []);
    const denies = new Set(person.denies ?? []);

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[110] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto';
    overlay.innerHTML = `
        <div class="bg-white dark:bg-slate-800 dark:text-slate-100 rounded-xl shadow-2xl max-w-2xl w-full p-6 my-8">
            <h3 class="text-lg font-bold mb-1">Permissions for ${escapeHtml(person.name ?? person.email)}</h3>
            <p class="text-xs text-slate-500 dark:text-slate-400 mb-4">
                Ticked greyed rows come with the ${escapeHtml(ROLE_LABELS[person.role] ?? person.role)} role. Untick one to take it away; tick an extra to grant it.
            </p>
            <div class="max-h-80 overflow-y-auto border rounded-lg dark:border-slate-700">
                ${Object.entries(PERMISSIONS).map(([key, label]) => {
                    const inRole = base.has(key);
                    const checked = inRole ? !denies.has(key) : grants.has(key);
                    return `<label class="flex items-start gap-3 px-3 py-2 border-b dark:border-slate-700 last:border-0 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50">
                        <input type="checkbox" data-perm-key="${escapeHtml(key)}" ${checked ? 'checked' : ''} class="mt-1">
                        <span class="min-w-0">
                            <span class="text-sm block">${escapeHtml(label)}</span>
                            <span class="text-[11px] font-mono text-slate-400">${escapeHtml(key)}${inRole ? ' · from role' : ''}</span>
                        </span>
                    </label>`;
                }).join('')}
            </div>
            <div class="flex justify-end gap-2 mt-4">
                <button data-role="cancel" class="px-4 py-2 rounded border dark:border-slate-600">Cancel</button>
                <button data-role="save" class="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700">Save permissions</button>
            </div>
        </div>`;

    document.body.appendChild(overlay);

    await new Promise((resolve) => {
        overlay.querySelector('[data-role="cancel"]').addEventListener('click', () => { overlay.remove(); resolve(); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(); } });
        overlay.querySelector('[data-role="save"]').addEventListener('click', async () => {
            const nextGrants = [], nextDenies = [];
            for (const box of overlay.querySelectorAll('[data-perm-key]')) {
                const key = box.dataset.permKey;
                const inRole = base.has(key);
                if (box.checked && !inRole) nextGrants.push(key);
                if (!box.checked && inRole) nextDenies.push(key);
            }
            overlay.remove();
            resolve();
            await run(async () => {
                await setPermissionOverrides(person.email ?? person.id, { grants: nextGrants, denies: nextDenies });
                ok('Permissions updated.');
                renderCurrentView();
            });
        });
    });
}

/* ------------------------------------------------------------ Commands */

function registerCommands() {
    for (const v of VIEWS) {
        registerCommand({
            id: 'go:' + v.id, label: 'Go to ' + v.label, keys: v.key,
            perm: v.perm, run: () => navigate(v.id)
        });
    }
    registerCommand({ id: 'tx.credit', label: 'Record a credit', perm: 'tx.create', run: () => navigate('record') });
    registerCommand({ id: 'snapshot', label: 'Take a balance checkpoint', perm: 'snapshot.create', run: () => run(async () => { const s = await takeManualSnapshot(); ok(`Checkpoint saved at ${fmt(s.closingBalanceMinor)}.`); }) });
    registerCommand({ id: 'export.xlsx', label: 'Export Excel workbook', perm: 'data.export', run: () => run(() => exportWorkbook()) });
    registerCommand({ id: 'export.csv', label: 'Export CSV ledger', perm: 'data.export', run: () => run(() => exportCsv()) });
    registerCommand({ id: 'export.json', label: 'Export JSON backup', perm: 'data.export', run: () => run(() => exportJson()) });
    registerCommand({ id: 'audit.verify', label: 'Verify the audit chain', perm: 'audit.view', run: () => { navigate('governance'); setTimeout(() => $('[data-action="audit:verify"]')?.click(), 60); } });
    registerCommand({ id: 'member.add', label: 'Add a member', perm: 'member.manage', run: () => navigate('members') });
    registerCommand({ id: 'people.invite', label: 'Grant someone access', perm: 'roles.manage', run: () => { navigate('access'); setTimeout(() => $('[data-action="people:invite"]')?.click(), 60); } });
    registerCommand({ id: 'theme', label: 'Switch light / dark theme', run: () => { cycleTheme(); renderCurrentView(); } });
    registerCommand({ id: 'signout', label: 'Sign out', run: () => $('[data-action="signout"]')?.click() });
}

/* ------------------------------------------------------------- Wiring */

function wireImportInput() {
    document.addEventListener('change', async (event) => {
        if (event.target?.id !== 'import-file') return;
        const file = event.target.files?.[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) return warn('That file is larger than 5MB. Split it into smaller batches.');

        const text = await file.text();
        const { candidates, fatal } = validateRows(parseCsv(text));
        const host = $('#import-preview');
        if (!host) return;

        if (fatal) {
            importCandidates = [];
            host.innerHTML = `<div class="rounded-lg border border-rose-300 bg-rose-50 dark:bg-rose-950/30 p-3 text-sm text-rose-800 dark:text-rose-200">${escapeHtml(fatal)}</div>`;
            return;
        }

        importCandidates = candidates;
        const summary = summarise(candidates);
        const rows = candidates.slice(0, 100).map((c) => `
            <tr class="border-b border-slate-100 dark:border-slate-700/60 ${c.ok ? '' : 'bg-rose-50 dark:bg-rose-950/20'}">
                <td class="p-2 text-xs">${c.line}</td>
                <td class="p-2 text-xs">${escapeHtml(c.preview.effectiveDate ?? '-')}</td>
                <td class="p-2 text-xs uppercase">${escapeHtml(c.preview.type)}</td>
                <td class="p-2 text-xs tabular-nums">${escapeHtml(String(c.preview.amount))}</td>
                <td class="p-2 text-xs">${escapeHtml(c.preview.userId)}</td>
                <td class="p-2 text-xs">${escapeHtml(c.preview.reason)}</td>
                <td class="p-2 text-xs">
                    ${c.errors.map((e) => `<span class="block text-rose-600">${escapeHtml(e)}</span>`).join('')}
                    ${c.warnings.map((w) => `<span class="block text-amber-600">${escapeHtml(w)}</span>`).join('')}
                    ${c.ok && c.warnings.length === 0 ? '<span class="text-emerald-600">ok</span>' : ''}
                </td>
            </tr>`).join('');

        host.innerHTML = `
            <div class="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                <p class="text-sm mb-2">
                    <strong>${summary.valid}</strong> of ${summary.total} rows are importable
                    ${summary.invalid ? `· <span class="text-rose-600">${summary.invalid} rejected</span>` : ''}
                    ${summary.warnings ? `· <span class="text-amber-600">${summary.warnings} with warnings</span>` : ''}
                    · net ${escapeHtml(summary.netLabel)}
                </p>
                <div class="max-h-72 overflow-auto border rounded dark:border-slate-700">
                    <table class="w-full text-left">
                        <thead class="text-[11px] uppercase text-slate-500 sticky top-0 bg-white dark:bg-slate-800">
                            <tr><th class="p-2">Line</th><th class="p-2">Date</th><th class="p-2">Type</th><th class="p-2">Amount</th><th class="p-2">Member</th><th class="p-2">Reason</th><th class="p-2">Notes</th></tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
                <div class="flex gap-2 items-center mt-3">
                    <button data-action="import:commit" class="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700">Import ${summary.valid} rows</button>
                    <button data-action="import:cancel" class="px-4 py-2 rounded-lg border dark:border-slate-600 text-sm">Cancel</button>
                    <span id="import-progress" class="text-xs text-slate-500"></span>
                </div>
            </div>`;
    });
}

function wireLiveFilterInput() {
    const rerun = debounce(() => {
        if (state.ui.view !== 'ledger') return;
        readFilters();
        state.ui.ledgerPage = 0;
        renderCurrentView();
        $('#filter-text')?.focus();
    }, 260);
    document.addEventListener('input', (event) => {
        if (event.target?.id === 'filter-text') rerun();
    });
}

export function bootUi() {
    // Registered first so totals and alerts are already up to date by the time
    // any view re-renders in response to the same event.
    initDerivedState();
    initTheme();
    initActionDelegation();
    registerActions();
    registerCommands();
    wireImportInput();
    wireLiveFilterInput();

    initShortcuts(Object.fromEntries(VIEWS.map((v) => [v.key, () => navigate(v.id)])));

    $('#hamburger-btn')?.addEventListener('click', () => $('#sidebar')?.classList.remove('-translate-x-full'));
    $('#close-sidebar-btn')?.addEventListener('click', () => $('#sidebar')?.classList.add('-translate-x-full'));
    // The single place that turns a URL change - from a click, the back or
    // forward button, or a hand-edited address bar - into a rendered view.
    window.addEventListener('hashchange', () => applyView(location.hash.slice(1) || 'overview'));

    // Re-render on data changes, but never while a dialog is open - replacing
    // the DOM under a form the user is filling in loses their input.
    const rerender = debounce(() => {
        if (document.querySelector('[role="dialog"]')) return;
        renderCurrentView();
    }, 140);

    for (const event of [
        EVENTS.TX_CHANGED, EVENTS.MEMBERS_CHANGED, EVENTS.SNAPSHOTS_CHANGED,
        EVENTS.ROLES_CHANGED, EVENTS.BUDGETS_CHANGED, EVENTS.GOALS_CHANGED,
        EVENTS.RECURRING_CHANGED, EVENTS.RECONCILE_CHANGED, EVENTS.SETTINGS_CHANGED
    ]) {
        on(event, rerender);
    }
    on(EVENTS.AUDIT_CHANGED, () => { if (state.ui.view === 'governance') rerender(); });
    on(EVENTS.PENDING_TICK, refreshPendingStrip);

    initPendingRuntime();
    // Render whatever the URL already says (a deep link, or a reload on a
    // specific view) without pushing a history entry for it - the entry a
    // reload lands on should be the first one back takes you to, not a
    // duplicate of it.
    applyView(location.hash.slice(1) || 'overview');
}

export { VIEWS, handle, run };
