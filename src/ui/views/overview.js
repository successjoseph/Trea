/**
 * Overview: the screen a treasurer looks at every day.
 *
 * Ordered by urgency - anything still correctable first, then alerts, then the
 * headline numbers, then trend. Money that is *not* yet in the balance is shown
 * above money that is, because an uncommitted entry is the only thing on this
 * page with a deadline attached.
 */
import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/dom.js';
import { fmt } from '../../core/money.js';
import { monthLabel, monthKey } from '../../core/time.js';
import { can } from '../../core/rbac.js';
import { windowRemainingMs } from '../../data/ledger.js';
import { pendingEntries, windowSeconds } from '../../features/pending.js';
import { balanceSeries, closingOf } from '../../features/snapshots.js';
import {
    burnRateMinor, averageIncomeMinor, runwayMonths, netFlowThisMonth,
    monthOverMonth, budgetUtilisation, goalProgress
} from '../../features/analytics.js';
import { balanceLineChart, inOutBarChart, categoryDonut, progressBar } from '../charts.js';
import { groupByCategory } from '../../data/ledger.js';
import {
    card, statTile, sectionHeader, pageTitle, button, badge, emptyState
} from '../components.js';

/* -------------------------------------------------- Pending release strip */

/**
 * The correction window, made visible.
 *
 * Rendered as its own region and re-rendered on a tick, so the countdown is the
 * only thing repainting while it runs. Each entry states plainly that it is not
 * in the balance - the whole feature fails if a user assumes it already counted.
 */
export function renderPendingStrip() {
    const pending = pendingEntries();
    if (pending.length === 0) return '';

    const rows = pending.map((tx) => {
        const remaining = windowRemainingMs(tx);
        const seconds = Math.ceil(remaining / 1000);
        const ratio = Math.max(0, Math.min(1, remaining / (windowSeconds() * 1000)));
        const who = tx.userId && tx.userId !== 'org' ? ` · ${tx.userId}` : '';
        const mine = tx.createdBy === state.session?.email;
        const canEdit = can(mine ? 'tx.correct' : 'tx.correct.any');

        return `<div class="flex flex-wrap items-center gap-3 py-2.5 border-t border-amber-200/60 dark:border-amber-800/40 first:border-t-0">
            <div class="w-11 shrink-0 text-center">
                <div class="text-base font-bold tabular-nums text-amber-700 dark:text-amber-300">${seconds}s</div>
                <div class="h-1 rounded-full bg-amber-200 dark:bg-amber-900 overflow-hidden mt-0.5">
                    <div class="h-full bg-amber-500" style="width:${(ratio * 100).toFixed(1)}%"></div>
                </div>
            </div>
            <div class="flex-1 min-w-[12rem]">
                <p class="text-sm font-semibold">
                    ${escapeHtml(String(tx.type).toUpperCase())} ${escapeHtml(fmt(tx.amountMinor ?? 0, { showSign: true }))}
                    <span class="font-normal text-slate-500 dark:text-slate-400">${escapeHtml((tx.reason ? ' · ' + tx.reason : '') + who)}</span>
                </p>
                <p class="text-xs text-slate-500 dark:text-slate-400">
                    Held out of the balance until the window closes${tx.editCount ? ` · corrected ${tx.editCount}×` : ''}
                </p>
            </div>
            <div class="flex gap-2">
                ${canEdit ? button('Correct', { action: 'tx:correct', data: { id: tx.id }, tone: 'ghost', size: 'sm' }) : ''}
                ${canEdit ? button('Discard', { action: 'tx:discard', data: { id: tx.id }, tone: 'danger', size: 'sm' }) : ''}
            </div>
        </div>`;
    }).join('');

    const totalPending = pending.reduce((s, tx) => s + (tx.amountMinor ?? 0), 0);

    return `<section class="rounded-xl border-2 border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-4 mb-6">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-1">
            <h3 class="font-bold text-sm text-amber-900 dark:text-amber-200">
                ${pending.length} entr${pending.length === 1 ? 'y' : 'ies'} still correctable
            </h3>
            <span class="text-xs text-amber-800 dark:text-amber-300">
                ${escapeHtml(fmt(totalPending, { showSign: true }))} not yet in the balance
            </span>
        </div>
        <p class="text-xs text-amber-800/80 dark:text-amber-300/80 mb-1">
            You have ${windowSeconds()} seconds from publishing to fix or discard an entry. After that the ledger is
            immutable and mistakes must be corrected with a reversing entry.
        </p>
        ${rows}
    </section>`;
}

/* ------------------------------------------------------------- Alert list */

function renderAlerts() {
    if (state.alerts.length === 0) {
        return card(`${sectionHeader('Nothing needs your attention', 'Budgets are within limits, no approvals are waiting and dues are up to date.')}`);
    }
    const tones = { critical: 'danger', warn: 'pending', info: 'info' };
    const items = state.alerts.map((a) => `
        <li class="flex items-start gap-3 py-2.5 border-b border-slate-100 dark:border-slate-700/60 last:border-0">
            <span class="mt-0.5">${badge(a.level, tones[a.level] ?? 'neutral')}</span>
            <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold">${escapeHtml(a.title)}</p>
                <p class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(a.body)}</p>
            </div>
            ${a.view ? button('Open', { action: 'nav', data: { target: a.view }, tone: 'ghost', size: 'sm' }) : ''}
        </li>`).join('');

    return card(`${sectionHeader(`${state.alerts.length} thing${state.alerts.length === 1 ? '' : 's'} to look at`, 'Recalculated from your data every time it changes - nothing here is stored or needs dismissing.')}
        <ul>${items}</ul>`);
}

/* ----------------------------------------------------------------- View */

