/**
 * Budgets, goals, recurring entries, reconciliations and org settings.
 *
 * These are all small, low-write collections with the same shape of CRUD, so
 * they share one module rather than four near-identical ones.
 */
import { db, doc, addDoc, setDoc, updateDoc, deleteDoc, collection, paths, serverTimestamp } from '../core/fb.js';
import { state, isDemo } from '../core/state.js';
import { requireCan } from '../core/rbac.js';
import { now, monthKey, dayKey } from '../core/time.js';
import { toMinor, fmt } from '../core/money.js';
import { logAudit, AUDIT_CATEGORY } from '../data/audit.js';
import { demoWrite, demoUpdate, demoDelete } from './demo.js';
import { ValidationError, createTransaction } from '../data/transactions.js';

async function write(collectionKey, pathFn, payload) {
    if (isDemo()) return demoWrite(collectionKey, payload);
    const ref = await addDoc(collection(db, pathFn(state.session.orgId)), payload);
    return ref.id;
}

async function patch(collectionKey, pathFn, id, update) {
    if (isDemo()) return demoUpdate(collectionKey, id, update);
    return updateDoc(doc(db, `${pathFn(state.session.orgId)}/${id}`), update);
}

async function remove(collectionKey, pathFn, id) {
    if (isDemo()) return demoDelete(collectionKey, id);
    return deleteDoc(doc(db, `${pathFn(state.session.orgId)}/${id}`));
}

/* ------------------------------------------------------------- Budgets */

export async function saveBudget({ id, category, limit }) {
    const denied = requireCan('budget.manage');
    if (denied) throw new ValidationError(denied);

    const limitMinor = Math.abs(toMinor(limit));
    if (!Number.isFinite(limitMinor) || limitMinor <= 0) throw new ValidationError('Set a budget limit above zero.');
    if (!category) throw new ValidationError('Pick a category.');

    const clash = state.budgets.find((b) => b.category === category && b.id !== id);
    if (clash) throw new ValidationError(`There is already a budget for ${category}.`);

    const payload = { category, limitMinor, active: true, updatedAtMs: now(), updatedBy: state.session.email };
    if (id) {
        await patch('budgets', paths.budgets, id, payload);
        await logAudit(`Changed the ${category} budget to ${fmt(limitMinor)}/month`, { category: AUDIT_CATEGORY.GOVERNANCE, targetId: id });
        return id;
    }
    const newId = await write('budgets', paths.budgets, { ...payload, createdAtMs: now() });
    await logAudit(`Set a ${fmt(limitMinor)}/month budget for ${category}`, { category: AUDIT_CATEGORY.GOVERNANCE, targetId: newId });
    return newId;
}

export async function deleteBudget(id) {
    const denied = requireCan('budget.manage');
    if (denied) throw new ValidationError(denied);
    const budget = state.budgets.find((b) => b.id === id);
    await remove('budgets', paths.budgets, id);
    await logAudit(`Removed the ${budget?.category ?? ''} budget`, { category: AUDIT_CATEGORY.GOVERNANCE, targetId: id });
}

/* --------------------------------------------------------------- Goals */

export async function saveGoal({ id, name, target, deadline, note }) {
    const denied = requireCan('goal.manage');
    if (denied) throw new ValidationError(denied);

    const targetMinor = Math.abs(toMinor(target));
    if (!name?.trim()) throw new ValidationError('Give the goal a name.');
    if (!Number.isFinite(targetMinor) || targetMinor <= 0) throw new ValidationError('Set a target above zero.');
    if (deadline && !Number.isFinite(Date.parse(deadline))) throw new ValidationError('That deadline is not a valid date.');

    const payload = {
        name: name.trim().slice(0, 80),
        targetMinor,
        deadline: deadline || null,
        note: (note ?? '').slice(0, 300),
        status: 'active',
        updatedAtMs: now(),
        updatedBy: state.session.email
    };

    if (id) {
        await patch('goals', paths.goals, id, payload);
        await logAudit(`Updated goal "${payload.name}"`, { category: AUDIT_CATEGORY.GOVERNANCE, targetId: id });
        return id;
    }
    const newId = await write('goals', paths.goals, { ...payload, createdAtMs: now() });
    await logAudit(`Created goal "${payload.name}" targeting ${fmt(targetMinor)}`, { category: AUDIT_CATEGORY.GOVERNANCE, targetId: newId });
    return newId;
}

