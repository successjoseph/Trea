/**
 * The ledger: search, filter, page and inspect every transaction.
 *
 * The running-balance column only advances on counted entries, so a pending row
 * visibly sits at the same balance as the row above it. That is the clearest
 * possible statement that it has not landed yet.
 */
import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/dom.js';
import { fmt } from '../../core/money.js';
import { fmtDate } from '../../core/time.js';
import { can } from '../../core/rbac.js';
import {
    effectiveStatus, effectiveMs, withRunningBalance, sortByTime,
    isCorrectable, STATUS, balanceAsOf
} from '../../data/ledger.js';
import { applyFilters, page, activeFilterCount, knownCategories } from '../../features/search.js';
import { DEFAULT_CATEGORIES } from '../../data/transactions.js';
import {
    card, pageTitle, button, table, row, badge, statusBadge, amountCell,
    input, select, INPUT_CLASS, emptyState
} from '../components.js';

function filterBar() {
    const f = state.ui.filters;
    const memberOpts = [
        { value: 'all', label: 'Everyone' },
        { value: 'org', label: 'Organisation only' },
        ...state.members.map((m) => ({ value: m.email ?? m.id, label: m.name ?? m.id }))
    ];
    const categoryOpts = [
        { value: 'all', label: 'All categories' },
        ...knownCategories(DEFAULT_CATEGORIES).map((c) => ({ value: c, label: c }))
    ];

    return card(`
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <div class="xl:col-span-2">
                <input id="filter-text" class="${INPUT_CLASS}" placeholder="Search reason, member, category, tag…"
                    value="${escapeHtml(f.text)}" autocomplete="off">
            </div>
            ${select({ id: 'filter-type', value: f.type, options: [
                { value: 'all', label: 'All types' },
                { value: 'credit', label: 'Credits' },
                { value: 'debit', label: 'Debits' },
                { value: 'income', label: 'Income' },
                { value: 'adjustment', label: 'Adjustments' }
            ] })}
            ${select({ id: 'filter-status', value: f.status, options: [
                { value: 'all', label: 'Any status' },
                { value: STATUS.ACTIVE, label: 'Published' },
                { value: STATUS.PENDING, label: 'Correctable' },
                { value: STATUS.HELD, label: 'Awaiting approval' },
                { value: STATUS.VOID, label: 'Void' }
            ] })}
            ${select({ id: 'filter-category', value: f.category, options: categoryOpts })}
            ${select({ id: 'filter-member', value: f.member, options: memberOpts })}
            ${input({ id: 'filter-from', type: 'date', value: f.from ?? '' })}
            ${input({ id: 'filter-to', type: 'date', value: f.to ?? '' })}
        </div>
        <div class="flex flex-wrap items-center gap-2 mt-3">
            ${button('Apply', { action: 'ledger:filter', size: 'sm' })}
            ${button('Clear', { action: 'ledger:clear', tone: 'ghost', size: 'sm' })}
            ${activeFilterCount() ? badge(`${activeFilterCount()} filter${activeFilterCount() === 1 ? '' : 's'} on`, 'info') : ''}
            <span class="flex-1"></span>
            ${can('data.export') ? button('Export filtered as CSV', { action: 'export:csv-filtered', tone: 'ghost', size: 'sm' }) : ''}
        </div>`);
}