export function render() {
    const totals = state.totals;
    const series = balanceSeries();
    const flow = netFlowThisMonth();
    const mom = monthOverMonth();
    const runway = runwayMonths();
    const trend = series.slice(-12).map((p) => p.closingMinor);

    const momLabel = (d) => {
        if (!mom.previousKey) return 'no prior month to compare';
        const sign = d.absolute >= 0 ? '+' : '';
        return `${sign}${d.percent.toFixed(0)}% vs ${monthLabel(mom.previousKey)}`;
    };

    const tiles = [
        statTile({
            label: 'Total balance', accent: 'blue', trend,
            value: fmt(totals.balanceMinor),
            hint: totals.pendingCount
                ? `${fmt(totals.pendingMinor, { showSign: true })} pending release`
                : 'All entries published'
        }),
        statTile({
            label: 'Money in this month', accent: 'green',
            value: fmt(flow.inflow), hint: momLabel(mom.income)
        }),
        statTile({
            label: 'Money out this month', accent: 'red',
            value: fmt(flow.outflow), hint: momLabel(mom.spend)
        }),
        statTile({
            label: 'Net this month', accent: flow.net >= 0 ? 'green' : 'red',
            value: fmt(flow.net, { showSign: true }),
            hint: `${state.members.filter((m) => m.status !== 'archived').length} active members`
        })
    ].join('');

    const kpis = [
        statTile({
            label: 'Average monthly spend', accent: 'amber',
            value: fmt(burnRateMinor()), hint: 'Trailing six complete months'
        }),
        statTile({
            label: 'Average monthly income', accent: 'green',
            value: fmt(averageIncomeMinor()), hint: 'Trailing six complete months'
        }),
        statTile({
            label: 'Runway', accent: Number.isFinite(runway) && runway < 3 ? 'red' : 'purple',
            value: Number.isFinite(runway) ? `${runway.toFixed(1)} months` : 'Not burning down',
            hint: Number.isFinite(runway) ? 'At the current net burn' : 'Income covers spending'
        }),
        statTile({
            label: 'Months sealed', accent: 'slate',
            value: String(state.snapshots.filter((s) => s.auto !== false).length),
            hint: 'Closed automatically on the first entry of a new month'
        })
    ].join('');

    const budgets = budgetUtilisation().slice(0, 4);
    const budgetBlock = budgets.length === 0
        ? emptyState('No budgets set. Add one to get overspend warnings.',
            can('budget.manage') ? button('Add a budget', { action: 'nav', data: { target: 'planning' }, tone: 'ghost', size: 'sm' }) : '')
        : budgets.map((b) => `
            <div class="mb-3 last:mb-0">
                <div class="flex justify-between text-xs mb-1">
                    <span class="font-semibold">${escapeHtml(b.category)}</span>
                    <span class="tabular-nums ${b.breached ? 'text-rose-600 font-bold' : 'text-slate-500 dark:text-slate-400'}">
                        ${escapeHtml(fmt(b.spentMinor))} / ${escapeHtml(fmt(b.limitMinor))}
                    </span>
                </div>
                ${progressBar(b.ratio)}
            </div>`).join('');

    const goals = goalProgress().slice(0, 3);
    const goalBlock = goals.length === 0
        ? emptyState('No savings goals yet.')
        : goals.map((g) => `
            <div class="mb-3 last:mb-0">
                <div class="flex justify-between text-xs mb-1">
                    <span class="font-semibold">${escapeHtml(g.name)}</span>
                    <span class="tabular-nums text-slate-500 dark:text-slate-400">${Math.round(g.ratio * 100)}% of ${escapeHtml(fmt(g.targetMinor))}</span>
                </div>
                ${progressBar(Math.min(1, g.ratio), { warn: 2, danger: 3 })}
            </div>`).join('');

    const latestSnapshot = state.snapshots
        .filter((s) => s.auto !== false)
        .sort((a, b) => String(b.monthKey ?? b.id).localeCompare(String(a.monthKey ?? a.id)))[0];

    return `
        ${pageTitle(
            state.org?.orgName ?? 'Treasury',
            `${monthLabel(monthKey())} · ${state.transactions.length} entries on file`,
            [
                can('snapshot.create') ? button('Snapshot now', { action: 'snapshot:manual', tone: 'ghost' }) : '',
                can('tx.create') ? button('Record entry', { action: 'nav', data: { target: 'record' } }) : ''
            ].join('')
        )}

        <div id="pending-strip">${renderPendingStrip()}</div>

        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">${tiles}</div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            <div class="lg:col-span-2">
                ${card(`${sectionHeader('Closing balance by month',
                    latestSnapshot
                        ? `Last sealed month: ${monthLabel(latestSnapshot.monthKey ?? latestSnapshot.id)} at ${fmt(closingOf(latestSnapshot))}`
                        : 'Months seal themselves once an entry lands in the following month.')}
                    <div class="h-56 text-slate-600 dark:text-slate-300">${balanceLineChart(series)}</div>`)}
            </div>
            <div>${renderAlerts()}</div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">${kpis}</div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            ${card(`${sectionHeader('Money in vs out')}<div class="h-52 text-slate-600 dark:text-slate-300">${inOutBarChart(series.slice(-12))}</div>`)}
            ${card(`${sectionHeader('Spend this month', monthLabel(monthKey()))}
                ${categoryDonut(groupByCategory(state.transactions, { monthKey: monthKey() }))}`)}
            <div class="space-y-6">
                ${card(`${sectionHeader('Budgets')}${budgetBlock}`)}
                ${card(`${sectionHeader('Goals')}${goalBlock}`)}
            </div>
        </div>`;
}

export const view = {
    id: 'overview',
    label: 'Overview',
    render
};

