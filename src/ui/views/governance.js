/**
 * Governance: approvals, the audit trail, its integrity check, and the data
 * integrity sweep.
 *
 * This is the screen an auditor is shown. It answers three questions: what is
 * waiting on a second signature, has anything been tampered with, and does the
 * data itself hold together.
 */
import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/dom.js';
import { fmt } from '../../core/money.js';
import { fmtDateTime, relative } from '../../core/time.js';
import { can, ROLE_LABELS } from '../../core/rbac.js';
import { effectiveStatus, STATUS } from '../../data/ledger.js';
import { integrityReport } from '../../features/analytics.js';
import { approvalThresholdMinor } from '../../data/transactions.js';
import {
    card, sectionHeader, pageTitle, button, table, row, badge, emptyState
} from '../components.js';

/* ------------------------------------------------------------ Approvals */

function approvalsCard() {
    const held = state.transactions.filter((tx) => effectiveStatus(tx) === STATUS.HELD);
    const threshold = approvalThresholdMinor();

    const subtitle = threshold
        ? `Spending of ${fmt(threshold)} or more is held out of the balance until someone other than the person who recorded it approves.`
        : 'No approval threshold is set, so nothing is ever held. An owner can set one in Settings.';

    if (held.length === 0) {
        return card(`${sectionHeader('Approvals', subtitle)}${emptyState('Nothing is waiting for approval.')}`);
    }

    const rows = held.map((tx) => {
        const own = tx.createdBy === state.session?.email;
        return row([
            `<span class="text-xs whitespace-nowrap">${escapeHtml(fmtDateTime(tx.createdAtMs))}</span>`,
            `<p class="font-medium">${escapeHtml(tx.reason || tx.category || tx.type)}</p>
             <p class="text-xs text-slate-500 dark:text-slate-400">recorded by ${escapeHtml(tx.createdBy ?? tx.adminEmail ?? 'unknown')}</p>`,
            `<span class="font-semibold tabular-nums text-rose-600 dark:text-rose-400">${escapeHtml(fmt(tx.amountMinor ?? 0, { showSign: true }))}</span>`,
            can('tx.approve')
                ? (own
                    ? badge('You recorded this', 'neutral')
                    : button('Approve', { action: 'tx:approve', data: { id: tx.id }, tone: 'success', size: 'sm' }))
                : badge('Awaiting a trustee', 'held')
        ]);
    });

    const total = held.reduce((s, tx) => s + Math.abs(tx.amountMinor ?? 0), 0);
    return card(`
        ${sectionHeader(`${held.length} entr${held.length === 1 ? 'y' : 'ies'} awaiting approval`,
            `${fmt(total)} is held out of the balance. ${subtitle}`)}
        ${table({ headers: ['Recorded', 'Detail', 'Amount', ''], rows })}`);
}

/* ---------------------------------------------------------- Audit trail */

const CATEGORY_TONE = {
    money: 'info', people: 'active', governance: 'held', data: 'neutral', security: 'danger'
};

function auditCard() {
    if (!can('audit.view')) {
        return card(`${sectionHeader('Audit trail')}${emptyState('Your role cannot read the audit log.')}`);
    }

    const rows = state.auditLogs.slice(0, 100).map((entry) => {
        const ms = entry.createdAtMs ?? entry.timestamp?.toMillis?.() ?? 0;
        return row([
            `<span class="text-xs whitespace-nowrap" title="${escapeHtml(fmtDateTime(ms))}">${escapeHtml(relative(ms))}</span>`,
            `<span class="text-xs font-mono text-slate-400">#${escapeHtml(String(entry.seq ?? '-'))}</span>`,
            `<div>
                <p class="text-sm">${escapeHtml(entry.action ?? '')}</p>
                ${entry.detail ? `<p class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(entry.detail)}</p>` : ''}
             </div>`,
            `<span class="text-xs">${escapeHtml(entry.actorEmail ?? entry.admin_email ?? '')}</span>
             ${entry.actorRole ? badge(ROLE_LABELS[entry.actorRole] ?? entry.actorRole) : ''}`,
            badge(entry.category ?? 'money', CATEGORY_TONE[entry.category] ?? 'neutral'),
            `<span class="text-[10px] font-mono text-slate-400" title="${escapeHtml(entry.hash ?? '')}">${escapeHtml((entry.hash ?? '').slice(0, 8))}</span>`
        ]);
    });

    return card(`
        ${sectionHeader('Audit trail',
            'Every entry carries the hash of the one before it. Change or delete any row and the chain breaks at that point.',
            [
                button('Verify chain', { action: 'audit:verify', tone: 'ghost', size: 'sm' }),
                can('data.export') ? button('Export', { action: 'export:workbook', tone: 'ghost', size: 'sm' }) : ''
            ].join(''))}
        <div id="audit-verify-result" class="mb-4"></div>
        ${rows.length === 0
            ? emptyState('No actions logged yet.')
            : table({ headers: ['When', '#', 'Action', 'Who', 'Area', 'Hash'], rows })}`);
}

/* ------------------------------------------------------- Data integrity */

function integrityCard() {
    const report = integrityReport();

    if (report.clean) {
        return card(`
            ${sectionHeader('Data integrity', `${report.checked} transactions checked.`,
                button('Re-run', { action: 'integrity:run', tone: 'ghost', size: 'sm' }))}
            <p class="text-sm text-emerald-700 dark:text-emerald-400">
                No problems found - no mis-signed debits, orphaned credits, undated rows, likely duplicates or drifted snapshots.
            </p>`);
    }

    const rows = report.findings.slice(0, 50).map((f) => row([
        badge(f.level === 'critical' ? 'critical' : 'warning', f.level === 'critical' ? 'danger' : 'pending'),
        `<span class="text-sm">${escapeHtml(f.message)}</span>`,
        `<span class="text-xs font-mono text-slate-400">${escapeHtml(String(f.id ?? ''))}</span>`
    ]));

    return card(`
        ${sectionHeader('Data integrity',
            `${report.findings.length} finding${report.findings.length === 1 ? '' : 's'} across ${report.checked} transactions.`,
            button('Re-run', { action: 'integrity:run', tone: 'ghost', size: 'sm' }))}
        ${table({ headers: ['Level', 'Finding', 'Record'], rows })}`);
}

export function render() {
    return `
        ${pageTitle('Governance', 'Approvals, the audit trail and data health.')}
        <div class="space-y-6">
            ${approvalsCard()}
            <div id="integrity-block">${integrityCard()}</div>
            ${auditCard()}
        </div>`;
}

export { integrityCard };
export const view = { id: 'governance', label: 'Governance', render };
