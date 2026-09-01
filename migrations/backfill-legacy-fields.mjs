/**
 * One-off backfill for documents written before this app had a
 * `createdAtMs` / `monthKey` / `amountMinor` schema.
 *
 * This does NOT fix the "missing data" bug -- that was a client-side query
 * bug (src/data/live.js), already fixed, and needs no data changes at all.
 * What this script fixes is narrower: legacy snapshot documents have a random
 * Firestore auto-ID instead of a `monthKey`-based one, so the app's month-seal
 * idempotency check ("has this month already been sealed?") can't recognize
 * them and could reseal a month you already snapshotted under v1. Backfilling
 * `createdAtMs` on old transactions and audit log entries is included too, for
 * the explicit paged "load older history" query (loadOlderTransactions),
 * which -- unlike the live listener -- does need server-side ordering to page
 * correctly.
 *
 * Every write here is `merge: true` and only ever ADDS a field that is
 * currently absent. Nothing is deleted, overwritten, or renumbered. In
 * particular this never touches `seq`, `hash`, or `prevHash` on audit log
 * entries -- splicing old entries into the hash chain would mean recomputing
 * every hash after them, which is a materially bigger, riskier operation and
 * a separate decision.
 *
 * Usage:
 *   npm install                                   (once)
 *   node backfill-legacy-fields.mjs                (dry run -- no writes)
 *   node backfill-legacy-fields.mjs --apply        (writes for real)
 *   node backfill-legacy-fields.mjs --org=myOrgId  (scope to one org)
 *
 * A full JSON backup of every affected org's transactions, audit_logs,
 * snapshots and members is written to migrations/backups/ before anything
 * else happens, dry run or not.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEY_PATH = path.join(ROOT, 'trea-pro-firebase-adminsdk-fbsvc-aa00f654de.json');

const APPLY = process.argv.includes('--apply');
const ONLY_ORG = process.argv.find((a) => a.startsWith('--org='))?.split('=')[1] ?? null;

function fail(message) {
    console.error('\n' + message + '\n');
    process.exit(1);
}

let key;
try {
    key = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
} catch {
    fail(
        'Could not read the service account key at:\n  ' + KEY_PATH +
        '\n\nDownload one from Firebase Console > Project Settings > Service Accounts > ' +
        'Generate new private key, save it there with that exact filename, and re-run.'
    );
}

initializeApp({ credential: cert(key) });
const db = getFirestore();

const MONTHS = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
];

function monthKeyFromMonthYear(monthYear) {
    if (typeof monthYear !== 'string') return null;
    const m = monthYear.trim().toLowerCase().match(/^([a-z]+)\s+(\d{4})$/);
    if (!m) return null;
    const idx = MONTHS.indexOf(m[1]);
    if (idx === -1) return null;
    return `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
}

function millisFromTimestamp(ts) {
    if (ts?.toMillis) return ts.toMillis();
    if (typeof ts?._seconds === 'number') return ts._seconds * 1000;
    return null;
}

function monthKeyFromTimestamp(ts) {
    const ms = millisFromTimestamp(ts);
    if (!ms) return null;
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * `orgs/{orgId}` parent documents are never explicitly written by this app --
 * only their subcollections (`orgs/{orgId}/transactions`, etc.) are. That is
 * completely valid Firestore, but it means a plain `orgs` collection listing
 * returns nothing even when real data exists underneath. Org IDs are instead
 * discovered from the parent of whatever documents collection-group queries
 * actually find.
 *
 * `demo_org` is excluded by default: it is leftover data from the old public,
 * unauthenticated "Try Live Demo" (see SECURITY.md 1.2), not a real
 * organisation's records, and the current app never reads or writes it since
 * the demo now runs entirely client-side. Pass --org=demo_org explicitly if
 * you ever want it included anyway.
 */
async function discoverOrgs() {
    if (ONLY_ORG) return [ONLY_ORG];

    const ids = new Set();
    const explicit = await db.collection('orgs').get();
    explicit.docs.forEach((d) => ids.add(d.id));

    for (const name of ['transactions', 'members', 'audit_logs', 'snapshots']) {
        const snap = await db.collectionGroup(name).get();
        snap.docs.forEach((d) => {
            const orgId = d.ref.parent.parent?.id;
            if (orgId) ids.add(orgId);
        });
    }

    ids.delete('demo_org');
    return [...ids];
}

async function backup(orgIds) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dump = {};
    for (const orgId of orgIds) {
        dump[orgId] = {};
        for (const col of ['transactions', 'audit_logs', 'snapshots', 'members']) {
            const snap = await db.collection(`orgs/${orgId}/${col}`).get();
            dump[orgId][col] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        }
    }
    const outDir = path.join(ROOT, 'migrations', 'backups');
    mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `backup-${stamp}.json`);
    writeFileSync(outPath, JSON.stringify(dump, (_key, v) => (v?.toDate ? v.toDate().toISOString() : v), 2));
    console.log(`Backup written: ${outPath}`);
}