function txRow(tx) {
    const status = effectiveStatus(tx);
    const counted = status === STATUS.ACTIVE;
    const mine = tx.createdBy === state.session?.email;
    const correctable = isCorrectable(tx) && can(mine ? 'tx.correct' : 'tx.correct.any');

    const actions = [
        correctable ? button('Correct', { action: 'tx:correct', data: { id: tx.id }, tone: 'ghost', size: 'sm' }) : '',
        correctable ? button('Discard', { action: 'tx:discard', data: { id: tx.id }, tone: 'danger', size: 'sm' }) : '',
        !correctable && counted && !tx.reversedById && !tx.reversalOfId && can('tx.void')
            ? button('Reverse', { action: 'tx:reverse', data: { id: tx.id }, tone: 'ghost', size: 'sm' }) : '',
        status === STATUS.HELD && can('tx.approve') && tx.createdBy !== state.session?.email
            ? button('Approve', { action: 'tx:approve', data: { id: tx.id }, tone: 'success', size: 'sm' }) : ''
    ].filter(Boolean).join(' ');

    const meta = [
        tx.userId && tx.userId !== 'org' ? escapeHtml(tx.userId) : 'Organisation',
        tx.reference ? 'ref ' + escapeHtml(tx.reference) : '',
        tx.editCount ? `corrected ${tx.editCount}×` : '',
        tx.reversalOfId ? 'reversal entry' : '',
        tx.reversedById ? 'reversed' : ''
    ].filter(Boolean).join(' · ');

    return row([
        `<span class="whitespace-nowrap text-xs">${escapeHtml(fmtDate(effectiveMs(tx)))}</span>`,
        `<div class="min-w-[10rem]">
            <p class="font-medium">${escapeHtml(tx.reason || tx.category || tx.type)}</p>
            <p class="text-xs text-slate-500 dark:text-slate-400">${meta}</p>
        </div>`,
        badge(tx.category ?? 'Uncategorised'),
        amountCell(tx.amountMinor ?? 0, { muted: !counted }),
        `<span class="tabular-nums text-xs ${counted ? '' : 'text-slate-400'}">${escapeHtml(fmt(tx.runningMinor))}</span>`,
        statusBadge(status),
        `<div class="flex gap-1 flex-wrap justify-end">${actions}</div>`
    ], { className: counted ? '' : 'bg-amber-50/50 dark:bg-amber-950/20' });
}

export function render() {
    const filtered = applyFilters();
    const paged = page(filtered, {
        pageIndex: state.ui.ledgerPage,
        pageSize: state.ui.pageSize,
        direction: 'desc'
    });

    // The running balance has to be computed over the *whole* ledger up to the
    // oldest row on this page, not just the page - otherwise page 2 would start
    // from zero and every figure on it would be wrong.
    const ascending = sortByTime(paged.rows, 'asc');
    const opening = ascending.length ? balanceAsOf(state.transactions, effectiveMs(ascending[0])) : 0;
    const withBalance = withRunningBalance(ascending, opening);
    const byId = new Map(withBalance.map((tx) => [tx.id, tx]));
    const rows = paged.rows.map((tx) => txRow(byId.get(tx.id) ?? { ...tx, runningMinor: 0 }));

    const filteredNet = filtered
        .filter((tx) => effectiveStatus(tx) === STATUS.ACTIVE)
        .reduce((s, tx) => s + (tx.amountMinor ?? 0), 0);

    const pager = paged.totalPages > 1
        ? `<div class="flex items-center justify-between gap-3 mt-4 text-sm">
            ${button('Previous', { action: 'ledger:page', data: { delta: '-1' }, tone: 'ghost', size: 'sm' })}
            <span class="text-xs text-slate-500 dark:text-slate-400">
                Page ${paged.pageIndex + 1} of ${paged.totalPages} · ${paged.totalRows} entries
            </span>
            ${button('Next', { action: 'ledger:page', data: { delta: '1' }, tone: 'ghost', size: 'sm' })}
        </div>`
        : '';

    return `
        ${pageTitle('Ledger',
            `${filtered.length} of ${state.transactions.length} entries · ${fmt(filteredNet, { showSign: true })} net in this selection`)}
        ${filterBar()}
        <div class="mt-6">
            ${card(rows.length === 0
                ? emptyState(activeFilterCount()
                    ? 'No entries match these filters.'
                    : 'No transactions recorded yet.',
                    activeFilterCount() ? button('Clear filters', { action: 'ledger:clear', tone: 'ghost', size: 'sm' }) : '')
                : table({
                    headers: ['Date', 'Detail', 'Category', 'Amount', 'Balance', 'Status', ''],
                    rows
                }) + pager)}
        </div>`;
}

export const view = { id: 'ledger', label: 'Ledger', render };