export async function archiveGoal(id) {
    const denied = requireCan('goal.manage');
    if (denied) throw new ValidationError(denied);
    const goal = state.goals.find((g) => g.id === id);
    await patch('goals', paths.goals, id, { status: 'archived', archivedAtMs: now() });
    await logAudit(`Archived goal "${goal?.name ?? id}"`, { category: AUDIT_CATEGORY.GOVERNANCE, targetId: id });
}

/* ----------------------------------------------------------- Recurring */

/**
 * Recurring entries are *templates*, not scheduled jobs. Nothing runs in the
 * background; they materialise the next time someone opens the dashboard on or
 * after their due day. `lastRunMonthKey` is the idempotency key, so opening the
 * app ten times in a day produces exactly one entry.
 */
export async function saveRecurring({ id, label, type, amount, category, dayOfMonth, userId }) {
    const denied = requireCan('recurring.manage');
    if (denied) throw new ValidationError(denied);

    const magnitude = Math.abs(toMinor(amount));
    if (!label?.trim()) throw new ValidationError('Give the recurring entry a label.');
    if (!Number.isFinite(magnitude) || magnitude <= 0) throw new ValidationError('Enter an amount above zero.');
    const day = Math.min(28, Math.max(1, Number(dayOfMonth) || 1));
    // Capped at 28 so it fires in February too - a "31st" rule silently skips
    // seven months a year.

    const payload = {
        label: label.trim().slice(0, 80),
        type,
        amountMinor: type === 'debit' ? -magnitude : magnitude,
        category: category || 'Other',
        userId: type === 'credit' ? (userId || '').toLowerCase() : 'org',
        dayOfMonth: day,
        active: true,
        updatedAtMs: now()
    };

    if (id) {
        await patch('recurring', paths.recurring, id, payload);
        await logAudit(`Updated recurring entry "${payload.label}"`, { category: AUDIT_CATEGORY.GOVERNANCE, targetId: id });
        return id;
    }
    const newId = await write('recurring', paths.recurring, { ...payload, lastRunMonthKey: null, createdAtMs: now() });
    await logAudit(`Created recurring ${type} "${payload.label}" for ${fmt(magnitude)} on day ${day}`, { category: AUDIT_CATEGORY.GOVERNANCE, targetId: newId });
    return newId;
}

export async function toggleRecurring(id, active) {
    const denied = requireCan('recurring.manage');
    if (denied) throw new ValidationError(denied);
    await patch('recurring', paths.recurring, id, { active: Boolean(active) });
    const rec = state.recurring.find((r) => r.id === id);
    await logAudit(`${active ? 'Resumed' : 'Paused'} recurring entry "${rec?.label ?? id}"`, { category: AUDIT_CATEGORY.GOVERNANCE, targetId: id });
}

export async function deleteRecurring(id) {
    const denied = requireCan('recurring.manage');
    if (denied) throw new ValidationError(denied);
    const rec = state.recurring.find((r) => r.id === id);
    await remove('recurring', paths.recurring, id);
    await logAudit(`Deleted recurring entry "${rec?.label ?? id}"`, { category: AUDIT_CATEGORY.GOVERNANCE, targetId: id });
}

export function dueRecurring(atMs = now()) {
    const mk = monthKey(atMs);
    const today = new Date(atMs).getDate();
    return state.recurring.filter(
        (r) => r.active !== false && r.lastRunMonthKey !== mk && today >= (r.dayOfMonth ?? 1)
    );
}

/**
 * Materialise everything due. Each entry goes through the normal
 * `createTransaction` path, so it gets the same correction window, the same
 * month-rollover check and the same audit line as a hand-typed entry.
 */
export async function runDueRecurring() {
    // Silently a no-op for anyone who cannot record transactions - a viewer
    // opening the dashboard should not trigger writes on someone else's behalf.
    if (requireCan('tx.create')) return [];

    const due = dueRecurring();
    const created = [];
    const mk = monthKey();

    for (const rec of due) {
        try {
            const tx = await createTransaction({
                type: rec.type,
                userId: rec.userId,
                amount: Math.abs(rec.amountMinor) / 100,
                category: rec.category,
                reason: rec.label,
                note: 'Created automatically from a recurring entry.',
                effectiveDate: dayKey(),
                tags: ['recurring']
            });
            await patch('recurring', paths.recurring, rec.id, { lastRunMonthKey: mk, lastRunAtMs: now() });
            created.push({ ...rec, txId: tx.id });
        } catch (error) {
            console.error('[recurring] could not materialise ' + rec.id, error);
        }
    }
    return created;
}

