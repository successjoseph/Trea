# Trea

![Language](https://img.shields.io/badge/language-JavaScript-yellow)
![Build](https://img.shields.io/badge/build-none-brightgreen)
![Backend](https://img.shields.io/badge/backend-serverless-blue)

## About

Trea is a treasury dashboard for small organisations - a club, a co-operative, a
community fund. It is a static site: no build step, no bundler, no Node server,
no cloud functions and no scheduled jobs. Everything runs in the browser against
Firebase Authentication and Firestore, and the whole thing can be hosted on GitHub
Pages or any static host.

Three ideas hold it together.

**Nothing counts until it is settled.** Every entry is born *pending* and is
excluded from the balance, every chart, every report and every export for a
30-second correction window. Inside that window it can be edited or discarded
outright with no trace on the books, because it never touched them. When the
window closes the entry becomes immutable, and the only way to fix it is a
reversing entry that stays on the record.

**Months seal themselves.** There is no cron job. When a transaction is recorded,
Trea compares its month against the month of the newest existing entry; if they
differ, it seals the intervening month or months *before* the new entry is
applied - so a sealed closing balance never includes the entry that triggered the
seal. The snapshot's document ID is the month key, which makes concurrent seals
idempotent rather than duplicated.

**The browser is not trusted.** Roles and permissions are enforced in
`firestore.rules`; the client-side matrix in `src/core/rbac.js` is a mirror of it
that exists only so buttons can be hidden. Anyone hitting the Firestore REST API
directly gets the same answers.

## Table of Contents

- [About](#about)
- [What it does](#what-it-does)
- [How the correction window works](#how-the-correction-window-works)
- [How month-end sealing works](#how-month-end-sealing-works)
- [Roles and permissions](#roles-and-permissions)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Data model](#data-model)
- [Project layout](#project-layout)
- [Cost and performance](#cost-and-performance)
- [Security](#security)
- [Testing](#testing)
- [Author and license](#author-and-license)

## What it does

**Ledger integrity**
1. 30-second correction window - entries are held out of every total until released.
2. Correct or discard while pending; after release the ledger is append-only.
3. Reversing entries for released mistakes, linked both ways so the pair nets to zero.
4. Automatic month-end sealing, triggered by the first entry of a new month.
5. Gap-filling: months with no activity in between are each sealed with their own correct closing figure.
6. Manual mid-month checkpoints, marked distinctly from auto-sealed months.
7. Integer minor-unit money throughout - no floating-point drift in the balance.
8. Signed amounts with rule-enforced signs, so a debit can never add to the balance.
9. Effective dates separate from entry dates, for cheques that clear late.
10. Data-integrity sweep: mis-signed debits, orphaned credits, undated rows, likely duplicates, snapshots that drifted after a back-dated entry.

**Governance**
11. Four roles - owner, admin, trustee, viewer - with a documented permission matrix.
12. Per-person permission overrides, so one extra capability does not need a new role.
13. Suspend (keeps history attributable) and revoke (removes access) as separate actions.
14. Dual approval: spending over a configurable threshold is held out of the balance until someone *other than the person who recorded it* approves.
15. Tamper-evident audit log - each entry carries the SHA-256 hash of the one before it.
16. One-click chain verification that names the exact entry where the chain breaks.
17. Re-authentication prompt before granting, changing or revoking access.

**Money management**
18. Members with dues schedules, archived rather than deleted once they have history.
19. Arrears report - who has missed which months, and what they owe.
20. Per-member ledgers with running balances, and exportable statements.
21. Category budgets with live utilisation and overspend alerts.
22. Savings goals with progress, deadline tracking and required monthly contribution.
23. Recurring entries that materialise on next open, exactly once per month - no scheduler.
24. Bank reconciliation that records discrepancies as evidence instead of plugging them.

**Insight**
25. KPIs: burn rate, average income, runway, net flow, month-over-month variance.
26. Charts drawn as inline SVG - no charting library, theme-aware, zero runtime.
27. Alert centre derived from live data, so an alert vanishes when its cause is fixed.
28. Full-text search and filtering by type, status, category, member, date and amount, over the local cache.

**Working with the data**
29. Export to multi-sheet Excel, CSV, or a full JSON backup - identical columns in every format.
30. CSV import with a mandatory dry run: per-row errors and warnings, duplicate detection, nothing written until confirmed.

**The app itself**
31. Installable PWA with offline reads via Firestore's persistent cache.
32. Dark mode, a Ctrl-K command palette, single-key navigation, and a fully local demo sandbox.

## How the correction window works

A transaction's *effective* status is derived, never simply read:

| Stored | Condition | Effective | Counted? |
| --- | --- | --- | --- |
| `pending` | now < `releaseAtMs` | pending | no |
| `pending` | now ≥ `releaseAtMs` | active | **yes** |
| any | needs approval, unapproved | held | no |
| `void` | - | void | no |

Deriving rather than trusting the flag is what removes the need for a server. The
balance is correct the instant a window expires, whether or not any client was
online to write the change back. The write-back in `commitMaturedEntries()` only
makes the stored data match what is already true, so `where('status','==','active')`
queries stay usable.

`releaseAtMs` is immutable after creation - enforced in `firestore.rules`, not just
in the client - so nobody can extend their own window or park money outside the
balance. Correcting an entry does not restart its clock.

## How month-end sealing works

```
createTransaction()
  └─ ensureRolloverSnapshots(monthOf(newEntry))     ← runs BEFORE the write
       ├─ every month with activity, earlier than the new entry, not yet sealed
       ├─ closing balance computed from counted entries only
       └─ written to snapshots/{YYYY-MM}            ← ID = month key ⇒ idempotent
  └─ addDoc(transaction)                            ← only now does the balance move
```

In the common case - an entry in the same month as the last one, with earlier
months already sealed - this is a handful of string comparisons and zero database
reads.

`backfillOnOpen()` runs the same idempotent check when the dashboard loads. It is
a safety net for an org that goes quiet across a month boundary; it writes nothing
when there is nothing to seal.

## Roles and permissions

| | Owner | Admin | Trustee | Viewer |
| --- | :-: | :-: | :-: | :-: |
| Record transactions | ✓ | ✓ | | |
| Correct own entries in the window | ✓ | ✓ | | |
| Correct anyone's entries | ✓ | | | |
| Reverse a published transaction | ✓ | ✓ | | |
| Approve over-threshold spending | ✓ | | ✓ | |
| Manage members | ✓ | ✓ | | |
| Budgets, goals, recurring | ✓ | ✓ | | |
| Bank reconciliation | ✓ | | ✓ | |
| Read the audit log | ✓ | ✓ | ✓ | |
| Export / import data | ✓ | ✓ | export only | |
| Manage people and roles | ✓ | | | |
| Organisation settings | ✓ | | | |

Every role can *read* the books - a viewer is meant to see them. Owners can grant
or deny individual permissions on top of a role, and nobody can change their own
role or remove the last owner.

## Prerequisites

- Any static file server. No build tooling, no `npm install`.
- A Firebase project with Google sign-in enabled and Firestore provisioned.
- The CDN dependencies are Firebase v12 (`gstatic.com`), SheetJS `0.18.5`
  (`jsdelivr.net`, pinned with an SRI hash) and Tailwind's Play CDN.

## Installation

```bash
git clone https://github.com/successjoseph/Trea.git
cd Trea
python -m http.server 8000
# open http://localhost:8000
```

Deploy the security rules before letting anyone in:

```bash
firebase deploy --only firestore:rules
```

The service worker registers only over HTTPS, so `localhost` runs without one.

## Configuration

The Firebase web config in `src/core/fb.js` holds public client identifiers, not
secrets - Firebase is designed this way, and hiding the file protects nothing.
Access control comes from `firestore.rules`.

Bootstrapping the first owner has to be done by hand, once, in the Firebase
console - there is deliberately no self-service path to owner:

```
users/{your@email}          → { orgId: "<org>", role: "owner", name: "…" }
orgs/{org}/roles/{your@email} → { email: "…", role: "owner", status: "active" }
```

Everything else - currency, locale, correction-window length, approval threshold,
idle timeout - is editable in **Settings** by an owner.

## Data model

```
users/{email}                     { email, orgId, role, name }
orgs/{org}/meta/settings          { orgName, currencySymbol, currencyCode, locale,
                                    correctionWindowMs, approvalThresholdMinor,
                                    idleTimeoutMs, autoSnapshotOnOpen }
orgs/{org}/roles/{email}          { email, name, role, grants[], denies[], status,
                                    invitedBy, createdAtMs }
orgs/{org}/members/{email}        { email, name, status, duesMonthlyMinor, joinDateMs }
orgs/{org}/transactions/{id}      { type, userId, amountMinor, amount, category, tags[],
                                    reason, source, note, reference,
                                    effectiveDate, monthKey,
                                    status, releaseAtMs, releasedAtMs,
                                    approvalRequired, approvedBy, approvedAtMs,
                                    reversalOfId, reversedById,
                                    createdBy, createdAtMs, createdAt, editCount }
orgs/{org}/snapshots/{YYYY-MM}    { monthKey, monthYear, openingBalanceMinor,
                                    closingBalanceMinor, incomeMinor, creditsMinor,
                                    debitsMinor, netMinor, txCount, auto, generatedBy }
orgs/{org}/audit_logs/{id}        { seq, action, category, detail, targetId,
                                    actorEmail, actorRole, prevHash, hash, createdAtMs }
orgs/{org}/budgets/{id}           { category, limitMinor, active }
orgs/{org}/goals/{id}             { name, targetMinor, deadline, note, status }
orgs/{org}/recurring/{id}         { label, type, amountMinor, category, userId,
                                    dayOfMonth, active, lastRunMonthKey }
orgs/{org}/reconciliations/{id}   { statementBalanceMinor, computedBalanceMinor,
                                    diffMinor, asOf, note, by, createdAtMs }
```

`amount` (major units) is written alongside `amountMinor` so documents created by
v1 and v2 both read correctly. `readAmountMinor()` accepts either shape.

## Project layout

```
index.html            app shell
app.js                entry point: auth, listeners, boot
firestore.rules       the actual security boundary
sw.js                 app-shell cache (same-origin GETs only)
src/core/             fb, state, bus, rbac, money, time, dom
src/data/             ledger (status derivation, totals), transactions, audit, live
src/features/         snapshots, pending, people, records, analytics,
                      exports, importer, search, session, demo
src/ui/               app shell, components, charts, theme, shortcuts, toast, views/
```

The dependency graph is acyclic and enforced: `src/core` depends on nothing,
`src/data` on core, `src/features` on data, `src/ui` on all three.

## Cost and performance

The design targets a Firebase free tier:

- **One listener per collection, ever.** Views read from a shared store; they never
  open their own subscription, so read count does not grow with the number of
  screens.
- **Bounded queries.** The ledger listener caps at 1500 documents and the audit log
  at 300, both newest-first. Older history loads explicitly and on request.
- **Persistent local cache.** Repeat visits and offline use are served from
  IndexedDB rather than the network.
- **Search, filtering and every analytic run locally** over data already held -
  no composite indexes, no extra reads.
- **No charting library.** Charts are inline SVG.
- **Month sealing costs nothing in the common case** - a string comparison, no read.
- **The demo is entirely local**, so public traffic never touches the database.

## Security

See [SECURITY.md](SECURITY.md) for the threat model, the fixes applied in v2, and
the remaining hardening recommendations.

## Testing

No automated test suite yet. The flows verified by hand against the local demo:
pending release into the balance, correction inside the window, discard,
post-window reversal, automatic month sealing and backfill, audit-chain
verification, role granting, and CSV import validation.

The highest-value tests to add first are unit tests for `src/data/ledger.js` and
`src/features/snapshots.js` - both are pure functions over plain arrays, and they
are where a bug would be worth real money.

## Author and license

**Author:** [successjoseph](https://github.com/successjoseph)

**License:** MIT (see `LICENSE`), Copyright (c) 2026 successjoseph.
