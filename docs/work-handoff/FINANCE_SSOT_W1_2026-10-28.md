# Finance SSOT implementation checkpoint — W1 schema foundation

This branch starts the adjacent `FINANCE_SSOT_IMPLEMENTATION_PLAN_2026-10-28.md`,
copied from the project handoff so the contract is reviewable in the PR. The plan remains the product contract; this checkpoint
describes only the code in this branch. **Nothing here has been applied to the
production database or deployed. Existing OS, LINE and Card finance writers are
unchanged.**

## Baseline checked

- Source branch: `origin/codex/card-sync-release-base-20261027` at `d1b9ac6`
  (includes merged Airbnb calendar breakdown PR #105).
- Read-only production check on 2026-10-28 Asia/Taipei: two Iron Gate properties;
  Sweetfun inventory version 120, 1,640 bookings and 10 embedded payment events;
  the other property inventory version 4, 271 bookings and 0 embedded payment
  events. The existing `iron_gate` schema had six tables and no `finance_*` table.
- Iron Gate and OS production aliases resolved to READY deployments during this
  check. Their source SHA was not available from the Vercel response; do not infer
  it from the deployment timestamp.
- This is **not** a complete W0 source inventory. LINE Firestore versions/outbox,
  OS Redis financial records, Card source event mapping and provider-level
  ownership still require private, read-only snapshots before any backfill.

## Implemented in this branch

- `iron-gate/sql/005_finance_ssot_core.sql`: isolated connectors, source documents
  and immutable revisions/events, booking allocations, expense month allocations,
  request receipts, source links/aliases/ownership, review issues and projection
  outbox. Cross-property references use composite foreign keys where the parent
  exists as a table. A booking currently lives in `property_state.state_json`, so
  its UUID must be checked while holding that property's state row lock in W2.
- `iron-gate/sql/006_finance_ssot_support.sql`: account and category dictionaries,
  non-money recurring/payout/status records, evidence assertions and settlement
  records. Settlement gross minus refunds and fees must equal net.
- `iron-gate/sql/007_finance_ssot_balances.sql`: deferred commit-time checks for
  event allocation and expense month totals; category references stay inside the
  same property. A command may insert its event and allocation rows in either order
  within one transaction, but cannot commit an incomplete amount. Reversals must
  negate the same booking allocations and cost months as the original event.
- Runtime has only scoped `SELECT` on these private tables. `anon` and
  `authenticated` have no table privileges. W2 will add only the DML grants needed
  by its transactional writer, alongside authorization tests. No public Data API
  table is introduced.
- `iron-gate/tests/sql/finance-core.test.sql`: synthetic cross-property,
  source-system, wrong-cash-sign, reversal-period, settlement arithmetic,
  immutable-event and RLS checks. The test transaction rolls back.
- `iron-gate/sql/rollback_finance_ssot_empty_only.sql`: manual rollback that aborts
  if **any** new finance table contains data. It is not a cutover rollback.

## Local verification

On a disposable PostgreSQL 15 database, migrations 001–003, 005–007 and the SQL
test passed. Migration 004 is a production-specific credential grant and correctly
refuses a new empty test database. After the SQL test, `finance_document` still had
zero rows. The temporary local database contains no guest, payment or card data.

## Required next work

1. Finish W0's private source snapshots and exact identity mapping. Do not use
   aggregate counts as proof of financial completeness.
2. W2 must hold the property's state row while checking every linked booking ID and
   expected version. The database enforces allocation/attribution totals at commit,
   but a booking still lives inside JSON, so there is no ordinary booking FK. The
   current schema is **not** a finance acceptance API.
3. W2 must extend `PostgresPropertyRepository.transact` so new ledger rows,
   request receipts, old booking JSON compatibility and outbox commit atomically.
   Preserve `booking.version` semantics for legacy imported orders.
4. Keep all new finance writer flags off until W7's per-property reconciliation
   and cutover. Never replay the existing Card Done events as new money.

## Reversal and deployment boundary

The schema is additive. In a test installation with every new table empty, apply
`rollback_finance_ssot_empty_only.sql`; it drops the new tables in dependency order.
After any backfill or accepted finance event, this rollback intentionally fails.
At that point use an evidence-backed forward repair and the W7 per-property
cutover/rollback protocol from the plan.
