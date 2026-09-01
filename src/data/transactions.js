/**
 * Transaction writes.
 *
 * Every path through this module does the same four things in the same order:
 *   1. authorise    - RBAC check, with a reason on failure
 *   2. validate     - reject impossible money before it reaches the database
 *   3. seal months   - run the rollover check so a new month never mixes into
 *                     the previous month's closing figure
 *   4. write + audit - one document, one audit entry
 *
 * New entries are born `pending`, which means they are invisible to every
 * balance, chart and export until their correction window closes. That is the
 * whole point: an entry that can still be edited must never have been counted.
 */
import { db, addDoc, updateDoc, deleteDoc, doc, collection, paths, serverTimestamp } from '../core/fb.js';
import { state, isDemo } from '../core/state.js';
import { can, requireCan } from '../core/rbac.js';
import { now, monthKey, dayKey } from '../core/time.js';
import { toMinor, fmt } from '../core/money.js';
import { STATUS, isCorrectable, effectiveStatus } from './ledger.js';
import { ensureRolloverSnapshots } from '../features/snapshots.js';
import { logAudit, AUDIT_CATEGORY } from './audit.js';
import { demoWrite, demoUpdate, demoDelete } from '../features/demo.js';

export const TX_TYPES = ['credit', 'debit', 'income', 'adjustment'];

export const DEFAULT_CATEGORIES = [
    'Dues', 'Donation', 'Grant', 'Interest', 'Refund',
    'Supplies', 'Events', 'Transport', 'Utilities', 'Stipend',
    'Equipment', 'Fees', 'Welfare', 'Other'
];

/** Correction window length, org-configurable, defaulting to the 30s you asked for. */
export function correctionWindowMs() {
    const configured = Number(state.org?.correctionWindowMs);
    // Clamped: long enough to fix a typo, short enough that the ledger is not
    // perpetually "maybe". Anything over five minutes stops being a correction
    // and starts being an editable ledger.
    if (Number.isFinite(configured)) return Math.min(Math.max(configured, 5000), 300000);
    return 30000;
}

export function approvalThresholdMinor() {
    const configured = Number(state.org?.approvalThresholdMinor);
    return Number.isFinite(configured) && configured > 0 ? configured : 0;
}

class ValidationError extends Error {}

function validate({ type, amountMinor, userId, reason, effectiveDate }) {
    if (!TX_TYPES.includes(type)) throw new ValidationError('Unknown transaction type.');
    if (!Number.isFinite(amountMinor) || amountMinor === 0) throw new ValidationError('Enter an amount greater than zero.');
    if (Math.abs(amountMinor) > 1e13) throw new ValidationError('That amount is implausibly large - check for a stray digit.');
    if (type === 'credit' && !userId) throw new ValidationError('Choose the member this credit belongs to.');
    if (type === 'debit' && !reason) throw new ValidationError('A debit needs a reason.');
    if (effectiveDate) {
        const parsed = Date.parse(effectiveDate + 'T12:00:00');
        if (!Number.isFinite(parsed)) throw new ValidationError('That date is not valid.');
        if (parsed > now() + 86400000) throw new ValidationError('Transactions cannot be dated in the future.');
    }
}

/**
 * Create a transaction.
 *
 * `amount` is accepted in major units (what the user typed); it is converted to
 * signed minor units here. Debits are stored negative so every total is a plain
 * sum with no branching.
 */
export async function createTransaction(input) {
    const denied = requireCan('tx.create');
    if (denied) throw new ValidationError(denied);

    const type = input.type;
    const magnitude = Math.abs(toMinor(input.amount));
    const amountMinor = type === 'debit' ? -magnitude : magnitude;
    const userId = type === 'credit' ? (input.userId || '').trim().toLowerCase() : 'org';
    const effectiveDate = input.effectiveDate || dayKey();

    validate({ type, amountMinor, userId, reason: input.reason, effectiveDate });

    const txMonth = monthKey(Date.parse(effectiveDate + 'T12:00:00'));

    // Step 3 - the rollover. This runs *before* the write, so if this entry is
    // the first of a new month, last month is sealed at its true closing figure.
    const sealed = await ensureRolloverSnapshots(txMonth);

    const threshold = approvalThresholdMinor();
    const approvalRequired = threshold > 0 && Math.abs(amountMinor) >= threshold && amountMinor < 0;

    const payload = {
        type,
        userId,
        amountMinor,
        // v1-compatible mirror in major units, so anything still reading
        // `amount` keeps working.
        amount: amountMinor / 100,
        category: input.category || defaultCategoryFor(type),
        tags: normaliseTags(input.tags),
        reason: (input.reason || '').slice(0, 400),
        source: input.source || null,
        note: (input.note || '').slice(0, 1000),
        reference: (input.reference || '').slice(0, 300),
        effectiveDate,
        monthKey: txMonth,

        status: STATUS.PENDING,
        releaseAtMs: now() + correctionWindowMs(),
        approvalRequired,
        approvedBy: null,
        approvedAtMs: null,

        createdBy: state.session.email,
        createdAtMs: now(),
        createdAt: serverTimestamp(),
        timestamp: serverTimestamp(),
        adminEmail: state.session.email,
        editCount: 0
    };

    const id = isDemo()
        ? demoWrite('transactions', payload)
        : (await addDoc(collection(db, paths.transactions(state.session.orgId)), payload)).id;

    await logAudit(
        `Recorded ${type} of ${fmt(Math.abs(amountMinor))}${userId !== 'org' ? ' for ' + userId : ''}`,
        { category: AUDIT_CATEGORY.MONEY, targetId: id, detail: payload.reason || payload.category }
    );

    return { id, ...payload, sealedMonths: sealed };
}

