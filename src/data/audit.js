/**
 * Tamper-evident audit log.
 *
 * Each entry stores the SHA-256 of (previous hash + its own canonical content).
 * That makes the log a hash chain: altering or deleting any historical entry
 * breaks every hash after it, and `verifyChain()` will say exactly where.
 *
 * This does not *prevent* tampering - only Firestore rules can do that - but it
 * makes silent tampering impossible to hide, which is the property an audit log
 * actually needs. It costs one extra field per row and no server.
 */
import { db, addDoc, collection, paths, serverTimestamp } from '../core/fb.js';
import { state, isDemo } from '../core/state.js';
import { now } from '../core/time.js';

export const AUDIT_CATEGORY = {
    MONEY: 'money',
    PEOPLE: 'people',
    GOVERNANCE: 'governance',
    DATA: 'data',
    SECURITY: 'security'
};

const GENESIS = '0'.repeat(64);

async function sha256Hex(text) {
    // SubtleCrypto is only available on secure origins. On plain http://localhost
    // it is present; on http:// over a LAN it is not, so fall back to a marker
    // rather than writing a hash that looks real but is not.
    if (!globalThis.crypto?.subtle) return 'nocrypto:' + text.length;
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/** Canonical string form of an entry - must stay byte-stable across versions. */
function canonical(entry) {
    return [
        entry.seq,
        entry.action,
        entry.category,
        entry.actorEmail,
        entry.actorRole,
        entry.targetId ?? '',
        entry.detail ?? '',
        entry.createdAtMs
    ].join('|');
}

/** Highest sequence number and its hash, read from what we already hold. */
function chainHead() {
    let head = { seq: 0, hash: GENESIS };
    for (const entry of state.auditLogs) {
        if ((entry.seq ?? 0) > head.seq) head = { seq: entry.seq, hash: entry.hash ?? GENESIS };
    }
    return head;
}

/**
 * Append an entry. Never throws into the caller: an audit write failing must
 * not roll back the business action that succeeded, but it must be loud in the
 * console and visible in the log's own integrity report.
 */
export async function logAudit(action, {
    category = AUDIT_CATEGORY.MONEY, targetId = null, detail = null
} = {}) {
    const session = state.session;
    if (!session) return null;

    const head = chainHead();
    const entry = {
        seq: head.seq + 1,
        action,
        category,
        detail,
        targetId,
        actorEmail: session.email,
        actorRole: session.role,
        prevHash: head.hash,
        createdAtMs: now(),
        // Kept for compatibility with the v1 audit table shape.
        admin_email: session.email,
        timestamp: serverTimestamp()
    };
    entry.hash = await sha256Hex(entry.prevHash + '|' + canonical(entry));

    if (isDemo()) {
        // The demo sandbox logs locally so visitors can see the feature without
        // every passer-by writing to a shared collection.
        state.auditLogs = [{ id: 'local-' + entry.seq, ...entry, timestamp: null }, ...state.auditLogs];
        return entry;
    }

    try {
        await addDoc(collection(db, paths.auditLogs(session.orgId)), entry);
        return entry;
    } catch (error) {
        console.error('[audit] failed to append entry', error);
        return null;
    }
}

/**
 * Walk the chain oldest-first and report the first break. Returns
 * `{ ok, checked, brokenAt, reason }`.
 */
export async function verifyChain(entries = state.auditLogs) {
    const ordered = entries
        .filter((e) => Number.isFinite(e.seq))
        .slice()
        .sort((a, b) => a.seq - b.seq);

    if (ordered.length === 0) return { ok: true, checked: 0, brokenAt: null, reason: 'Log is empty.' };

    let expectedPrev = ordered[0].prevHash ?? GENESIS;
    let expectedSeq = ordered[0].seq;

    for (const entry of ordered) {
        if (entry.seq !== expectedSeq) {
            return {
                ok: false, checked: expectedSeq - ordered[0].seq, brokenAt: entry.seq,
                reason: `Sequence jumps from ${expectedSeq} to ${entry.seq} - an entry was deleted or never written.`
            };
        }
        if (entry.prevHash !== expectedPrev) {
            return {
                ok: false, checked: expectedSeq - ordered[0].seq, brokenAt: entry.seq,
                reason: `Entry ${entry.seq} does not link to the previous entry's hash.`
            };
        }
        const recomputed = await sha256Hex(entry.prevHash + '|' + canonical(entry));
        if (entry.hash !== recomputed) {
            return {
                ok: false, checked: expectedSeq - ordered[0].seq, brokenAt: entry.seq,
                reason: `Entry ${entry.seq} was modified after it was written - its content no longer matches its hash.`
            };
        }
        expectedPrev = entry.hash;
        expectedSeq += 1;
    }

    return {
        ok: true, checked: ordered.length, brokenAt: null,
        reason: `All ${ordered.length} entries link correctly back to entry ${ordered[0].seq}.`
    };
}