async function buildPlan(orgIds) {
    const plan = { snapshots: [], transactions: [], auditLogs: [] };

    for (const orgId of orgIds) {
        const snapSnap = await db.collection(`orgs/${orgId}/snapshots`).get();
        for (const doc of snapSnap.docs) {
            const data = doc.data();
            if (typeof data.monthKey === 'string' && /^\d{4}-\d{2}$/.test(data.monthKey)) continue;
            const derived = monthKeyFromMonthYear(data.monthYear) ?? monthKeyFromTimestamp(data.timestamp);
            if (!derived) {
                console.warn(`  [snapshots] ${orgId}/${doc.id}: could not derive a monthKey (monthYear="${data.monthYear}"), skipping.`);
                continue;
            }
            const update = { monthKey: derived };
            if (typeof data.closingBalanceMinor !== 'number' && typeof data.total_balance === 'number') {
                update.closingBalanceMinor = Math.round(data.total_balance * 100);
            }
            plan.snapshots.push({ orgId, id: doc.id, update });
        }

        const txSnap = await db.collection(`orgs/${orgId}/transactions`).get();
        for (const doc of txSnap.docs) {
            const data = doc.data();
            const update = {};
            const ms = millisFromTimestamp(data.timestamp) ?? millisFromTimestamp(data.createdAt);
            if (typeof data.createdAtMs !== 'number' && ms) update.createdAtMs = ms;
            if ((typeof data.monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(data.monthKey)) && ms) {
                update.monthKey = monthKeyFromTimestamp(data.timestamp ?? data.createdAt);
            }
            if (typeof data.amountMinor !== 'number' && typeof data.amount === 'number') {
                update.amountMinor = Math.round(data.amount * 100);
            }
            if (!data.status) {
                // Every pre-v2 document was written and immediately final --
                // there was no correction window then, so these are
                // unambiguously already settled.
                update.status = 'active';
            }
            if (Object.keys(update).length === 0) continue;
            plan.transactions.push({ orgId, id: doc.id, update });
        }

        const auditSnap = await db.collection(`orgs/${orgId}/audit_logs`).get();
        for (const doc of auditSnap.docs) {
            const data = doc.data();
            if (typeof data.createdAtMs === 'number') continue;
            const ms = millisFromTimestamp(data.timestamp);
            if (!ms) continue;
            plan.auditLogs.push({ orgId, id: doc.id, update: { createdAtMs: ms } });
        }
    }

    return plan;
}

function printPlan(plan) {
    console.log('\nPlan:');
    console.log(`  snapshots:    ${plan.snapshots.length} document(s) to update`);
    console.log(`  transactions: ${plan.transactions.length} document(s) to update`);
    console.log(`  audit_logs:   ${plan.auditLogs.length} document(s) to update`);

    const sample = (arr, n = 5) => arr.slice(0, n).forEach((x) =>
        console.log(`    ${x.orgId}/${x.id}: ${JSON.stringify(x.update)}`));

    if (plan.snapshots.length) { console.log('\n  snapshot samples:'); sample(plan.snapshots); }
    if (plan.transactions.length) { console.log('\n  transaction samples:'); sample(plan.transactions); }
    if (plan.auditLogs.length) { console.log('\n  audit log samples:'); sample(plan.auditLogs); }
}

async function apply(plan) {
    let written = 0;
    for (const [col, items] of [
        ['snapshots', plan.snapshots],
        ['transactions', plan.transactions],
        ['audit_logs', plan.auditLogs]
    ]) {
        for (let i = 0; i < items.length; i += 400) {
            const batch = db.batch();
            for (const item of items.slice(i, i + 400)) {
                batch.set(db.doc(`orgs/${item.orgId}/${col}/${item.id}`), item.update, { merge: true });
            }
            await batch.commit();
            written += Math.min(400, items.length - i);
        }
    }
    return written;
}

async function main() {
    console.log(APPLY
        ? 'Running in APPLY mode -- this will write to Firestore.'
        : 'Running in DRY-RUN mode -- no writes will be made. Pass --apply to write for real.');

    const orgIds = await discoverOrgs();
    if (orgIds.length === 0) fail('No orgs found under orgs/. Nothing to migrate.');
    console.log(`Orgs: ${orgIds.join(', ')}`);

    await backup(orgIds);

    const plan = await buildPlan(orgIds);
    printPlan(plan);

    if (!APPLY) {
        console.log('\nDry run complete. Nothing was written. Re-run with --apply to write these changes.');
        return;
    }

    console.log('\nApplying...');
    const written = await apply(plan);
    console.log(`\nDone. ${written} document(s) updated. Every write was an additive merge -- no existing field was removed or changed.`);
}

main().catch((err) => {
    console.error('\nMigration failed:', err);
    process.exit(1);
});
