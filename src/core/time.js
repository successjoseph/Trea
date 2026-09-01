/**
 * Time helpers.
 *
 * The whole month-rollover snapshot feature hangs on a single idea: a month is
 * identified by a sortable `YYYY-MM` key. Comparing two months is then a string
 * comparison, which is immune to timezone arithmetic bugs and works as a
 * Firestore document ID (giving us idempotent snapshot writes for free).
 */

/** Difference between the server clock and this device's clock, in ms. */
let serverOffsetMs = 0;

export function setServerOffset(ms) {
    if (Number.isFinite(ms)) serverOffsetMs = ms;
}

/**
 * Best estimate of the server's current time. Used for the correction window so
 * a user cannot extend their own edit window by moving the system clock back.
 */
export function now() {
    return Date.now() + serverOffsetMs;
}

export function monthKey(dateOrMs = now()) {
    const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function dayKey(dateOrMs = now()) {
    const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
    return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
}

export function monthLabel(key) {
    const [y, m] = String(key).split('-').map(Number);
    if (!y || !m) return String(key);
    return new Date(y, m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
}

export function monthShortLabel(key) {
    const [y, m] = String(key).split('-').map(Number);
    if (!y || !m) return String(key);
    return new Date(y, m - 1, 1).toLocaleString('default', { month: 'short', year: '2-digit' });
}

/** Exclusive upper bound: the first millisecond of the month after `key`. */
export function monthEndMs(key) {
    const [y, m] = String(key).split('-').map(Number);
    return new Date(y, m, 1).getTime();
}

export function monthStartMs(key) {
    const [y, m] = String(key).split('-').map(Number);
    return new Date(y, m - 1, 1).getTime();
}

export function nextMonthKey(key) {
    const [y, m] = String(key).split('-').map(Number);
    return monthKey(new Date(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
}

/** Every month key from `from` up to and including `to`. Bounded for safety. */
export function monthRange(from, to, cap = 240) {
    const out = [];
    let cur = from;
    while (cur <= to && out.length < cap) {
        out.push(cur);
        cur = nextMonthKey(cur);
    }
    return out;
}

/** Milliseconds for a transaction document, whatever field shape it carries. */
export function txMillis(tx) {
    if (Number.isFinite(tx?.createdAtMs)) return tx.createdAtMs;
    if (tx?.timestamp?.toMillis) return tx.timestamp.toMillis();
    if (tx?.createdAt?.toMillis) return tx.createdAt.toMillis();
    return 0;
}

export function fmtDateTime(ms) {
    if (!ms) return '-';
    return new Date(ms).toLocaleString();
}

export function fmtDate(ms) {
    if (!ms) return '-';
    return new Date(ms).toLocaleDateString();
}

/** "3 minutes ago" style label, kept deliberately coarse. */
export function relative(ms) {
    if (!ms) return '-';
    const diff = now() - ms;
    const abs = Math.abs(diff);
    const units = [
        [86400000, 'day'], [3600000, 'hour'], [60000, 'minute'], [1000, 'second']
    ];
    for (const [size, name] of units) {
        if (abs >= size) {
            const n = Math.floor(abs / size);
            return diff >= 0 ? `${n} ${name}${n > 1 ? 's' : ''} ago` : `in ${n} ${name}${n > 1 ? 's' : ''}`;
        }
    }
    return 'just now';
}
