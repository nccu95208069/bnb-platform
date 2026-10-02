# Customer workspaces — first implementation slice

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
3. Customer-owned Google OAuth + Sheet preview, column/row/financial-semantic mapping, staged batches, deduplication, partial import and guarded undo. No Sheet import button is advertised as functional in this slice.
4. Photo evidence, date/year/span confirmation and partial import; OTA sample-based capability validation, unassigned room-type inventory, external alias/replacement events and financial provenance.
5. Controlled Sheet synchronization and optional external inventory execution. Neither native booking creation nor Gmail connection alone may claim external closure.
6. Migration of existing customers only with source contracts, dedicated tests and a rollout plan. Existing two-property constants remain confined to the legacy subsystem.

Before public enablement, complete the account lifecycle and persistent-store integration validation, then merge onto the latest deployed application base. No real guest rows, credentials, email bodies or production exports belong in tests or this document.

## Review fix: deselect rooms after an availability conflict

Changing stay dates or refreshing inventory can make a selected room unavailable. The room button now remains usable solely to remove that selected room; once removed, it is disabled until available again. Creating a booking remains blocked while any selected room conflicts, and the villa button still enforces complete-group availability.

Two React DOM interaction regressions cover date changes and inventory refresh: select room 101, introduce a conflict, choose free room 102, remove 101, and verify the submitted booking contains only 102 with the intended dates. Both scenarios fail against the original code and pass with the fix. The existing 17 authorization/service regressions also pass. CI now accepts pull requests targeting `codex/sweetfun-bots` and includes these DOM tests, so the current stacked PR receives checks.
