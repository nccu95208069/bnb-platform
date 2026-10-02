# Customer workspaces — onboarding and one-time Sheet import

Status: implemented behind a default-off feature gate; not enabled for public registration or deployed to production by this change.

## Decision and scope

The owner's 2026-10-02 instruction starts implementation of the approved simple booking/onboarding design. The latest decision permits **new customers** to manage native OS bookings; the older Sheet-only system-of-record rule remains applicable to existing customers. This additive slice does not migrate existing owner/member identities, legacy booking sources, or background jobs.

The first working path is `/start` → independent account → property type and rooms → empty calendar → `/w/<slug>/calendar` → manual booking. Account email/password registration is a gated prototype: email verification, password recovery, invitations and credential rotation UI are still required before public release. An email address grants no membership in another workspace.

Implemented:

- Independent customer cookie, signing secret, account store, immutable workspace/property/room/order IDs and unique URL aliases.
- A workspace membership defines role and property scope. All-properties is restricted to that workspace. Existing Sweetfun owner/God cookies confer no customer membership; customer cookies confer no legacy access.
- Atomic workspace/account/slug provisioning and atomic versioned booking writes using Redis compare-and-set. Durable operation keys recover writes whose responses were lost, with body fingerprints to reject conflicting retries. Writes are re-read before success.
- Villa, individual-room and mixed-property setup. The initial villa group includes all configured physical rooms. Pure-villa bookings must occupy the complete group.
- Week room timeline with continuous multi-night bars, date/room prefill, desktop create action, fixed mobile create action and keyboard-accessible modal dialogs.
- One-night visible default, night chips/stepper, multiple room buttons, optional guest name, amount, contact and notes. One booking owns all room assignments and finance once.
- Blank amount is null; explicit zero remains zero. Optional property receipts have kind, amount, actual receipt time, method and actor. No receipt is inferred from the existence of a booking. No customer messages are sent.
- Server-side member/property/role validation, overlap rejection, exclusive checkout boundary, private/no-store responses, same-origin write checks and rate limits. Price-hidden projections omit prices, receipts, notes and contact free text.
- Audit entries on workspace/booking creation. Existing legacy source/API paths are not repurposed to serve customer data.

## Runtime configuration

Use a dedicated staging data namespace and secret for testing:

- `CUSTOMER_WORKSPACES_ENABLED=true` (default off)
- `CUSTOMER_SESSION_SECRET`: independent, randomly generated secret of at least 32 characters
- `CUSTOMER_WORKSPACE_NAMESPACE`: distinct environment namespace (default `bnb:customers:v1`)
- Existing `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_URL`/`KV_REST_API_TOKEN` for server-side storage

Never reuse production data in local tests. Browser verification used a local HTTPS synthetic Redis REST substitute, not a production datastore. Real Redis integration/load testing remains a release requirement. The initial store uses one atomic document per workspace; a 5,000-booking guard is not a claim of load-tested capacity. A future normalized datastore must retain atomic inventory, idempotency and audit semantics.

## Verification

- Service tests: two tenants with identical room names; forged slug/property access; role/property scope; monetary redaction; villa/room conflicts; exclusive checkout; concurrent writes; missing guest/price; multiroom financial totals; invalid dates/precision; stale versions; exact and changed retries; uncertain-write recovery.
- Route tests: register → session → workspace → booking → repeat → read; CSRF rejection; cross-tenant read/write rejection; legacy cookie separation; feature-off behavior; private cache headers.
- Existing owner/member authorization regressions included in the new Node 22 CI job.
- Frontend lint, TypeScript and production build pass. Two pre-existing unused-variable lint warnings remain in calendar views.
- Backend lint/format pass; 166 tests pass, 45 database/environment-dependent tests skipped locally. No Python backend changes.
- Browser: synthetic account registration, mixed-property setup, date-prefilled creation of one two-room/two-night booking with guest and money blank, correct unknown-finance/unnotified detail, and successful reload of the same booking verified against the local synthetic store. A 390×844 viewport also verified the fixed create entry, visible sticky summary/action footer and successful one-night villa creation. The calendar scrolls horizontally without overflowing the page.
- The frontend regression command currently passes 17 tests.

