# Isolated payment Golden Workflow

The payment pilot persists orders, payments, Missions, and Tool history in PostgreSQL. It completes `check_order → update_order(record_payment) → check_order` with database authorization, idempotency, version checks, confirmation, blocking investigation, and final verification.

**Scope agreed on 2026-09-05:** continue in the current task and complete isolated tests. The owner has not confirmed a production `DB_Payments` or stable Sheet order identifier. This pilot does not authorize a source-of-truth migration or production Sheet writes. All fixtures are synthetic; the private workbook and screenshots are not imported.

## Storage and source boundary

Backend Alembic revision `008` creates the private `payment_workflow` schema after `007`. It does not modify `bookings`, `stay_unit`, the existing Supabase workspace migrations, or the current calendar.

| Table | Purpose |
|---|---|
| `property_state` | Explicit tenant/property, source kind, write switch, AI direct-modification switch |
| `orders` | Single-room, full-stay snapshot with official scoped ID, amount, expected deposit, version and freshness |
| `payments` | Multiple append-only receipts with actual receipt time, operator, Mission, Step, idempotency key and reconciliation state |
| `missions` | Original goal and immutable request, refined criteria, progress, confirmation, dependency, write evidence and verification outcome |
| `tool_executions` | Ordered append-only Tool inputs/results; records pre-write state, result, confirmation identity and final verification |

All references between pilot tables include tenant and property. Payment keys are unique per tenant/property, with an additional unique payment per payment Mission. Totals derive from the ledger; there is no independently mutable `paid_amount` cache. Refunds and reversals require a future explicit append-only design; this pilot exposes neither deletion nor refund operations.

The backend requires existing `public.property`, `workspace_member`, and `workspace_member_property` tables. It re-reads the active membership and property relationship on every operation, after obtaining the property transaction lock. It does not use the legacy service-role owner shortcut or test-environment authorization fallback.

The schema has RLS enabled on all five tables and no client grants or policies. `PUBLIC`, `anon`, `authenticated`, and `service_role` receive no direct schema/table access. The backend database connection must be a trusted schema owner or administrative connection; this is a deliberately closed backend boundary, not a public Supabase RPC. A future dedicated runtime database role and production isolation review remain deployment prerequisites.

