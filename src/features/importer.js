/**
 * CSV import with a mandatory dry run.
 *
 * Bulk-loading a year of bank rows by hand is the most error-prone thing a
 * treasurer does, and an import that goes straight to the database is the most
 * error-prone way to do it. So `parseCsv` and `validateRows` are pure: they
 * produce a preview with per-row errors and nothing is written until the user
 * has seen exactly what will land.
 */
import { state } from '../core/state.js';
import { requireCan } from '../core/rbac.js';
import { toMinor, fmt } from '../core/money.js';
import { dayKey, monthKey } from '../core/time.js';
import { createTransaction, TX_TYPES, ValidationError } from '../data/transactions.js';
import { logAudit, AUDIT_CATEGORY } from '../data/audit.js';

export const IMPORT_TEMPLATE =
    'date,type,amount,member,category,reason\n' +
    '2026-01-05,credit,5000,ada@example.org,Dues,January dues\n' +
    '2026-01-09,income,8000,,Donation,Community donation\n' +
    '2026-01-14,debit,1200,,Transport,Fuel for outreach\n';

/**
 * Small hand-rolled CSV parser. Handles quoted fields, embedded commas,
 * doubled quotes and both line-ending conventions - which is all this format
 * actually needs, and cheaper than pulling in a parser.
 */
export function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
            continue;
        }
        if (ch === '"') { inQuotes = true; continue; }
        if (ch === ',') { row.push(field); field = ''; continue; }
        if (ch === '\r') continue;
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const HEADER_ALIASES = {
    date: ['date', 'transactiondate', 'valuedate', 'posteddate'],
    type: ['type', 'kind', 'direction'],
    amount: ['amount', 'value', 'sum'],
    member: ['member', 'email', 'user', 'userid', 'payer'],
    category: ['category', 'class', 'bucket'],
    reason: ['reason', 'description', 'narration', 'details', 'note']
};

function mapHeaders(headerRow) {
    const normalised = headerRow.map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
    const index = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        const pos = normalised.findIndex((h) => aliases.includes(h));
        if (pos >= 0) index[field] = pos;
    }
    return index;
}

/**
 * Turn parsed rows into candidate transactions, each carrying its own errors
 * and warnings. Never throws for bad data - the whole point is to show the user
 * every problem at once instead of failing on row 3 of 300.
 */
export function validateRows(rows) {
    if (rows.length < 2) {
        return { columns: {}, candidates: [], fatal: 'The file needs a header row and at least one data row.' };
    }

    const columns = mapHeaders(rows[0]);
    for (const required of ['date', 'type', 'amount']) {
        if (columns[required] === undefined) {
            return { columns, candidates: [], fatal: `No "${required}" column found. Expected headers: date, type, amount, member, category, reason.` };
        }
    }

    const memberIds = new Set(state.members.map((m) => m.email ?? m.id));
    const seen = new Set();

    const candidates = rows.slice(1).map((cells, i) => {
        const get = (field) => (columns[field] !== undefined ? (cells[columns[field]] ?? '').trim() : '');
        const errors = [], warnings = [];

        const rawDate = get('date');
        const parsed = Date.parse(rawDate.length === 10 ? rawDate + 'T12:00:00' : rawDate);
        if (!Number.isFinite(parsed)) errors.push(`"${rawDate || '(blank)'}" is not a date`);
        else if (parsed > Date.now() + 86400000) errors.push('dated in the future');

        const type = get('type').toLowerCase();
        if (!TX_TYPES.includes(type)) errors.push(`"${type || '(blank)'}" is not one of ${TX_TYPES.join(', ')}`);

        const amountMinor = Math.abs(toMinor(get('amount')));
        if (!Number.isFinite(amountMinor) || amountMinor === 0) errors.push('amount is missing or zero');
        if (amountMinor > 1e13) errors.push('amount is implausibly large');

        const member = get('member').toLowerCase();
        if (type === 'credit' && !member) errors.push('a credit needs a member');
        if (member && !memberIds.has(member)) warnings.push(`"${member}" is not on the members list`);

        const reason = get('reason');
        if (type === 'debit' && !reason) warnings.push('no reason given for this debit');

        const fingerprint = [rawDate, type, amountMinor, member, reason].join('|');
        if (seen.has(fingerprint)) warnings.push('identical to an earlier row in this file');
        seen.add(fingerprint);

        const effectiveDate = Number.isFinite(parsed) ? dayKey(parsed) : null;
        const existing = effectiveDate && state.transactions.some(
            (tx) => tx.effectiveDate === effectiveDate
                && Math.abs(tx.amountMinor ?? 0) === amountMinor
                && (tx.userId ?? '') === (member || 'org')
        );
        if (existing) warnings.push('a matching transaction already exists in the ledger');

        return {
            line: i + 2,
            ok: errors.length === 0,
            errors,
            warnings,
            preview: {
                type, amount: amountMinor / 100, userId: member || 'org',
                category: get('category') || '', reason,
                effectiveDate, monthKey: effectiveDate ? monthKey(parsed) : null
            }
        };
    });

    return { columns, candidates, fatal: null };
}

export function summarise(candidates) {
    const valid = candidates.filter((c) => c.ok);
    const net = valid.reduce((sum, c) => {
        const magnitude = Math.round(c.preview.amount * 100);
        return sum + (c.preview.type === 'debit' ? -magnitude : magnitude);
    }, 0);
    const months = new Set(valid.map((c) => c.preview.monthKey).filter(Boolean));
    return {
        total: candidates.length,
        valid: valid.length,
        invalid: candidates.length - valid.length,
        warnings: candidates.filter((c) => c.warnings.length).length,
        netMinor: net,
        netLabel: fmt(net, { showSign: true }),
        months: Array.from(months).sort()
    };
}

/**
 * Commit the valid rows.
 *
 * Each row goes through `createTransaction`, so imported entries get the same
 * correction window, month-rollover check and audit line as manual ones. Rows
 * are committed sequentially and failures are collected rather than aborting
 * the batch, because a half-finished import the user cannot see is worse than
 * a finished one with a list of what did not take.
 */
export async function commitImport(candidates, { onProgress } = {}) {
    const denied = requireCan('data.import');
    if (denied) throw new ValidationError(denied);

    const valid = candidates.filter((c) => c.ok);
    if (valid.length === 0) throw new ValidationError('No valid rows to import.');
    if (valid.length > 1000) throw new ValidationError('Import at most 1000 rows at a time.');

    const results = { created: 0, failed: [] };

    for (const [index, candidate] of valid.entries()) {
        try {
            await createTransaction({
                type: candidate.preview.type,
                userId: candidate.preview.userId,
                amount: candidate.preview.amount,
                category: candidate.preview.category || undefined,
                reason: candidate.preview.reason || 'Imported',
                effectiveDate: candidate.preview.effectiveDate,
                note: 'Bulk import',
                tags: ['imported']
            });
            results.created += 1;
        } catch (error) {
            results.failed.push({ line: candidate.line, message: error.message });
        }
        onProgress?.(index + 1, valid.length);
    }

    await logAudit(
        `Imported ${results.created} transactions from CSV${results.failed.length ? ` (${results.failed.length} rejected)` : ''}`,
        { category: AUDIT_CATEGORY.DATA }
    );
    return results;
}

export function downloadTemplate() {
    const blob = new Blob([IMPORT_TEMPLATE], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'trea_import_template.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