/* ----------------------------------------------------- Reconciliations */

/**
 * Record what the bank says against what the ledger says. The difference is
 * stored rather than corrected - a reconciliation is evidence, and silently
 * plugging the gap with an adjustment would destroy the thing being evidenced.
 */
export async function recordReconciliation({ statementBalance, asOf, note }) {
    const denied = requireCan('reconcile.manage');
    if (denied) throw new ValidationError(denied);

    const statementBalanceMinor = toMinor(statementBalance);
    if (!Number.isFinite(statementBalanceMinor)) throw new ValidationError('Enter the balance shown on the statement.');

    const computedBalanceMinor = state.totals.balanceMinor;
    const payload = {
        statementBalanceMinor,
        computedBalanceMinor,
        diffMinor: statementBalanceMinor - computedBalanceMinor,
        asOf: asOf || dayKey(),
        note: (note ?? '').slice(0, 400),
        by: state.session.email,
        createdAtMs: now(),
        createdAt: serverTimestamp()
    };

    const id = await write('reconciliations', paths.reconciliations, payload);
    await logAudit(
        payload.diffMinor === 0
            ? `Reconciled against the bank - balances agree at ${fmt(computedBalanceMinor)}`
            : `Reconciled against the bank - ${fmt(Math.abs(payload.diffMinor))} discrepancy`,
        { category: AUDIT_CATEGORY.MONEY, targetId: id, detail: payload.note }
    );
    return { id, ...payload };
}

/* -------------------------------------------------------------- Settings */

export const DEFAULT_SETTINGS = {
    orgName: 'Treasury',
    currencySymbol: '₦',
    currencyCode: 'NGN',
    locale: 'en-NG',
    correctionWindowMs: 30000,
    approvalThresholdMinor: 0,
    autoSnapshotOnOpen: true,
    idleTimeoutMs: 1800000,
    requireReasonOnDebit: true
};

export async function saveSettings(patchValues) {
    const denied = requireCan('settings.manage');
    if (denied) throw new ValidationError(denied);

    const update = {};
    if (patchValues.orgName !== undefined) update.orgName = String(patchValues.orgName).trim().slice(0, 80);
    if (patchValues.currencySymbol !== undefined) update.currencySymbol = String(patchValues.currencySymbol).trim().slice(0, 4) || '₦';
    if (patchValues.currencyCode !== undefined) update.currencyCode = String(patchValues.currencyCode).trim().toUpperCase().slice(0, 5);
    if (patchValues.locale !== undefined) update.locale = String(patchValues.locale).trim().slice(0, 12);
    if (patchValues.correctionWindowSeconds !== undefined) {
        const seconds = Number(patchValues.correctionWindowSeconds);
        if (!Number.isFinite(seconds) || seconds < 5 || seconds > 300) {
            throw new ValidationError('The correction window must be between 5 and 300 seconds.');
        }
        update.correctionWindowMs = Math.round(seconds * 1000);
    }
    if (patchValues.approvalThreshold !== undefined) {
        update.approvalThresholdMinor = Math.abs(toMinor(patchValues.approvalThreshold) || 0);
    }
    if (patchValues.idleTimeoutMinutes !== undefined) {
        const minutes = Number(patchValues.idleTimeoutMinutes);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
            throw new ValidationError('The idle timeout must be between 1 and 240 minutes.');
        }
        update.idleTimeoutMs = Math.round(minutes * 60000);
    }
    if (patchValues.autoSnapshotOnOpen !== undefined) update.autoSnapshotOnOpen = Boolean(patchValues.autoSnapshotOnOpen);

    update.updatedAtMs = now();
    update.updatedBy = state.session.email;

    if (isDemo()) {
        state.org = { ...state.org, ...update };
    } else {
        await setDoc(doc(db, paths.settings(state.session.orgId)), update, { merge: true });
    }

    await logAudit('Changed organisation settings', {
        category: AUDIT_CATEGORY.GOVERNANCE, detail: Object.keys(update).filter((k) => !k.startsWith('updated')).join(', ')
    });
    return update;
}
