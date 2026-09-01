/**
 * Reports: sealed months, variance, reconciliation, and getting data in and out.
 *
 * The month-end table is the centrepiece. Each row is a snapshot that sealed
 * itself, and the "Sealed" column distinguishes an automatic close from a
 * mid-month checkpoint someone took by hand - those are different kinds of
 * number and should never be read as the same thing.
 */
import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/dom.js';
import { fmt } from '../../core/money.js';
import { monthLabel, monthKey, fmtDate, fmtDateTime } from '../../core/time.js';
import { can } from '../../core/rbac.js';
import { balanceSeries, closingOf } from '../../features/snapshots.js';
import { monthOverMonth, budgetUtilisation } from '../../features/analytics.js';
import { groupByCategory, groupByMonth } from '../../data/ledger.js';
import { balanceLineChart, inOutBarChart, categoryDonut } from '../charts.js';
import {
    card, sectionHeader, pageTitle, button, table, row, badge, emptyState,
    field, input, INPUT_CLASS
} from '../components.js';

function monthEndCard() {
    const snapshots = state.snapshots
        .slice()
        .sort((a, b) => String(b.monthKey ?? b.id).localeCompare(String(a.monthKey ?? a.id)));

    if (snapshots.length === 0) {
        return card(`
            ${sectionHeader('Month end', 'Nothing sealed yet.')}
            ${emptyState('A month seals itself automatically the first time an entry is recorded in a later month. Nothing runs on a schedule and there is no server involved.',
                can('snapshot.create') ? button('Take a checkpoint now', { action: 'snapshot:manual', tone: 'ghost', size: 'sm' }) : '')}`);
    }

    const rows = snapshots.map((s) => {
        const mk = s.monthKey ?? s.id;
        const auto = s.auto !== false;
        return row([
            `<span class="font-medium whitespace-nowrap">${escapeHtml(s.monthYear ?? monthLabel(mk))}</span>`,
            `<span class="tabular-nums text-xs text-slate-500 dark:text-slate-400">${escapeHtml(fmt(s.openingBalanceMinor ?? 0))}</span>`,
            `<span class="tabular-nums text-xs text-emerald-700 dark:text-emerald-400">${escapeHtml(fmt((s.incomeMinor ?? 0) + (s.creditsMinor ?? 0)))}</span>`,
            `<span class="tabular-nums text-xs text-rose-600 dark:text-rose-400">${escapeHtml(fmt(s.debitsMinor ?? 0))}</span>`,
            `<span class="tabular-nums font-bold">${escapeHtml(fmt(closingOf(s)))}</span>`,
            `<span class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(String(s.txCount ?? '-'))}</span>`,
            auto ? badge('Auto-sealed', 'active') : badge('Manual checkpoint', 'neutral'),
            `<span class="text-xs text-slate-400">${escapeHtml(s.generatedBy ?? '')}</span>`
        ]);
    });

    return card(`
        ${sectionHeader('Month end',
            'Sealed automatically when the first entry of a new month arrives - the closing figure therefore excludes the entry that triggered it.',
            can('snapshot.create') ? button('Checkpoint this month', { action: 'snapshot:manual', tone: 'ghost', size: 'sm' }) : '')}
        ${table({ headers: ['Month', 'Opening', 'In', 'Out', 'Closing', 'Entries', 'Type', 'By'], rows })}`);
}

function varianceCard() {
    const mom = monthOverMonth();
    if (!mom.previousKey) {
        return card(`${sectionHeader('Variance')}${emptyState('Two months of activity are needed before a comparison means anything.')}`);
    }

    const line = (label, d, invert = false) => {
        const good = invert ? d.absolute <= 0 : d.absolute >= 0;
        return `<div class="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-700/60 last:border-0">
            <span class="text-sm">${escapeHtml(label)}</span>
            <span class="text-sm font-semibold tabular-nums ${good ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">
                ${escapeHtml(fmt(d.absolute, { showSign: true }))}
                <span class="text-xs font-normal text-slate-500 dark:text-slate-400">(${d.percent >= 0 ? '+' : ''}${d.percent.toFixed(0)}%)</span>
            </span>
        </div>`;
    };

    return card(`
        ${sectionHeader(`${monthLabel(mom.currentKey)} vs ${monthLabel(mom.previousKey)}`)}
        ${line('Money in', mom.income)}
        ${line('Money out', mom.spend, true)}
        ${line('Net', mom.net)}`);
}

