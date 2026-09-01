/**
 * The correction window runtime.
 *
 * Keeps a ticker alive only while at least one entry is still correctable, so
 * an idle dashboard does no work. On each tick it re-renders the pending strip
 * and, as windows expire, writes the matured entries back to `active`.
 */
import { state } from '../core/state.js';
import { emit, on, EVENTS } from '../core/bus.js';
import { STATUS, windowRemainingMs, isCorrectable } from '../data/ledger.js';
import { commitMaturedEntries, correctionWindowMs } from '../data/transactions.js';

let timer = null;

export function pendingEntries() {
    return state.transactions
        .filter((tx) => tx.status === STATUS.PENDING && isCorrectable(tx))
        .sort((a, b) => windowRemainingMs(a) - windowRemainingMs(b));
}

/** Entries whose window has closed but whose stored status has not caught up. */
function maturedEntries() {
    return state.transactions.filter(
        (tx) => tx.status === STATUS.PENDING && !isCorrectable(tx)
    );
}

async function tick() {
    const matured = maturedEntries();
    if (matured.length) {
        // The balance already includes these (status is derived); this write
        // only reconciles the stored flag with the derived truth.
        await commitMaturedEntries();
        emit(EVENTS.TX_CHANGED, state.transactions);
    }

    const live = pendingEntries();
    emit(EVENTS.PENDING_TICK, live);

    if (live.length === 0 && matured.length === 0) stop();
}

export function start() {
    if (timer) return;
    // 250ms keeps a 30-second countdown visibly smooth without being a spinner
    // on the main thread.
    timer = setInterval(tick, 250);
    tick();
}

export function stop() {
    clearInterval(timer);
    timer = null;
}

/** Wake the ticker whenever a new entry appears. */
export function initPendingRuntime() {
    on(EVENTS.TX_CHANGED, () => {
        if (pendingEntries().length || maturedEntries().length) start();
    });
    // A tab restored from bfcache may have slept through several windows.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') tick();
    });
    start();
}

export function windowSeconds() {
    return Math.round(correctionWindowMs() / 1000);
}
