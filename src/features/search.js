/**
 * Search and filtering.
 *
 * Runs entirely over the in-memory ledger - no Firestore query, no composite
 * index, no read cost. For the scale this app targets (a few thousand rows) a
 * linear scan over cached data is faster than a round trip, and it lets us
 * support combinations no single Firestore query could serve.
 */
import { state } from '../core/state.js';
import { readAmountMinor, toMinor } from '../core/money.js';
import { effectiveStatus, effectiveMs, sortByTime } from '../data/ledger.js';

export const EMPTY_FILTERS = {
    text: '', type: 'all', status: 'all', category: 'all',
    member: 'all', from: '', to: '', min: '', max: ''
};

/**
 * Tokenised match: every whitespace-separated term must appear somewhere in the
 * row. Typing "fuel ada" finds Ada's fuel entry without caring about order.
 */
function matchesText(tx, query) {
    if (!query) return true;
    const haystack = [
        tx.reason, tx.category, tx.userId, tx.source, tx.note,
        tx.reference, tx.type, tx.createdBy, (tx.tags ?? []).join(' ')
    ].filter(Boolean).join(' ').toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

export function applyFilters(transactions = state.transactions, filters = state.ui.filters) {
    const f = { ...EMPTY_FILTERS, ...filters };
    const fromMs = f.from ? Date.parse(f.from + 'T00:00:00') : null;
    const toMs = f.to ? Date.parse(f.to + 'T23:59:59') : null;
    const minMinor = f.min !== '' ? Math.abs(toMinor(f.min)) : null;
    const maxMinor = f.max !== '' ? Math.abs(toMinor(f.max)) : null;

    return transactions.filter((tx) => {
        if (f.type !== 'all' && tx.type !== f.type) return false;
        if (f.status !== 'all' && effectiveStatus(tx) !== f.status) return false;
        if (f.category !== 'all' && (tx.category ?? 'Uncategorised') !== f.category) return false;
        if (f.member !== 'all') {
            if (f.member === 'org' ? tx.userId !== 'org' : tx.userId !== f.member) return false;
        }

        const ms = effectiveMs(tx);
        if (fromMs !== null && ms < fromMs) return false;
        if (toMs !== null && ms > toMs) return false;

        const magnitude = Math.abs(readAmountMinor(tx));
        if (minMinor !== null && Number.isFinite(minMinor) && magnitude < minMinor) return false;
        if (maxMinor !== null && Number.isFinite(maxMinor) && magnitude > maxMinor) return false;

        return matchesText(tx, f.text);
    });
}

export function activeFilterCount(filters = state.ui.filters) {
    const f = { ...EMPTY_FILTERS, ...filters };
    return Object.entries(f).filter(([key, value]) => {
        if (['type', 'status', 'category', 'member'].includes(key)) return value !== 'all';
        return value !== '';
    }).length;
}

/** Distinct categories present in the data, plus the org's configured ones. */
export function knownCategories(extra = []) {
    const set = new Set(extra);
    for (const tx of state.transactions) set.add(tx.category ?? 'Uncategorised');
    for (const b of state.budgets) set.add(b.category);
    return Array.from(set).filter(Boolean).sort();
}

/** Paged slice of the filtered, sorted ledger. */
export function page(transactions, { pageIndex = 0, pageSize = 25, direction = 'desc' } = {}) {
    const sorted = sortByTime(transactions, direction);
    const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
    const clamped = Math.min(Math.max(0, pageIndex), totalPages - 1);
    return {
        rows: sorted.slice(clamped * pageSize, clamped * pageSize + pageSize),
        pageIndex: clamped,
        totalPages,
        totalRows: sorted.length
    };
}
