# Trea

![Language](https://img.shields.io/badge/language-JavaScript-yellow)

## About

Trea ("Treasury Admin Dashboard") is a single-page web app for managing a small organization's (e.g. a club, community, or trybe) shared finances. Admins sign in with Google via Firebase Authentication, and access is gated by a Firestore lookup: only users with a `users/{email}` document whose `role` is `"admin"` and who have an `orgId` assigned are let into the dashboard, which is scoped per-organization (`orgs/{orgId}/...` in Firestore). From there, admins can add members, record credit/debit/income transactions in Naira (₦), view live totals (balance, income, debits, member count), save monthly balance "snapshots," review a running audit log of admin actions, and export all transactions to an Excel file via SheetJS. A "Try Live Demo" button lets a visitor explore a shared `demo_org` sandbox without logging in, with a rolling-20-transaction cap enforced only for that demo org so it doesn't grow unbounded. This reads as a real, small-scale community treasury tool rather than a tutorial project.

## Table of Contents

- [About](#about)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Data Model](#data-model)
- [Testing](#testing)
- [Author and License](#author-and-license)

## Prerequisites

- Any static file server or browser — no build tooling; the app loads the Firebase v12 modular SDK and SheetJS (`xlsx@0.18.5`) directly from CDNs (`gstatic.com`, `cdn.jsdelivr.net`) and Tailwind CSS via the Play CDN
- A Firebase project with Google sign-in enabled (Authentication) and Firestore, with `users` and `orgs` collections structured as described below
- Firestore security rules that actually enforce the admin/org access checks the client performs (the client-side checks in `app.js` are a UX gate, not a substitute for server-side Firestore rules)

## Installation

```bash
git clone https://github.com/successjoseph/Trea.git
cd Trea
python -m http.server 8000
# open http://localhost:8000
```

## Configuration

The Firebase Web SDK config (`apiKey`, `authDomain`, `projectId: "trea-pro"`, etc.) is hardcoded directly in `app.js` — these are public client identifiers by Firebase's design; real access control must come from Firestore security rules, not from hiding this file. There is no `.env` file or other configuration.

## Usage

Open `index.html` in a browser (served statically, e.g. via `python -m http.server`). From the landing screen:
- **Login with Google** — only shown/functional for accounts that resolve to an admin Firestore doc; non-admins see "You are not an admin. Please exit the software."
- **Try Live Demo** — enters a shared `demo_org` sandbox instantly, no auth required, useful for showcasing the dashboard

Inside the dashboard (sidebar navigation): **Overview** (total balance, income, debits, member count, and saved monthly snapshots), **Members** (add a member by email/name, click any member to see their individual transaction ledger), **Transactions** (record a Credit against a specific member, an org-wide Debit with a reason, or Income from a donation/interest/gift/other source), and **Audit Log** (chronological record of every admin action). The header's **Export Excel** button downloads all current transactions as an `.xlsx` file named `<orgId>_Treasury_Export.xlsx`. Sessions auto-expire and sign the admin out after 1 hour of mouse/keyboard inactivity.

## Data Model

Inferred from the Firestore calls in `app.js` (no schema file is committed — this is the de facto structure the client code depends on):

- `users/{email}` — `{ role: "admin" | ..., orgId, name }`
- `orgs/{orgId}/members/{email}` — `{ name, role: "member", joinDate }`
- `orgs/{orgId}/transactions/{id}` — `{ userId, amount, type: "credit"|"debit"|"income", reason?, source?, timestamp, adminEmail }` (debits are stored with a negative `amount` so totals sum naturally)
- `orgs/{orgId}/audit_logs/{id}` — `{ action, admin_email, timestamp }`
- `orgs/{orgId}/snapshots/{id}` — `{ monthYear, total_balance, timestamp, adminEmail }`

## Testing

No automated tests are currently included.

## Contributing

This is a personal project built for a specific organization's use; the notes above are intended as reference for future work on it.

## Author and License

**Author:** [successjoseph](https://github.com/successjoseph)

**License:** MIT License (see `LICENSE`), Copyright (c) 2026 successjoseph.