This follows the combination of [schema/table grants and RLS](https://supabase.com/docs/guides/database/postgres/row-level-security). [Transaction-scoped advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS) serialize each property's Tool work and release on commit or rollback. Any future importer/connector must follow the same lock and version discipline. Arbitrary external database writers are not a supported concurrency path.

## Enabling only the isolated pilot

The default is `PAYMENT_WORKFLOW_ENABLED=false`. Testing additionally requires:

- `APP_ENV=test` or `development`; production cannot execute the sandbox source.
- A trusted, deliberately provisioned `property_state` with `source_kind='sandbox'`.
- `writes_enabled=true` for payment writes.
- Synthetic order snapshots checked within five minutes. Future freshness timestamps beyond five seconds are rejected.

`disabled`, `google_sheet`, missing configuration, stale snapshots, or a production environment yield `source_unavailable`; there is no fallback from a real Sheet to seed data. The existing legacy Sheet reader is not reused by these Tools.

The pilot uses positive **whole TWD** amounts up to 999,999,999. It rejects floats, numeric strings, negative/zero amounts, other currencies, timezone-free receipt timestamps, refunds and OTA payouts. Supported pilot methods are `cash`, `bank_transfer`, and `card`; types are `deposit`, `balance`, and `payment`. These are bounded implementation choices for isolated testing, not approved production accounting semantics.

## API and payment Playbook v1

Base path:

```text
/api/v1/tenants/{tenant_id}/properties/{property_id}/payment-workflow
```

Supply a verified Supabase user bearer token with an `authenticated` role/audience, valid UUID subject, and configured issuer. Authorization comes from current database membership, not client-supplied roles.

1. Parse the instruction into `CreatePaymentMission`; preserve the original goal, receipt time and amount. Use a stable idempotency key across retries. `POST /missions` creates the durable Mission without executing payment.
2. `POST /missions/{id}/advance` performs the initial `check_order` and persists its result. Compare the resolved stay/room/guest and amount with the owner's intent.
3. If clarification is needed, collect the minimum missing criterion and call `POST /missions/{id}/clarify`. It may only narrow the original query; it cannot change a supplied criterion or the original payment payload. The next advance rechecks.
4. If `confirmation_required=true`, show the actual order/payment to the authorized operator and wait. `POST /missions/{id}/confirm` binds approval to `expected_version` after a fresh query. The Agent must never call this merely to get past the gate. AI direct modification defaults off; an unexpected deposit amount always requires confirmation in this pilot.
5. Advance again or call the explicit controlled `POST /tools/update_order`. It must match the persisted Mission's order, amount, time, key and checked version. The Tool rechecks the original criteria, detects new overlaps and unversioned changes, validates order state, balance and receipt time, then commits the ledger, version increment, Step audit and `verification_pending` state atomically.
6. Advance once more to execute final `check_order(order_id)`. Completion requires the specific receipt, amount, currency, type, method, receipt time, note, original stay identity, version, total, paid amount, balance and status to match. Only `status=completed` with `result.status=verified` means success, and only within the isolated sandbox.

A synthetic creation request:

```json
{
  "goal": "Record the synthetic booking deposit",
  "query": {"order_id": "synthetic-order-1"},
  "idempotency_key": "synthetic-instruction-1",
  "payment": {
    "amount": 2000,
    "currency": "TWD",
    "payment_type": "deposit",
    "payment_method": "bank_transfer",
    "received_at": "2026-09-05T10:00:00+08:00",
    "note": "Synthetic test receipt"
  }
}
```

The explicit write Tool uses `mission_id`, `order_id`, `operation='record_payment'`, `expected_version`, `idempotency_key`, and `payload` containing that same payment. Calling it before the persisted check is rejected. Replaying an identical command returns `tool_result.status=duplicate_operation` and the existing payment ID, without completing pending verification. Reusing a Mission key with different original content returns HTTP 409.

`POST /tools/check_order` is also available for standalone bounded reads. Its statuses are `unique_match`, `not_found`, `needs_more_criteria`, `data_integrity_conflict`, and `source_unavailable`. Criteria use exact ID/room/name/external number matching and half-open stay intervals `[check_in, check_out)`. Even an exact order or guest match checks for overlapping active orders hidden by that criterion. Canceled orders are excluded. Closed orders remain readable but cannot receive payment through this operation.

The write result can report `success`, `duplicate_operation`, `version_conflict`, `validation_error`, or `source_unavailable`. HTTP 401/403 enforce identity/permission; invalid contracts return 422; invalid transitions or changed intent return 409; unavailable database or disabled feature returns 503 with a stable, data-free error. No SQL or payment payload is included in HTTP errors.

## Recovery and observability

`GET /missions` and `GET /missions/{id}` expose concise state and ordered Tool evidence. They are available to price-visible readers. The no-price role receives an order snapshot without any monetary/payment fields and cannot read payment Missions/audit at all. Owner/Admin/Housekeeper can record payments. Only Owner/Admin can resolve investigations.

An overlap blocks the parent and creates an `investigate_order_conflict` child with safety priority. This isolated pilot records the conflict evidence and waits for a trusted source repair; it does not guess which order to cancel. `POST /missions/{child_id}/resolve` requires evidence and a fresh unique query. Unresolved data remains blocked. A resolved child releases only its parent; the parent's next action revalidates before any write. Unrelated Missions can proceed while a child waits.

`POST /missions/{id}/resume` discards pre-write confirmation and restarts checking. If the payment already committed, it resumes **verification**, never the payment write. A lost source after payment returns `partial_success` with `payment_persisted=true` and `waiting_external`. A mismatching final query creates a `verify_payment` child and prevents completion. Repair resolution must satisfy the full original verification condition; it is not a generic “mark done” endpoint.

Each HTTP response commits before reporting success. Exceptions before commit roll back payment, version and audit together. A retry after a lost response reloads the durable state. The service keeps no Mission state in model memory or a process-local dictionary.

A full queue scheduler, automatic priority selection/preemption, scheduled morning reports, natural-language Agent integration and a Mission UI are still future work. This slice provides serial Tool transactions, persisted priority/dependency data, controlled advancement, and the API evidence needed for that integration.

## Reproducing acceptance tests

From `services/api`, install the existing development dependencies, create a disposable PostgreSQL database, and run:

```sh
PAYMENT_TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/bnb_payment_test pytest -q
ruff check .
ruff format --check .
```

**The payment fixture resets the pilot schema and test membership/property tables.** It refuses non-loopback hosts and database names without `_test`. Never point it at a real workspace database. The tests apply actual Alembic `008` upgrade statements; other legacy migrations are not needed for this isolated fixture.

CI now starts PostgreSQL 15 and always supplies the payment test URL. Without that URL, real-database cases are explicitly skipped, so a non-database run alone is not sufficient acceptance evidence. Full frontend lint/build remains required.

## Rollout and rollback

This change is not a production deployment. Do not import the private workbook, infer opening receipts from paid flags, alter production Sheet rows, or connect the public calendar to these tables.

Before a real pilot, approve the [source mapping](PAYMENT_SOURCE_MAPPING.md), implement a Sheet connector with stable order/payment IDs, idempotent writes, external recovery and authoritative readback, validate real member/property schemas and a least-privilege runtime connection, review all legacy endpoint isolation, then connect the existing UI to shared persisted summaries.

Rollback first disables `PAYMENT_WORKFLOW_ENABLED` and retains the ledger for audit/recovery. Alembic downgrade deliberately refuses to delete financial history. Removing the schema requires an explicit export, reconciliation and reviewed removal plan; do not use a destructive automatic downgrade.

## Validation recorded for this implementation

- Full backend suite: **200 passed**, including **44 new payment cases** (contract checks plus PostgreSQL-backed HTTP/transaction tests), using PostgreSQL 15 and Python 3.12.
- Backend Ruff lint and format checks: passed.
- Frontend ESLint: passed with one pre-existing unused `isOccupiedOn` warning in `week-carousel.tsx`; no frontend code changed.
- Frontend TypeScript and production build: passed. The build required network access for the existing Google Fonts.
- Deferred commit failure was exercised through a deliberately missing audit reference: the API returned a sanitized 503, and ledger/version changes rolled back.
- Migration/RLS/grants verification applies to the disposable local database; no production Supabase advisor or live migration was run.

## Interactive local test page

`scripts/payment_sandbox.py` serves a small operator test page at `http://127.0.0.1:8765`.
It calls the actual payment APIs and PostgreSQL ledger rather than simulating results
in browser storage. It supports normal payment, duplicate submission, an unexpected
deposit requiring confirmation, pause/reload/resume, and a synthetic overlap with
source repair and blocking-child resolution.

Run from `services/api` with a separate empty PostgreSQL database named exactly
`bnb_payment_preview_test` on loopback:

```sh
PAYMENT_SANDBOX_DATABASE_URL=postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/bnb_payment_preview_test python -m scripts.payment_sandbox
```

The harness is never imported by `app.main`. Only this standalone local process
uses a fixed synthetic owner identity. It binds to 127.0.0.1, rejects unexpected
Host/Origin headers and requires a custom header on writes. Initialization refuses
a nonempty database without its sandbox marker. Reset replaces only this dedicated
preview schema; it never uses a configured production database. Keep this process
local; it is not a deployment/authentication pattern.

Browser verification: NT$2,000 produces one receipt, NT$3,600 outstanding and a
verified Mission; resubmission leaves one receipt; overlap blocks writing and a
verified source repair resumes the parent; reload after a paused write preserves
the receipt and resumes final verification without duplication. Cross-origin
mutation returned HTTP 403. The browser console reported no errors.


## Integrated calendar and shared human/Agent Missions (2026-09-05)

The isolated payment slice now connects the existing calendar's order detail panel
to a shared payment workspace and `/missions` center. Both use persistent Missions
and the same database ledger; the sandbox calendar does not apply browser demo edits.
See [AGENT_PAYMENT_PLAYBOOK.md](AGENT_PAYMENT_PLAYBOOK.md) for local startup,
human/Agent takeover contracts, recovery, and the explicit production boundary.

Verified locally: manual calendar payment; Agent API intent → human confirmation;
refresh and cross-page persistence; oversized-payment withdrawal without a receipt;
overlap → blocking child → reject premature resolution → source repair → human
resolution → resume original Mission → exactly one verified receipt. Desktop/mobile
flows and production proxy rejection (404 even with the flag enabled) were checked.
Backend: 202 passing tests including real PostgreSQL. Frontend lint: no errors,
one pre-existing week-carousel unused-import warning; TypeScript and build pass.
Natural-language model integration, background scheduling, production Sheet writes,
and production calendar authorization remain separate work.