function defaultCategoryFor(type) {
    if (type === 'credit') return 'Dues';
    if (type === 'income') return 'Donation';
    return 'Other';
}

function normaliseTags(tags) {
    if (!tags) return [];
    const list = Array.isArray(tags) ? tags : String(tags).split(',');
    return list.map((t) => String(t).trim().toLowerCase().slice(0, 24))
        .filter(Boolean)
        .slice(0, 8);
}

/**
 * Correct an entry that is still inside its window.
 *
 * Deliberately strict: outside the window this throws, and no amount of UI
 * state can route around it because the check is on the stored `releaseAtMs`,
 * not on anything the caller passes in.
 */
export async function correctTransaction(id, patch) {
    const tx = state.transactions.find((t) => t.id === id);
    if (!tx) throw new ValidationError('That transaction no longer exists.');

    if (!isCorrectable(tx)) {
        throw new ValidationError('The 30-second correction window has closed. Post a reversing entry instead.');
    }
    const ownEntry = tx.createdBy === state.session.email;
    if (!can(ownEntry ? 'tx.correct' : 'tx.correct.any')) {
        throw new ValidationError(ownEntry
            ? 'Your role cannot correct entries.'
            : 'Only an owner can correct someone else’s entry.');
    }

    const update = {};
    if (patch.amount !== undefined) {
        const magnitude = Math.abs(toMinor(patch.amount));
        const amountMinor = tx.type === 'debit' ? -magnitude : magnitude;
        validate({ type: tx.type, amountMinor, userId: tx.userId, reason: patch.reason ?? tx.reason });
        update.amountMinor = amountMinor;
        update.amount = amountMinor / 100;
    }
    if (patch.reason !== undefined) update.reason = String(patch.reason).slice(0, 400);
    if (patch.category !== undefined) update.category = patch.category;
    if (patch.note !== undefined) update.note = String(patch.note).slice(0, 1000);
    if (patch.reference !== undefined) update.reference = String(patch.reference).slice(0, 300);
    if (patch.userId !== undefined && tx.type === 'credit') update.userId = String(patch.userId).toLowerCase();

    if (Object.keys(update).length === 0) return tx;

    update.editCount = (tx.editCount ?? 0) + 1;
    update.editedBy = state.session.email;
    update.editedAtMs = now();
    // The window is not extended by an edit. Correcting is meant to be a quick
    // fix, not a way to hold an entry out of the balance indefinitely.

    if (isDemo()) demoUpdate('transactions', id, update);
    else await updateDoc(doc(db, paths.transaction(state.session.orgId, id)), update);

    await logAudit(`Corrected pending ${tx.type} before release`, {
        category: AUDIT_CATEGORY.MONEY, targetId: id,
        detail: describeChange(tx, update)
    });

    return { ...tx, ...update };
}

function describeChange(tx, update) {
    const parts = [];
    if (update.amountMinor !== undefined && update.amountMinor !== tx.amountMinor) {
        parts.push(`amount ${fmt(tx.amountMinor)} → ${fmt(update.amountMinor)}`);
    }
    if (update.reason !== undefined && update.reason !== tx.reason) parts.push('reason changed');
    if (update.category !== undefined && update.category !== tx.category) parts.push(`category → ${update.category}`);
    if (update.userId !== undefined && update.userId !== tx.userId) parts.push(`member → ${update.userId}`);
    return parts.join('; ') || 'no material change';
}

/**
 * Discard an entry outright while it is still pending. This is a real delete,
 * and it is safe precisely because a pending entry never reached the balance -
 * there is nothing to unwind and no history to falsify.
 */
export async function discardPending(id) {
    const tx = state.transactions.find((t) => t.id === id);
    if (!tx) return;
    if (!isCorrectable(tx)) {
        throw new ValidationError('Too late to discard - this entry has been released into the balance.');
    }
    const ownEntry = tx.createdBy === state.session.email;
    if (!can(ownEntry ? 'tx.correct' : 'tx.correct.any')) {
        throw new ValidationError('Your role cannot discard this entry.');
    }

    if (isDemo()) demoDelete('transactions', id);
    else await deleteDoc(doc(db, paths.transaction(state.session.orgId, id)));

    await logAudit(`Discarded a pending ${tx.type} of ${fmt(Math.abs(tx.amountMinor ?? 0))} before release`, {
        category: AUDIT_CATEGORY.MONEY, targetId: id, detail: 'Never affected the balance.'
    });
}

