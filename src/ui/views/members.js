/**
 * Members: who contributes, what they have paid, and who is behind.
 *
 * The arrears table is the reason this screen exists. Everything else a
 * treasurer can reconstruct from the ledger; "who has not paid since March" is
 * the question that otherwise gets answered by hand every month.
 */
import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/dom.js';
import { fmt } from '../../core/money.js';
import { monthLabel, fmtDate } from '../../core/time.js';
import { can } from '../../core/rbac.js';
import { effectiveStatus, effectiveMs, sortByTime, withRunningBalance, STATUS } from '../../data/ledger.js';
import { memberSummaries, arrearsReport } from '../../features/analytics.js';
import {
    card, sectionHeader, pageTitle, button, table, row, badge, statusBadge,
    amountCell, emptyState, field, input
} from '../components.js';

function addMemberCard() {
    if (!can('member.manage')) return '';
    return card(`
        ${sectionHeader('Add a member', 'Email is the identifier - it links every credit to one person.')}
        <div class="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div>${field('Email', input({ id: 'new-user-email', type: 'email', placeholder: 'name@example.org' }))}</div>
            <div>${field('Full name', input({ id: 'new-user-name', placeholder: 'Ada Nwosu' }))}</div>
            <div>${field('Monthly dues', input({ id: 'new-user-dues', type: 'number', placeholder: '0.00', attrs: 'min="0" step="0.01"' }))}</div>
            <div class="mb-3">${button('Add member', { action: 'member:add', size: 'lg' })}</div>
        </div>`);
}

function arrearsCard() {
    const arrears = arrearsReport();
    if (arrears.length === 0) {
        return card(`${sectionHeader('Dues', 'Every member with a dues schedule is up to date.')}`);
    }

    const rows = arrears.map((a) => row([
        `<span class="font-medium">${escapeHtml(a.name)}</span>
         <p class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(a.email)}</p>`,
        badge(`${a.missedCount} month${a.missedCount === 1 ? '' : 's'}`, a.missedCount > 2 ? 'danger' : 'pending'),
        `<span class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(a.missedMonths.slice(-4).map(monthLabel).join(', '))}${a.missedMonths.length > 4 ? '…' : ''}</span>`,
        `<span class="font-semibold tabular-nums text-rose-600 dark:text-rose-400">${escapeHtml(fmt(a.owedMinor))}</span>`
    ]));

    const total = arrears.reduce((s, a) => s + a.owedMinor, 0);
    return card(`
        ${sectionHeader(`${arrears.length} member${arrears.length === 1 ? '' : 's'} behind on dues`,
            `${fmt(total)} outstanding. A month counts as missed when no credit was recorded for that member in it.`)}
        ${table({ headers: ['Member', 'Behind by', 'Months missed', 'Owed'], rows })}`);
}

function membersTable() {
    const summaries = memberSummaries();
    if (summaries.length === 0) {
        return card(emptyState('No members yet.'));
    }

    const rows = summaries.map((m) => {
        const archived = m.status === 'archived';
        return row([
            `<button data-action="member:open" data-email="${escapeHtml(m.email)}"
                class="text-left font-medium hover:text-blue-600 dark:hover:text-blue-400">
                ${escapeHtml(m.name ?? m.email)}
             </button>
             <p class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(m.email)}</p>`,
            archived ? badge('Archived', 'void') : badge('Active', 'active'),
            `<span class="text-xs tabular-nums">${escapeHtml(m.duesMonthlyMinor ? fmt(m.duesMonthlyMinor) : '-')}</span>`,
            amountCell(m.totalMinor),
            `<span class="text-xs text-slate-500 dark:text-slate-400">${m.count} entr${m.count === 1 ? 'y' : 'ies'}${m.lastMs ? ' · ' + escapeHtml(fmtDate(m.lastMs)) : ''}</span>`,
            `<div class="flex gap-1 justify-end flex-wrap">
                ${can('data.export') ? button('Statement', { action: 'member:statement', data: { email: m.email }, tone: 'ghost', size: 'sm' }) : ''}
                ${can('member.manage') ? button('Edit', { action: 'member:edit', data: { email: m.email }, tone: 'ghost', size: 'sm' }) : ''}
                ${can('member.manage') && !archived ? button('Archive', { action: 'member:archive', data: { email: m.email }, tone: 'danger', size: 'sm' }) : ''}
            </div>`
        ], { className: archived ? 'opacity-60' : '' });
    });

    return card(`
        ${sectionHeader('All members', 'Click a name to see their full ledger.')}
        ${table({ headers: ['Member', 'Status', 'Dues', 'Contributed', 'Activity', ''], rows })}`);
}

/** Detail panel for one member - rendered into `#member-detail` on demand. */
export function renderMemberDetail(email) {
    const member = state.members.find((m) => (m.email ?? m.id) === email);
    if (!member) return '';

    const theirs = state.transactions.filter((tx) => tx.userId === email);
    if (theirs.length === 0) {
        return card(`${sectionHeader(`${member.name ?? email}'s ledger`)}${emptyState('No transactions recorded for this member yet.')}`);
    }

    const ascending = withRunningBalance(sortByTime(theirs, 'asc'));
    const rows = ascending.slice().reverse().map((tx) => row([
        `<span class="text-xs whitespace-nowrap">${escapeHtml(fmtDate(effectiveMs(tx)))}</span>`,
        `<span>${escapeHtml(tx.reason || tx.category || tx.type)}</span>`,
        amountCell(tx.amountMinor ?? 0, { muted: !tx.counted }),
        `<span class="tabular-nums text-xs ${tx.counted ? '' : 'text-slate-400'}">${escapeHtml(fmt(tx.runningMinor))}</span>`,
        statusBadge(effectiveStatus(tx))
    ]));

    const total = ascending[ascending.length - 1].runningMinor;
    const counted = theirs.filter((tx) => effectiveStatus(tx) === STATUS.ACTIVE).length;

    return card(`
        ${sectionHeader(`${member.name ?? email}'s ledger`,
            `${fmt(total)} contributed across ${counted} published entr${counted === 1 ? 'y' : 'ies'}`,
            [
                can('data.export') ? button('Export statement', { action: 'member:statement', data: { email }, tone: 'ghost', size: 'sm' }) : '',
                button('Close', { action: 'member:close', tone: 'ghost', size: 'sm' })
            ].join(''))}
        ${table({ headers: ['Date', 'Detail', 'Amount', 'Running total', 'Status'], rows })}`);
}

export function render() {
    const active = state.members.filter((m) => m.status !== 'archived').length;
    return `
        ${pageTitle('Members', `${active} active · ${state.members.length - active} archived`)}
        ${addMemberCard()}
        <div id="member-detail" class="my-6"></div>
        <div class="grid grid-cols-1 xl:grid-cols-2 gap-6 mt-6">
            ${membersTable()}
            ${arrearsCard()}
        </div>`;
}

export const view = { id: 'members', label: 'Members', render };
