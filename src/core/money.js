/**
 * Money is stored and computed as signed integer minor units (kobo), never as
 * floats. 0.1 + 0.2 problems in a ledger are unacceptable, and a treasury that
 * drifts by a kobo per transaction stops reconciling within a year.
 *
 * Legacy documents wrote a float `amount` in major units. `readAmountMinor`
 * absorbs both shapes so old data keeps totalling correctly.
 */

export const MINOR_PER_MAJOR = 100;

/** Parse arbitrary user input ("₦1,250.50", "1250.5", 1250.5) to minor units. */
export function toMinor(input) {
    if (input === null || input === undefined || input === '') return NaN;
    if (typeof input === 'number') return Math.round(input * MINOR_PER_MAJOR);
    const cleaned = String(input).replace(/[^0-9.\-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return NaN;
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return NaN;
    return Math.round(n * MINOR_PER_MAJOR);
}

export function toMajor(minor) {
    return (Number(minor) || 0) / MINOR_PER_MAJOR;
}

/**
 * Read the signed minor-unit amount off a transaction document, tolerating the
 * pre-v2 shape. Debits were (and still are) stored negative so totals sum
 * naturally without branching on type.
 */
export function readAmountMinor(tx) {
    if (typeof tx?.amountMinor === 'number' && Number.isFinite(tx.amountMinor)) {
        return Math.round(tx.amountMinor);
    }
    if (typeof tx?.amount === 'number' && Number.isFinite(tx.amount)) {
        return Math.round(tx.amount * MINOR_PER_MAJOR);
    }
    return 0;
}

let activeSymbol = '₦';
let activeLocale = 'en-NG';
let activeCurrency = 'NGN';

export function configureCurrency({ symbol, locale, code } = {}) {
    if (symbol) activeSymbol = symbol;
    if (locale) activeLocale = locale;
    if (code) activeCurrency = code;
}

export function currencySymbol() { return activeSymbol; }
export function currencyCode() { return activeCurrency; }

/** Human-readable amount, e.g. ₦1,250.50. Negatives render as -₦1,250.50. */
export function fmt(minor, { showSign = false, compact = false } = {}) {
    const value = toMajor(minor);
    const abs = Math.abs(value);
    let body;
    if (compact && abs >= 1000) {
        const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
        const [div, suf] = units.find(([d]) => abs >= d);
        body = (abs / div).toFixed(abs / div >= 100 ? 0 : 1).replace(/\.0$/, '') + suf;
    } else {
        body = abs.toLocaleString(activeLocale, {
            minimumFractionDigits: 2, maximumFractionDigits: 2
        });
    }
    const sign = value < 0 ? '-' : (showSign && value > 0 ? '+' : '');
    return `${sign}${activeSymbol}${body}`;
}

/** Percentage helper that refuses to divide by zero. */
export function pct(part, whole) {
    if (!whole) return 0;
    return (part / whole) * 100;
}