/**
 * Flip matured pending entries to `active`.
 *
 * The balance is already correct without this - `effectiveStatus` derives it -
 * so this is purely so the stored data matches the derived truth and so
 * `where('status','==','active')` queries are usable later. Any signed-in
 * client can do it, which is why it is safe to have no server.
 */
export async function commitMaturedEntries() {
    const due = state.transactions.filter(
        (tx) => tx.status === STATUS.PENDING && effectiveStatus(tx) !== STATUS.PENDING
    );
    if (due.length === 0) return 0;

    for (const tx of due) {
        const nextStatus = tx.approvalRequired && !tx.approvedAtMs ? STATUS.HELD : STATUS.ACTIVE;
        const update = { status: nextStatus, releasedAtMs: now() };
        try {
            if (isDemo()) demoUpdate('transactions', tx.id, update);
            else await updateDoc(doc(db, paths.transaction(state.session.orgId, tx.id)), update);
        } catch (error) {
            // Losing this race is harmless: another tab committed it first.
            console.debug('[transactions] commit skipped for ' + tx.id, error?.code);
        }
    }
    return due.length;
}

/**
 * Reverse a released transaction.
 *
 * The original is never edited or deleted - that is what "no more correction"
 * means. Instead an equal and opposite entry is posted, linked both ways, and
 * the pair nets to zero. The history stays honest and the balance still moves.
 */
export async function reverseTransaction(id, reason) {
    const denied = requireCan('tx.void');
    if (denied) throw new ValidationError(denied);

    const tx = state.transactions.find((t) => t.id === id);
    if (!tx) throw new ValidationError('That transaction no longer exists.');
    if (tx.reversedById) throw new ValidationError('This entry has already been reversed.');
    if (isCorrectable(tx)) throw new ValidationError('This entry is still correctable - edit it instead of reversing it.');
    if (tx.reversalOfId) throw new ValidationError('You cannot reverse a reversal.');
    if (!reason) throw new ValidationError('A reversal needs a reason.');

    const original = Number(tx.amountMinor ?? Math.round((tx.amount ?? 0) * 100));
    const txMonth = monthKey();
    await ensureRolloverSnapshots(txMonth);

    const payload = {
        type: 'adjustment',
        userId: tx.userId,
        amountMinor: -original,
        amount: -original / 100,
        category: tx.category || 'Other',
        tags: ['reversal'],
        reason: `Reversal: ${String(reason).slice(0, 300)}`,
        reversalOfId: id,
        effectiveDate: dayKey(),
        monthKey: txMonth,
        status: STATUS.PENDING,
        releaseAtMs: now() + correctionWindowMs(),
        approvalRequired: false,
        createdBy: state.session.email,
        createdAtMs: now(),
        createdAt: serverTimestamp(),
        timestamp: serverTimestamp(),
        adminEmail: state.session.email,
        editCount: 0
    };

    const newId = isDemo()
        ? demoWrite('transactions', payload)
        : (await addDoc(collection(db, paths.transactions(state.session.orgId)), payload)).id;

    const backlink = { reversedById: newId, reversedAtMs: now(), reversedBy: state.session.email };
    if (isDemo()) demoUpdate('transactions', id, backlink);
    else await updateDoc(doc(db, paths.transaction(state.session.orgId, id)), backlink);

    await logAudit(`Reversed ${fmt(Math.abs(original))} - ${reason}`, {
        category: AUDIT_CATEGORY.MONEY, targetId: id, detail: 'Reversal entry ' + newId
    });

    return { id: newId, ...payload };
}

/** Approve a transaction held above the org's approval threshold. */
export async function approveTransaction(id) {
    const denied = requireCan('tx.approve');
    if (denied) throw new ValidationError(denied);

    const tx = state.transactions.find((t) => t.id === id);
    if (!tx) throw new ValidationError('That transaction no longer exists.');
    if (!tx.approvalRequired) throw new ValidationError('This entry does not need approval.');
    if (tx.approvedAtMs) throw new ValidationError('Already approved.');
    if (tx.createdBy === state.session.email) {
        // Separation of duties: the point of a threshold is a second pair of
        // eyes, and self-approval defeats it entirely.
        throw new ValidationError('You cannot approve an entry you recorded yourself.');
    }

    const update = {
        approvedBy: state.session.email,
        approvedAtMs: now(),
        status: isCorrectable(tx) ? STATUS.PENDING : STATUS.ACTIVE
    };
    if (isDemo()) demoUpdate('transactions', id, update);
    else await updateDoc(doc(db, paths.transaction(state.session.orgId, id)), update);

    await logAudit(`Approved ${fmt(Math.abs(tx.amountMinor ?? 0))} spend`, {
        category: AUDIT_CATEGORY.GOVERNANCE, targetId: id, detail: tx.reason
    });
}

export { ValidationError };
