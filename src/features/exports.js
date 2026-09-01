/**
 * Exports: XLSX, CSV, JSON, and per-member statements.
 *
 * Every export goes through `rowsFor()` so the columns are identical across
 * formats - an accountant comparing a CSV against the spreadsheet should never
 * find the two disagree. Pending entries are labelled rather than hidden: the
 * export says an entry exists and is not counted, which is more honest than
 * pretending the last 30 seconds did not happen.
 */
import { state } from '../core/state.js';
import { requireCan } from '../core/rbac.js';
import { fmt, toMajor, readAmountMinor, currencyCode } from '../core/money.js';
import { fmtDate, fmtDateTime, monthLabel } from '../core/time.js';
import { effectiveStatus, effectiveMs, sortByTime, withRunningBalance, STATUS } from '../data/ledger.js';
import { logAudit, AUDIT_CATEGORY } from '../data/audit.js';
import { ValidationError } from '../data/transactions.js';

/** Canonical export shape, shared by every format. */
export function rowsFor(transactions) {
    return sortByTime(transactions, 'asc').map((tx) => ({
        Date: fmtDate(effectiveMs(tx)),
        Month: monthLabel(tx.monthKey ?? ''),
        Type: String(tx.type ?? '').toUpperCase(),
        Status: effectiveStatus(tx).toUpperCase(),
        Counted: effectiveStatus(tx) === STATUS.ACTIVE ? 'yes' : 'no',
        Amount: toMajor(readAmountMinor(tx)),
        Currency: currencyCode(),
        Member: tx.userId === 'org' ? '' : (tx.userId ?? ''),
        Category: tx.category ?? '',
        Reason: tx.reason ?? '',
        Source: tx.source ?? '',
        Tags: (tx.tags ?? []).join(' '),
        Reference: tx.reference ?? '',
        RecordedBy: tx.createdBy ?? tx.adminEmail ?? '',
        RecordedAt: fmtDateTime(tx.createdAtMs),
        Corrections: tx.editCount ?? 0,
        ReversalOf: tx.reversalOfId ?? '',
        ReversedBy: tx.reversedById ?? '',
        Id: tx.id
    }));
}

function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoke on the next tick; revoking synchronously can cancel the download
    // in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
    return new Date().toISOString().slice(0, 10);
}

function safeOrgName() {
    return String(state.org?.orgName ?? state.session?.orgId ?? 'trea')
        .replace(/[^a-z0-9_-]+/gi, '_')
        .slice(0, 40);
}

function guard() {
    const denied = requireCan('data.export');
    if (denied) throw new ValidationError(denied);
    if (state.transactions.length === 0) throw new ValidationError('There is nothing to export yet.');
}

/* ------------------------------------------------------------------ CSV */

/**
 * RFC-4180 quoting, plus a leading apostrophe on anything a spreadsheet would
 * treat as a formula. Without that, a reason field of `=cmd|…` becomes a
 * live formula the moment someone opens the export - CSV injection is a real
 * attack against exactly this kind of tool.
 */
function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    if (/[",\n\r]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
    return text;
}

export function toCsv(rows) {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(',')];
    for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(','));
    return lines.join('\r\n');
}

export async function exportCsv(transactions = state.transactions) {
    guard();
    const csv = toCsv(rowsFor(transactions));
    download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }),
        `${safeOrgName()}_ledger_${stamp()}.csv`);
    await logAudit(`Exported ${transactions.length} transactions to CSV`, { category: AUDIT_CATEGORY.DATA });
}

/* ----------------------------------------------------------------- JSON */

export async function exportJson() {
    guard();
    const payload = {
        exportedAt: new Date().toISOString(),
        exportedBy: state.session.email,
        org: state.session.orgId,
        settings: state.org ?? null,
        totals: state.totals,
        transactions: state.transactions,
        members: state.members,
        snapshots: state.snapshots,
        budgets: state.budgets,
        goals: state.goals,
        recurring: state.recurring,
        reconciliations: state.reconciliations,
        auditLogs: state.auditLogs
    };
    download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
        `${safeOrgName()}_backup_${stamp()}.json`);
    await logAudit('Exported a full JSON backup', { category: AUDIT_CATEGORY.DATA });
}

