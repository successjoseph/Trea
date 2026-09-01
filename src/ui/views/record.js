/**
 * Recording money in and out.
 *
 * Three forms, one code path. Each explains what will happen after submit -
 * the correction window and, where relevant, the approval hold - because the
 * moment to tell someone their entry is not yet counted is before they publish
 * it, not after.
 */
import { state } from '../../core/state.js';
import { $, escapeHtml } from '../../core/dom.js';
import { fmt } from '../../core/money.js';
import { dayKey, monthKey, monthLabel } from '../../core/time.js';
import { can } from '../../core/rbac.js';
import { DEFAULT_CATEGORIES, approvalThresholdMinor } from '../../data/transactions.js';
import { latestEntryMonth } from '../../features/snapshots.js';
import { windowSeconds } from '../../features/pending.js';
import { knownCategories } from '../../features/search.js';
import {
    card, sectionHeader, pageTitle, button, field, input, select, emptyState
} from '../components.js';

function memberOptions() {
    return state.members
        .filter((m) => m.status !== 'archived')
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
        .map((m) => ({ value: m.email ?? m.id, label: `${m.name ?? m.id} (${m.email ?? m.id})` }));
}

function categoryOptions() {
    return knownCategories(DEFAULT_CATEGORIES).map((c) => ({ value: c, label: c }));
}

/**
 * Warn *before* the write when this entry will trigger a month seal. The
 * rollover is automatic either way, but a treasurer back-dating an entry into a
 * month that is about to close deserves to know.
 */
function rolloverNotice() {
    const latest = latestEntryMonth();
    const current = monthKey();
    if (!latest || current <= latest) return '';
    return `<div class="rounded-lg border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-3 mb-5 text-xs text-blue-900 dark:text-blue-200">
        <strong>Month rollover pending.</strong> The last entry on file is from ${escapeHtml(monthLabel(latest))}.
        Your next entry will automatically seal ${escapeHtml(monthLabel(latest))} at its true closing balance before it is applied.
    </div>`;
}

function approvalNotice() {
    const threshold = approvalThresholdMinor();
    if (!threshold) return '';
    return `<p class="text-xs text-purple-700 dark:text-purple-300 mt-2">
        Spending of ${escapeHtml(fmt(threshold))} or more is held out of the balance until a trustee approves it.
    </p>`;
}

function windowNotice() {
    return `<p class="text-xs text-amber-700 dark:text-amber-400 mt-2">
        You will have ${windowSeconds()} seconds to correct or discard this before it joins the balance.
    </p>`;
}

export function render() {
    if (!can('tx.create')) {
        return `${pageTitle('Record a transaction')}
            ${card(emptyState('Your role is read-only, so you cannot record transactions. A trustee or admin can do this for you.'))}`;
    }

    const members = memberOptions();
    const today = dayKey();

    const creditForm = card(`
        ${sectionHeader('Money from a member', 'Dues, contributions, repayments.')}
        ${members.length === 0
            ? emptyState('Add a member first - a credit has to belong to someone.',
                button('Go to members', { action: 'nav', data: { target: 'members' }, tone: 'ghost', size: 'sm' }))
            : `
                ${field('Member', select({ id: 'credit-user', options: [{ value: '', label: 'Select member…' }, ...members] }))}
                ${field('Amount', input({ id: 'credit-amount', type: 'number', placeholder: '0.00', attrs: 'min="0" step="0.01" inputmode="decimal"' }))}
                ${field('Category', select({ id: 'credit-category', options: categoryOptions(), value: 'Dues' }))}
                ${field('Note', input({ id: 'credit-reason', placeholder: 'e.g. March dues' }))}
                ${field('Date', input({ id: 'credit-date', type: 'date', value: today, attrs: `max="${today}"` }))}
                ${button('Publish credit', { action: 'tx:create', data: { type: 'credit' }, tone: 'primary', size: 'lg' })}
                ${windowNotice()}`}
    `, { className: 'border-t-4 border-t-blue-500' });

    const debitForm = card(`
        ${sectionHeader('Money out', 'Purchases, expenses, disbursements.')}
        ${field('Amount', input({ id: 'debit-amount', type: 'number', placeholder: '0.00', attrs: 'min="0" step="0.01" inputmode="decimal"' }))}
        ${field('Category', select({ id: 'debit-category', options: categoryOptions(), value: 'Supplies' }))}
        ${field('Reason', input({ id: 'debit-reason', placeholder: 'What was it for?' }), 'Required - this is what an auditor reads first.')}
        ${field('Reference', input({ id: 'debit-reference', placeholder: 'Receipt or invoice number (optional)' }))}
        ${field('Date', input({ id: 'debit-date', type: 'date', value: today, attrs: `max="${today}"` }))}
        ${button('Publish debit', { action: 'tx:create', data: { type: 'debit' }, tone: 'danger', size: 'lg' })}
        ${windowNotice()}
        ${approvalNotice()}
    `, { className: 'border-t-4 border-t-rose-500' });

    const incomeForm = card(`
        ${sectionHeader('Other money in', 'Donations, grants, interest.')}
        ${field('Amount', input({ id: 'income-amount', type: 'number', placeholder: '0.00', attrs: 'min="0" step="0.01" inputmode="decimal"' }))}
        ${field('Source', select({
            id: 'income-source',
            options: [
                { value: 'donation', label: 'Donation' },
                { value: 'grant', label: 'Grant' },
                { value: 'interest', label: 'Bank interest' },
                { value: 'gift', label: 'Gift' },
                { value: 'refund', label: 'Refund' },
                { value: 'other', label: 'Other' }
            ]
        }))}
        ${field('Description', input({ id: 'income-reason', placeholder: 'Who from, or what for' }))}
        ${field('Date', input({ id: 'income-date', type: 'date', value: today, attrs: `max="${today}"` }))}
        ${button('Publish income', { action: 'tx:create', data: { type: 'income' }, tone: 'success', size: 'lg' })}
        ${windowNotice()}
    `, { className: 'border-t-4 border-t-emerald-500' });

    return `
        ${pageTitle('Record a transaction',
            'Every entry is held for a short correction window before it touches the balance.')}
        ${rolloverNotice()}
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">${creditForm}${debitForm}${incomeForm}</div>`;
}

/** Read a form's fields into the shape `createTransaction` expects. */
export function readForm(type) {
    const value = (id) => $('#' + id)?.value?.trim() ?? '';
    if (type === 'credit') {
        return {
            type, userId: value('credit-user'), amount: value('credit-amount'),
            category: value('credit-category'), reason: value('credit-reason'),
            effectiveDate: value('credit-date') || dayKey()
        };
    }
    if (type === 'debit') {
        return {
            type, amount: value('debit-amount'), category: value('debit-category'),
            reason: value('debit-reason'), reference: value('debit-reference'),
            effectiveDate: value('debit-date') || dayKey()
        };
    }
    return {
        type: 'income', amount: value('income-amount'),
        source: value('income-source'),
        category: value('income-source') === 'interest' ? 'Interest' : 'Donation',
        reason: value('income-reason') || value('income-source'),
        effectiveDate: value('income-date') || dayKey()
    };
}

export function clearForm(type) {
    const ids = {
        credit: ['credit-amount', 'credit-reason'],
        debit: ['debit-amount', 'debit-reason', 'debit-reference'],
        income: ['income-amount', 'income-reason']
    }[type] ?? [];
    for (const id of ids) {
        const node = $('#' + id);
        if (node) node.value = '';
    }
}

export const view = { id: 'record', label: 'Record', perm: 'tx.create', render };