function reconcileCard() {
    const history = state.reconciliations
        .slice()
        .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));

    const form = can('reconcile.manage')
        ? `<div class="grid grid-cols-1 md:grid-cols-4 gap-3 items-end mb-4">
            <div>${field('Balance on the statement', input({ id: 'recon-balance', type: 'number', placeholder: '0.00', attrs: 'step="0.01"' }))}</div>
            <div>${field('As of', input({ id: 'recon-date', type: 'date' }))}</div>
            <div>${field('Note', input({ id: 'recon-note', placeholder: 'e.g. GTB statement, page 3' }))}</div>
            <div class="mb-3">${button('Record reconciliation', { action: 'reconcile:record', size: 'lg' })}</div>
           </div>
           <p class="text-xs text-slate-500 dark:text-slate-400 mb-4">
               The ledger currently says <strong>${escapeHtml(fmt(state.totals.balanceMinor))}</strong>.
               Any difference is recorded as evidence, not silently corrected.
           </p>`
        : '';

    const rows = history.map((r) => row([
        `<span class="text-xs whitespace-nowrap">${escapeHtml(r.asOf ?? fmtDate(r.createdAtMs))}</span>`,
        `<span class="tabular-nums text-xs">${escapeHtml(fmt(r.statementBalanceMinor ?? 0))}</span>`,
        `<span class="tabular-nums text-xs">${escapeHtml(fmt(r.computedBalanceMinor ?? 0))}</span>`,
        (r.diffMinor ?? 0) === 0
            ? badge('Agrees', 'active')
            : badge(fmt(r.diffMinor, { showSign: true }), 'danger'),
        `<span class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(r.note ?? '')}</span>`,
        `<span class="text-xs text-slate-400">${escapeHtml(r.by ?? '')}<br>${escapeHtml(r.createdAtMs ? fmtDateTime(r.createdAtMs) : '')}</span>`
    ]));

    return card(`
        ${sectionHeader('Bank reconciliation', 'Compare the ledger against what the bank actually says.')}
        ${form}
        ${rows.length === 0
            ? emptyState('No reconciliations recorded yet.')
            : table({ headers: ['As of', 'Statement', 'Ledger', 'Difference', 'Note', 'By'], rows })}`);
}

function dataCard() {
    const exportButtons = can('data.export')
        ? [
            button('Excel workbook', { action: 'export:workbook', tone: 'ghost', size: 'sm' }),
            button('CSV ledger', { action: 'export:csv', tone: 'ghost', size: 'sm' }),
            button('JSON backup', { action: 'export:json', tone: 'ghost', size: 'sm' })
        ].join(' ')
        : '<span class="text-xs text-slate-500">Your role cannot export data.</span>';

    const importBlock = can('data.import')
        ? `<div class="mt-5 pt-5 border-t border-slate-200 dark:border-slate-700">
            <h4 class="font-semibold text-sm mb-1">Import from CSV</h4>
            <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">
                Nothing is written until you have seen a preview of every row, with its own errors and warnings.
            </p>
            <div class="flex flex-wrap gap-2 items-center">
                <input type="file" id="import-file" accept=".csv,text/csv" class="${INPUT_CLASS} max-w-xs text-xs">
                ${button('Download template', { action: 'import:template', tone: 'ghost', size: 'sm' })}
            </div>
            <div id="import-preview" class="mt-4"></div>
           </div>`
        : '';

    return card(`
        ${sectionHeader('Data', 'Exports carry the same columns in every format, and label pending entries rather than hiding them.')}
        <div class="flex flex-wrap gap-2">${exportButtons}</div>
        ${importBlock}`);
}

export function render() {
    const series = balanceSeries();
    const months = groupByMonth(state.transactions);
    const budgets = budgetUtilisation();

    const budgetSummary = budgets.length
        ? `<ul class="text-xs space-y-1">${budgets.map((b) => `
            <li class="flex justify-between">
                <span>${escapeHtml(b.category)}</span>
                <span class="tabular-nums ${b.breached ? 'text-rose-600 font-semibold' : 'text-slate-500'}">
                    ${Math.round(b.ratio * 100)}%
                </span>
            </li>`).join('')}</ul>`
        : '<p class="text-xs text-slate-500 italic">No budgets set.</p>';

    return `
        ${pageTitle('Reports', `${months.length} month${months.length === 1 ? '' : 's'} of activity on file`)}
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            <div class="lg:col-span-2">
                ${card(`${sectionHeader('Balance over time')}<div class="h-56 text-slate-600 dark:text-slate-300">${balanceLineChart(series)}</div>`)}
            </div>
            ${varianceCard()}
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            <div class="lg:col-span-2">
                ${card(`${sectionHeader('Money in vs out by month')}<div class="h-52 text-slate-600 dark:text-slate-300">${inOutBarChart(series.slice(-18))}</div>`)}
            </div>
            ${card(`${sectionHeader('Spend by category', `${monthLabel(monthKey())} · budget usage below`)}
                ${categoryDonut(groupByCategory(state.transactions, { monthKey: monthKey() }))}
                <div class="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">${budgetSummary}</div>`)}
        </div>
        <div class="space-y-6">
            ${monthEndCard()}
            ${reconcileCard()}
            ${dataCard()}
        </div>`;
}

export const view = { id: 'reports', label: 'Reports', render };
