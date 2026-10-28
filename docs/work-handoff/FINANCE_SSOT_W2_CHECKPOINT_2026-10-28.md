# Finance SSOT W2 checkpoint — 2026-10-28

This branch is stacked on W1 PR #106. It is a guarded implementation candidate, not a cutover.

## Added

- `008_finance_ssot_writer_grants.sql` grants the runtime only property-scoped inserts on the ledger tables and limited document version updates. Connector provisioning remains administrative.
- A connector-bound command API handles preview, create, amend, void, refund, request receipt recovery, ledger pagination, booking finance, expense month reads, and account lookup. Preview resolves a registered exact source-order link and binds the current booking version and normalized command for 15 minutes. The write transaction locks the same `property_state` row used by legacy Iron Gate writers.
- Existing OS payment and Sweetfun Card Done/Fail operations can append normalized finance revisions in the same PostgreSQL transaction as the booking JSON compatibility projection. Failure on either side rolls back both. Card Done retains the original payment event UUID, creates an alias to the Card document, and does not create a second receipt.
- New finance grants require a connector UUID. OS and LINE keep their existing independently verified member/operator proofs. Card's dedicated `card:sync` grant cannot acquire a generic receipt scope.
- `009` adds zero-cash operational status, recurring expense plan, and expected OTA payout rule operations with independent scopes and request receipts. `010` adds append-only evidence assertions and settlement batches with a deferred database link-balance check. Neither creates another room receipt.
- Verified provider transaction references use the cross-property ownership unique index. If a transaction ref collides, the command returns a review code without revealing the other property.
- `011` adds a reviewed, append-only source-order link and import issue workflow. A dedicated `finance:import` credential can preview and commit source links and historical commands while its connector has no cutover timestamp. Source links require an exact booking UUID/version, source snapshot hash, reviewer evidence, a confirmation flag and a short-lived signed preview. Import receipts and ledger remain readable after cutover; import writes then fail closed. Blocking issues can be listed and resolved with an auditable request receipt.
- A settled event now rejects amendments and voids, preserving the exact event IDs and amounts referenced by the settlement batch. Refund amendment and reversal read-model cases are covered by the local database test.

## Gates and verified behavior

- `IRON_GATE_FINANCE_COMMANDS_ENABLED` and `IRON_GATE_FINANCE_NATIVE_LEDGER_ENABLED` default off. Command preview also requires `IRON_GATE_FINANCE_PREVIEW_SECRET` of at least 32 characters. No production finance migration, connector, deployment, or writer was changed.
- Local PostgreSQL 15 test database: migrations 008–011, scoped runtime role, command create/amend/void/refund, exact booking link, shadow import, issue resolution, request retry, amount cap, duplicate review, provider transaction collision, zero-cash plans/status, balanced settlement, evidence promotion, property isolation, read model, and native/Card atomic rollback passed.
- `npm run check` passed. `npm test`: 446 tests, 433 passed, 13 skipped, 0 failed. The local PostgreSQL tests run sequentially with `IRON_GATE_FINANCE_TEST_DATABASE=iron_gate_finance_test3` because each test truncates its dedicated disposable database.

## Required before any W7 enablement

The follow-up native/Card gate checks each property's `iron_gate_native` or
`sweetfun_card` connector inside the legacy booking transaction. An enabled
connector with an effective `cutover_at` mirrors the event only when the runtime
capability is on. A property/source without an effective cutover keeps its
legacy writer. Once cut over, disabling the connector or runtime rejects the
whole write instead of silently resuming a legacy-only result. New payment
and Card grants must include the registered `financeSourceInstanceId`; prepare
them with `prepare-sweetfun-finance-grants.mjs NEW_PRIVATE_DIRECTORY SOURCE_INSTANCE_ID`
and append `--card-sync` for the Card connector. The issuance SQL verifies that
the supplied connector belongs to Sweetfun and has the expected source system.

- W0 source snapshots and W3–W6 adapters, classification/account provisioning, backfill and per-source reconciliation are not done in this branch.
- Generic refunds against a legacy native/Card receipt are explicitly blocked with a review code until a same-transaction booking JSON compatibility projection is implemented. The existing native refund path remains behind the native-ledger cutover flag.
- Bookings with existing unmapped payment JSON, unclear OTA payee, or stale source link are blocked for review. They need exact source evidence and mapping before cutover.
- Build the source-specific import transform and human review UI, Sheet batch scanner/workbook, plus per-property flags and monitoring. The W2 API records only exact reviewed mappings; it does not infer a booking from a name, amount, or date.
- The new read model currently serves only when the guarded command service is enabled. Do not enable it until old events are backfilled and individually reconciled.
