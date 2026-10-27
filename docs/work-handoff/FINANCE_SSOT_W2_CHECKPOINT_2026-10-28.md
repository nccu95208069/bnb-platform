# Finance SSOT W2 checkpoint — 2026-10-28

This branch is stacked on W1 PR #106. It is a guarded implementation candidate, not a cutover.

## Added

- `008_finance_ssot_writer_grants.sql` grants the runtime only property-scoped inserts on the ledger tables and limited document version updates. Connector provisioning remains administrative.
- A connector-bound command API handles preview, create, amend, void, refund, request receipt recovery, ledger pagination, booking finance, expense month reads, and account lookup. Preview resolves a registered exact source-order link and binds the current booking version and normalized command for 15 minutes. The write transaction locks the same `property_state` row used by legacy Iron Gate writers.
- Existing OS payment and Sweetfun Card Done/Fail operations can append normalized finance revisions in the same PostgreSQL transaction as the booking JSON compatibility projection. Failure on either side rolls back both. Card Done retains the original payment event UUID, creates an alias to the Card document, and does not create a second receipt.
- New finance grants require a connector UUID. OS and LINE keep their existing independently verified member/operator proofs. Card's dedicated `card:sync` grant cannot acquire a generic receipt scope.

## Gates and verified behavior

- `IRON_GATE_FINANCE_COMMANDS_ENABLED` and `IRON_GATE_FINANCE_NATIVE_LEDGER_ENABLED` default off. Command preview also requires `IRON_GATE_FINANCE_PREVIEW_SECRET` of at least 32 characters. No production finance migration, connector, deployment, or writer was changed.
- Local PostgreSQL 15 test database: migration 008, scoped runtime role, command create/amend/void/refund, exact booking link, request retry, amount cap, duplicate review, property isolation, read model, and native/Card atomic rollback passed.
- `npm run check` passed. `npm test`: 446 tests, 433 passed, 13 skipped, 0 failed. The local PostgreSQL tests run sequentially with `IRON_GATE_FINANCE_TEST_DATABASE=iron_gate_finance_test3` because each test truncates its dedicated disposable database.

## Required before any W7 enablement

- W0 source snapshots and W3–W6 adapters, classification/account provisioning, backfill and per-source reconciliation are not done in this branch.
- Generic refunds against a legacy native/Card receipt need a reviewed compatibility projection policy. Until that is implemented, keep command writing disabled.
- Bookings with existing unmapped payment JSON, unclear OTA payee, or stale source link are blocked for review. They need exact source evidence and mapping before cutover.
- Add status/recurring/payout/evidence/settlement/import issue and Sheet batch workflows, plus per-property flags and monitoring.
- The new read model currently serves only when the guarded command service is enabled. Do not enable it until old events are backfilled and individually reconciled.