/* ----------------------------------------------------------------- XLSX */

function requireSheetJs() {
    if (!globalThis.XLSX) {
        throw new ValidationError('The spreadsheet library did not load. Use CSV export instead.');
    }
    return globalThis.XLSX;
}

/**
 * Multi-sheet workbook: the ledger, one row per sealed month, per-member
 * totals, and the audit trail. One file an auditor can work from without
 * needing the app.
 */
export async function exportWorkbook(transactions = state.transactions) {
    guard();
    const XLSX = requireSheetJs();
    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsFor(transactions)), 'Ledger');

    const snapshotRows = state.snapshots
        .slice()
        .sort((a, b) => String(a.monthKey ?? a.id).localeCompare(String(b.monthKey ?? b.id)))
        .map((s) => ({
            Month: s.monthYear ?? monthLabel(s.monthKey ?? s.id),
            Opening: toMajor(s.openingBalanceMinor ?? 0),
            Income: toMajor(s.incomeMinor ?? 0),
            Credits: toMajor(s.creditsMinor ?? 0),
            Debits: toMajor(s.debitsMinor ?? 0),
            Closing: toMajor(s.closingBalanceMinor ?? Math.round((s.total_balance ?? 0) * 100)),
            Transactions: s.txCount ?? '',
            Sealed: s.auto === false ? 'manual checkpoint' : 'auto-sealed',
            SealedBy: s.generatedBy ?? ''
        }));
    if (snapshotRows.length) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snapshotRows), 'Month End');
    }

    const memberRows = state.members.map((m) => {
        const key = m.email ?? m.id;
        const total = transactions
            .filter((tx) => tx.userId === key && effectiveStatus(tx) === STATUS.ACTIVE)
            .reduce((s, tx) => s + readAmountMinor(tx), 0);
        return {
            Member: m.name ?? key,
            Email: key,
            Status: m.status ?? 'active',
            MonthlyDues: toMajor(m.duesMonthlyMinor ?? 0),
            TotalContributed: toMajor(total)
        };
    });
    if (memberRows.length) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(memberRows), 'Members');
    }

    const auditRows = state.auditLogs.map((a) => ({
        Seq: a.seq ?? '',
        When: fmtDateTime(a.createdAtMs ?? a.timestamp?.toMillis?.()),
        Who: a.actorEmail ?? a.admin_email ?? '',
        Role: a.actorRole ?? '',
        Action: a.action ?? '',
        Detail: a.detail ?? '',
        Hash: a.hash ?? ''
    }));
    if (auditRows.length) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(auditRows), 'Audit Trail');
    }

    XLSX.writeFile(wb, `${safeOrgName()}_treasury_${stamp()}.xlsx`);
    await logAudit(`Exported a ${wb.SheetNames.length}-sheet workbook`, { category: AUDIT_CATEGORY.DATA });
}

/* ------------------------------------------------------------ Statement */

/**
 * A single member's statement with a running balance - the thing a member
 * actually asks for when they say "what have I paid?".
 */
export async function exportMemberStatement(email) {
    guard();
    const member = state.members.find((m) => (m.email ?? m.id) === email);
    const theirs = state.transactions.filter((tx) => tx.userId === email);
    if (theirs.length === 0) throw new ValidationError('That member has no transactions to export.');

    const rows = withRunningBalance(sortByTime(theirs, 'asc')).map((tx) => ({
        Date: fmtDate(effectiveMs(tx)),
        Description: tx.reason || tx.category || tx.type,
        Type: String(tx.type ?? '').toUpperCase(),
        Status: effectiveStatus(tx).toUpperCase(),
        Amount: toMajor(readAmountMinor(tx)),
        RunningTotal: toMajor(tx.runningMinor),
        RecordedBy: tx.createdBy ?? tx.adminEmail ?? ''
    }));

    const name = (member?.name ?? email).replace(/[^a-z0-9_-]+/gi, '_');
    const csv = toCsv(rows);
    download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }),
        `${safeOrgName()}_statement_${name}_${stamp()}.csv`);

    await logAudit(`Exported a statement for ${email}`, { category: AUDIT_CATEGORY.DATA, targetId: email });
}

