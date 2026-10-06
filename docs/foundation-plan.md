# Foundation plan: sign-up, passcodes, memberships, org switching

Status: proposed, awaiting review. No code written yet.

## Decisions made

| Topic | Decision |
|---|---|
| Frontend | React with Vite (TypeScript optional, to decide at build time) |
| Auth | Firebase Auth: email/password and Google. Email verification is required. |
| Backend | None. No server, no Cloud Functions in this phase. |
| Hosting | Static hosting (Firebase Hosting or GitHub Pages). Free tier. |
| Plan | Firebase Spark (free). No Blaze needed for this phase. |
| Joining an org | One-time passcode, 10 characters, created by an owner or admin |
| Passcode lifetime | 35 minutes from creation, or until used, whichever comes first |
| Passcode binding | Every passcode is bound to one email address |
| Role ceiling | A creator can only issue roles strictly below their own |
| Statement reading | In the browser: pdf.js for digital PDFs, Tesseract.js for scans. Both vendored locally. |
| Mail | Deferred. Firebase Auth sends verification and password-reset mail itself. Custom mail (Gmail app password behind a Cloud Function) is a later phase and needs Blaze. |
| AI features | Deferred. |

## Role ceiling

"Below yours" means strictly lower:

- Owner can issue `admin`, `trustee`, `viewer`. Not `owner`.
- Admin can issue `trustee`, `viewer`. Not `admin` or `owner`.
- Trustee and viewer cannot issue passcodes.

Ownership is only created by bootstrap (org creation) or by an owner transferring it, which is out of scope here.

## Identity model

- Users are keyed by Firebase `uid`, not email. Email can change and is not a safe document key.
- A user's email is read from the verified token (`request.auth.token.email`), and `email_verified` must be `true` for any join or org action.

## Data model (new and changed)

- `users/{uid}`: profile only (name, email, created time). Written by the user for themselves.
- `users/{uid}/memberships/{orgId}`: one per org the user belongs to. Fields: `orgId`, `role`, `status` (`active` or `suspended`), `joinedAtMs`, `joinedVia` (`create` or `passcode`).
- `orgs/{orgId}`: org metadata (name, type: `personal` or `company`, createdBy uid, createdAtMs).
- `orgs/{orgId}/roles/{uid}`: role for this org, keyed by uid. Replaces the email-keyed roles from the current build. Mirrors the membership document.
- `passcodes/{sha256(code)}`: one document per passcode. Fields: `orgId`, `role`, `boundEmail`, `createdByUid`, `createdAtMs`, `expiresAtMs` (creation + 35 min), `status` (`pending`, `used`, `revoked`), `usedByUid`, `usedAtMs`.

The passcode is stored only as a hash. The raw code is shown to the creator once and never stored.

## Passcode flow

1. An owner or admin opens **Members > Invite**, enters the email to bind, picks a role below their own, and clicks **Generate**.
2. The app generates 10 characters with `crypto.getRandomValues`, from a 32-character set with look-alikes removed: no I, L, O or 1 (0 is kept, since O is already excluded). It shows the code as two groups of five, for example `K7Q2D-9XM4T`.
3. The app computes SHA-256 of the normalized code (uppercase, no spaces or dashes) and writes the `passcodes` document with the expiry set to now + 35 minutes.
4. The creator copies the code and sends it themselves.
5. The recipient signs up or signs in, verifies their email, and enters the code.
6. The app hashes the input, reads the document, and redeems it in one transaction. The rules allow the redemption only if all of these hold:
   - `status` is `pending`
   - `request.time` is before `expiresAtMs`
   - the signed-in email equals `boundEmail` and `email_verified` is true
   - `role` is strictly below the creator's role (checked against the creator's roles document)
   - the transaction also sets `status` to `used`, creates `memberships/{orgId}` and `roles/{uid}`
7. The app routes the user into the org.

Two people racing on one code cannot both win, because the transaction checks `status` at commit.

Expired or used codes show one message: "This code is no longer valid. Ask for a new one."

## Brute force and abuse

- The keyspace is about 32^10, around 2^50. Guessing is not practical.
- Guessing requires a signed-in, verified account, and the free plan's daily read quota limits total attempts across the project.
- Owners see every passcode's status and can revoke a pending one.

## Org switching

- The header shows an org switcher listing every `memberships` document with `status: active`.
- Choosing an org sets `activeOrgId`, tears down the live listeners for the previous org, and attaches new ones.
- Access is checked per org through `orgs/{orgId}/roles/{uid}`, so holding a role in two orgs gives access to both, and the switcher lets the user reach either one.
- The current single `users/{email}.orgId` pointer is retired.

## Sign-up and sign-in pages

- Sign-up: email and password, or Google. After sign-up, Firebase sends the verification email.
- A verified user with no memberships lands on a "Join or create" screen:
  - **Enter a passcode**, or
  - **Create an org**: choose `personal` (org of one, the user is owner) or `company`.
- Creating an org writes the `orgs` document, the owner membership, and the owner role in one batch. The rule allows this only when the org ID is new and the role is `owner` for the signer.

## Migration from the current build

1. Create a `users/{uid}` profile and memberships for each existing person. Match `users/{email}` records to Firebase Auth accounts by email.
2. Create `orgs/{orgId}/roles/{uid}` from the existing email-keyed role documents, after each account exists.
3. Keep the old email-keyed roles until every active user has signed in once, then remove them.
4. Back up with the existing backup script before any write, as with the earlier migrations.

## Client-side changes

- `resolveAccess` changes from one `users/{email}` lookup to a memberships read plus an active-org choice.
- `live.js` listeners already sort client-side and do not depend on the org choice, so they keep working once the active org is passed in.
- Offline statement reading: vendor `pdf.js` and `tesseract.js` under `vendor/`, and point Tesseract's worker, core, and language data at local paths so no request leaves the site. Check the network tab to confirm.

## Out of scope for this phase

- Custom email sending (needs Blaze and a Cloud Function)
- AI features
- Hosting upgrades (WhoGoHost, Hugging Face)
- Org transfer and ownership handover

## Open items

- Whether TypeScript is used for the React rewrite.
- Whether the existing Thrivers Trybe org gets an owner through the new flow, or stays admin-only until a decision is made.
- Whether `demo_org` leftover data is deleted or kept.
