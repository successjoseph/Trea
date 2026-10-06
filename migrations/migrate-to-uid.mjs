/**
 * Move from email-keyed access to uid-keyed access (rules v3).
 *
 * For every legacy role document `orgs/{org}/roles/{email}`:
 *   - find the Firebase Auth account for that email (no account = skipped, and
 *     reported; that person signs up and joins with a passcode later)
 *   - create `orgs/{org}` if missing, owned by the first owner found
 *   - create `orgs/{org}/roles/{uid}` (copy of the legacy document)
 *   - create `users/{uid}` profile and `users/{uid}/memberships/{org}`
 *
 * Additive only. Legacy email-keyed roles and `users/{email}` pointers are left
 * in place; they are removed in a later step, after the new flow is verified.
 * Existing documents are never overwritten (create-if-absent), so re-running is safe.
 *
 * Usage:
 *   node migrate-to-uid.mjs            (dry run, writes nothing but the backup)
 *   node migrate-to-uid.mjs --apply    (writes)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEY_PATH = path.join(ROOT, 'trea-pro-firebase-adminsdk.json');
const APPLY = process.argv.includes('--apply');

let key;
try {
    key = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
} catch {
    console.error(`\nCould not read the service account key at:\n  ${KEY_PATH}\n`);
    process.exit(1);
}

initializeApp({ credential: cert(key) });
const db = getFirestore();
const auth = getAuth();

const ROLE_RANK = { owner: 4, admin: 3, trustee: 2, viewer: 1 };

async function backup() {
    const dump = {};
    for (const col of ['users', 'orgs']) {
        dump[col] = (await db.collection(col).get()).docs.map((d) => ({ id: d.id, data: d.data() }));
    }
    dump.roles = (await db.collectionGroup('roles').get()).docs.map((d) => ({ path: d.ref.path, data: d.data() }));
    const outDir = path.join(ROOT, 'migrations', 'backups');
    mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `pre-uid-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(outPath, JSON.stringify(dump, (_k, v) => (v?.toDate ? v.toDate().toISOString() : v), 2));
    console.log(`Backup written: ${outPath}`);
}

async function uidFor(email) {
    try {
        return (await auth.getUserByEmail(email)).uid;
    } catch {
        return null;
    }
}

async function main() {
    console.log(APPLY ? 'APPLY mode: this will write.' : 'DRY RUN: nothing will be written except the backup.');
    await backup();

    // Legacy role docs are the ones keyed by an email address.
    const legacy = (await db.collectionGroup('roles').get()).docs
        .filter((d) => d.id.includes('@'))
        .map((d) => ({ org: d.ref.parent.parent.id, email: d.id, data: d.data() }));

    const plan = [];
    for (const row of legacy) {
        const uid = await uidFor(row.email);
        if (!uid) {
            console.warn(`  skip ${row.email} (${row.org}): no Firebase Auth account yet. They sign up, then join by passcode.`);
            continue;
        }
        plan.push({ ...row, uid });
    }

    // Owner of each org, for orgs/{org}.createdByUid.
    const ownerOf = {};
    for (const row of plan) {
        if (row.data.role === 'owner' && !ownerOf[row.org]) ownerOf[row.org] = row.uid;
    }

    console.log(`\nPlan: ${plan.length} person(s) to move.`);
    for (const row of plan) {
        console.log(`  ${row.email} -> uid ${row.uid} in ${row.org} as ${row.data.role}`);
    }
    const orgs = [...new Set(plan.map((r) => r.org))];
    for (const org of orgs) {
        const exists = (await db.doc(`orgs/${org}`).get()).exists;
        console.log(`  orgs/${org}: ${exists ? 'exists' : 'will be created'}, owner uid ${ownerOf[org] ?? 'NONE, aborting for this org'}`);
    }

    if (!APPLY) {
        console.log('\nDry run complete. Re-run with --apply to write.');
        return;
    }

    for (const org of orgs) {
        if (!ownerOf[org]) {
            console.error(`Refusing to touch ${org}: it has no owner in the legacy data.`);
            continue;
        }
        const orgRef = db.doc(`orgs/${org}`);
        if (!(await orgRef.get()).exists) {
            await orgRef.set({ name: org, type: 'company', createdByUid: ownerOf[org], createdAtMs: Date.now() });
            console.log(`  created orgs/${org}`);
        }
    }

    let written = 0;
    for (const row of plan) {
        if (!orgs.includes(row.org) || !ownerOf[row.org]) continue;

        const roleRef = db.doc(`orgs/${row.org}/roles/${row.uid}`);
        if (!(await roleRef.get()).exists) {
            await roleRef.set({
                uid: row.uid,
                email: row.email,
                name: row.data.name ?? row.email,
                role: row.data.role,
                grants: row.data.grants ?? [],
                denies: row.data.denies ?? [],
                status: row.data.status ?? 'active',
                invitedBy: row.data.invitedBy ?? 'migrate-to-uid',
                createdAtMs: row.data.createdAtMs ?? Date.now(),
                migratedFrom: row.email
            });
            written++;
        }

        const profileRef = db.doc(`users/${row.uid}`);
        if (!(await profileRef.get()).exists) {
            await profileRef.set({ email: row.email, name: row.data.name ?? row.email, createdAtMs: Date.now() });
        }

        const memberRef = db.doc(`users/${row.uid}/memberships/${row.org}`);
        if (!(await memberRef.get()).exists) {
            await memberRef.set({
                orgId: row.org,
                role: row.data.role,
                status: row.data.status ?? 'active',
                joinedVia: 'legacy',
                joinedAtMs: Date.now()
            });
        }
    }
    console.log(`\nDone. ${written} roles document(s) created. Legacy email-keyed records were left in place.`);
}

main().catch((err) => {
    console.error('\nMigration failed:', err);
    process.exit(1);
});