## Remaining approved work

This is the first isolated slice, not completion of the full design:

1. Finish account verification/recovery, staged rollout, workspace invitations/member administration, adding properties, editing room/villa groups and renaming aliases.
2. Persist incomplete onboarding drafts and provide month/day views, editing/cancellation, additional finance actions and ledger views.
3. The one-time Sheet import flow is implemented below for complete-order rows; live Google setup/verification and wider source formats remain pending.
4. Photo evidence, date/year/span confirmation and partial import; OTA sample-based capability validation, unassigned room-type inventory, external alias/replacement events and financial provenance.
5. Controlled Sheet synchronization and optional external inventory execution. Neither native booking creation nor Gmail connection alone may claim external closure.
6. Migration of existing customers only with source contracts, dedicated tests and a rollout plan. Existing two-property constants remain confined to the legacy subsystem.

Before public enablement, complete the account lifecycle and persistent-store integration validation, then merge onto the latest deployed application base. No real guest rows, credentials, email bodies or production exports belong in tests or this document.

## Review fix: deselect rooms after an availability conflict

Changing stay dates or refreshing inventory can make a selected room unavailable. The room button now remains usable solely to remove that selected room; once removed, it is disabled until available again. Creating a booking remains blocked while any selected room conflicts, and the villa button still enforces complete-group availability.

Two React DOM interaction regressions cover date changes and inventory refresh: select room 101, introduce a conflict, choose free room 102, remove 101, and verify the submitted booking contains only 102 with the intended dates. Both scenarios fail against the original code and pass with the fix. The existing 17 authorization/service regressions also pass. CI now accepts pull requests targeting `codex/sweetfun-bots` and includes these DOM tests, so the current stacked PR receives checks.

## Sheet import implementation (follow-up)

The next slice adds `/w/<slug>/import`, linked from the calendar for workspace owners/admins. It remains behind the same default-off customer feature gate. Legacy Sweetfun/OFFLAND sources and credentials remain separate.

Implemented flow:

1. Authorize the customer's Google account with **Sheets read-only** access, paste a private spreadsheet URL/ID, select a tab, and inspect its first rows. The browser receives no Google token. No Drive search/Picker or public sharing is required.
2. Select the header row, map date/room/name/external-ID/amount/received columns, map each room label (including villa labels) to physical rooms, and explicitly confirm one complete order per row and TWD currency. Required dates include a four-digit year. Choose whole-order total or all-selected-rooms nightly amount, and distinguish property receipts from guest payments to platforms. Empty amounts remain unknown. Imported cumulative amounts are source summaries, never fabricated dated payment transactions. Source amount/basis, receipt meaning, spreadsheet/tab/header/column provenance and original row references persist.
3. Create a server-held, immutable, one-hour preview. Include stays still ongoing at the selected start date. Unknown rooms/dates, duplicate source IDs, overlapping rows, prior imports and existing inventory conflicts are blocked with row-level explanations. Users may select only eligible rows and import a subset.
4. Commit the selected rows atomically under workspace CAS. A stable preview/batch ID and selection digest recover lost replies without duplicating orders; changed replay selections are rejected. A stale workspace requires a new preview. All rooms and nights belong to one order with one financial total. Final results are read back.
5. Reload persistent batch history and undo only unchanged bookings. Undo compares booking version and imported content, preserves records/audit, skips changed bookings and reports counts. Repeat undo returns the same result. Cancelled import identities remain deduplicated, so a withdrawn batch is not silently recreated.

### Google setup and data lifecycle

This change does not configure a live Google Cloud OAuth client or complete provider verification. Before live testing, create a dedicated web application OAuth client for customer onboarding, enable Sheets API, and register the exact callback URL. Configure on the server:

- `CUSTOMER_GOOGLE_CLIENT_ID`
- `CUSTOMER_GOOGLE_CLIENT_SECRET`
- `CUSTOMER_GOOGLE_REDIRECT_URI`: `https://<staging-host>/api/customer-google/callback` (HTTP allowed only for localhost tests)
- `CUSTOMER_GOOGLE_TOKEN_KEY`: a separately generated random 32-byte key encoded as base64, distinct from session/legacy secrets

The authorization-code flow uses PKCE, ten-minute single-use state bound to the authenticated account, property/workspace and an HttpOnly/SameSite browser cookie. The callback rechecks membership before token exchange. Access tokens are AES-256-GCM encrypted with tenant/property/account context as authenticated data and expire from storage within one hour; no refresh token/offline access is requested. Connecting again replaces the temporary connection. Source snapshots and previews expire after one hour; durable order provenance, batches and audit remain. Roles/property membership are rechecked for every connection, read, preview, commit and undo. Foreign preview IDs and source snapshots cannot be used across accounts or properties. Hidden-price views also redact imported financial summaries and free-form source identities.

Provider implementation references: [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Sheets metadata](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get), [Sheets values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get). Public access must meet Google's consent/verification requirements for the requested scope.

### Supported boundary and remaining work

- This is a one-time import into native OS properties, not continuous synchronization. The source is never modified. No customer notification, Gmail connection or external inventory closure is performed.
- Current input is TWD, one complete order per row, same dates for all rooms in that order. Nightly/per-room split rows, partial cancellations, row status inference, alternate currencies and mixed date conventions require explicit normalization first; the UI explains this before preview. Repeated external IDs are blocked as a group, not silently combined or multiplied.
- The reader handles at most 501 populated rows and 52 columns, with bounded response/cell sizes; it rejects oversized results rather than truncating rows. The UI explicitly limits mapping to the first 52 columns. It does not treat row number as a durable identity. Exact normalized fingerprints provide a fallback when an external ID is missing; edited/reformatted source records without stable IDs cannot be reconciled automatically.
- Public account verification/recovery, invitations, onboarding draft persistence, photo import and sample-based OTA ingestion remain unfinished. Import currently follows property creation from the calendar; the full four-step onboarding presentation is not complete.
- A real Google consent/Sheets round trip and actual Redis CAS/expiry integration/load checks remain release gates. Synthetic tests do not claim provider or production-datastore verification.

### Follow-up verification

- Added service/Google/storage regressions for ongoing stays, unknown values, multiroom finance, actual vs platform-paid receipts, nightly totals, ambiguous/repeated IDs, safe partial import, cross-account/property/role isolation, stale/concurrent writes, lost-response recovery, content-guarded undo, encrypted short-lived OAuth tokens, PKCE/browser/state binding, denied scope, expired state and TTL command construction.
- API checks cover import CSRF, tenant denial, unavailable Google configuration and sanitized no-store callback failure.
- React DOM test covers real form controls through mapping, blocked rows, subset selection, locked uncertain response, identical retry, completion and undo; previous calendar conflict recovery tests remain included.
- Browser verification used a synthetic Google read response and local synthetic Redis REST substitute with the actual Next.js preview/import/undo APIs. One villa order occupied two rooms for two nights, held one TWD 6,000 total, recorded TWD 1,000 as guest-paid only, survived calendar reload, and was cancelled by guarded undo. Desktop and 390×844 results showed no page overflow or framework error overlay. No real guest or provider data was used.
- GitHub CI was previously unable to start because the repository account was locked for a billing issue. Local checks are reported separately; do not treat that remote failure as a test failure or remote verification success.
- Final local verification for this follow-up: 26 service/API/legacy tests and 4 reported DOM tests pass; lint has zero errors and the same two pre-existing warnings; TypeScript and the webpack production build pass. Python backend was unchanged in this follow-up.

## Service-page onboarding decision

The owner requested a public service introduction and questionnaire with named-user Sheet sharing and specialist consultation emailed to the operator. See [host service page](SERVICE_JOIN_2026-10-02.md) for the implemented `/join` flow, how it differs from customer OAuth import, assumptions, verification and rollout status.
