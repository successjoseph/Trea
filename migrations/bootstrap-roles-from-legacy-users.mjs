/**
 * One-off fix for a gap in the v2 rollout: `firestore.rules` requires an
 * `orgs/{orgId}/roles/{email}` document to exist before granting a signed-in
 * user ANY access at all (read included) -- see `active()`/`can()` in
 * firestore.rules. `backfill-legacy-fields.mjs` backfilled fields on existing
 * documents but never created the roles documents themselves, so once the
 * rules were live, every pre-existing admin was locked out of everything,
 * including collections they used to be able to read fine under v1.
 *
 * This creates exactly one `orgs/{orgId}/roles/{email}` document per person
 * already listed in `users/{email}`, using their existing legacy
 * `{ orgId, role, name }` as the source of truth -- a 1:1 mapping, not a
 * judgment call. `role: "admin"` in the legacy schema maps to `admin` in the
 * new one; nobody is invented or promoted to `owner` who wasn't already one.
 *
 * Idempotent: skips any org/email pair that already has a roles document, so
 * running it again after someone has been properly onboarded through the app
 * is a safe no-op for them.
 *
 * Usage:
 *   node bootstrap-roles-from-legacy-users.mjs             (dry run)
 *   node bootstrap-roles-from-legacy-users.mjs --apply      (writes for real)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEY_PATH = path.join(ROOT, 'trea-pro-firebase-adminsdk-fbsvc-aa00f654de.json');
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

const ROLE_MAP = { owner: 'owner', admin: 'admin', trustee: 'trustee', viewer: 'viewer' };

async function main() {
    console.log(APPLY
        ? 'Running in APPLY mode -- this will write to Firestore.'
        : 'Running in DRY-RUN mode -- no writes will be made. Pass --apply to write for real.');

    const usersSnap = await db.collection('users').get();
    if (usersSnap.empty) {
        console.log('No users/ documents found. Nothing to bootstrap.');
        return;
    }

    const plan = [];
    for (const doc of usersSnap.docs) {
        const email = doc.id;
        const data = doc.data();
        const orgId = data.orgId;
        const role = ROLE_MAP[data.role] ?? 'admin';
        if (!orgId) {
            console.warn(`  skip ${email}: no orgId on their users/ document.`);
            continue;
        }

        const roleRef = db.doc(`orgs/${orgId}/roles/${email}`);
        const existing = await roleRef.get();
        if (existing.exists) {
            console.log(`  skip ${email} (${orgId}): a roles document already exists.`);
            continue;
        }

        plan.push({
            orgId,
            email,
            payload: {
                email,
                name: data.name ?? email,
                role,
                grants: [],
                denies: [],
                status: 'active',
                invitedBy: 'bootstrap-roles-from-legacy-users',
                createdAtMs: Date.now()
            }
        });
    }

    console.log(`\nPlan: ${plan.length} roles document(s) to create.`);
    for (const item of plan) {
        console.log(`  orgs/${item.orgId}/roles/${item.email} -> role: ${item.payload.role}`);
    }

    if (!APPLY) {
        console.log('\nDry run complete. Nothing was written. Re-run with --apply to write these changes.');
        return;
    }

    for (const item of plan) {
        await db.doc(`orgs/${item.orgId}/roles/${item.email}`).set(item.payload);
    }
    console.log(`\nDone. ${plan.length} roles document(s) created.`);
}

main().catch((err) => {
    console.error('\nFailed:', err);
    process.exit(1);
});
