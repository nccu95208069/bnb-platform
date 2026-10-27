# Finance SSOT W5 checkpoint — 2026-10-28

This candidate is stacked on the W4 Iron Gate branch. No production connector, credential, migration, or finance writer has been changed. All new finance switches remain off.

## Candidate changes

- `014_finance_connector_config_audit.sql` adds a safe adapter key and source Sheet reference to each property connector. Insert and versioned update create immutable configuration history. The history is property-scoped for runtime reads; no secret value or card data belongs in these fields.
- The Sweetfun OS card bridge requires the Card grant's finance source instance to match the separately configured Sweetfun Card connector when the finance switch is on. A missing or mismatched binding fails closed before the Card request is sent.
- The OS finance view labels an operator-attested Card Done as manually confirmed with bank settlement pending. Later processor or bank evidence can change the displayed evidence level without counting another room receipt.

## Local verification

- Migration 014 was applied and reapplied to the isolated `iron_gate_finance_test3` database. Its connector test passes for version increments, immutable history and property-scoped reads.
- The Card binding test, frontend TypeScript check and changed-file ESLint passed in this worktree. These are isolated tests; they do not prove production end-to-end reconciliation.

## Remaining work before Card cutover

- Record and review the live Sweetfun connector instance, source account, Sheet ID reference, grant binding, watermarks and current Card Done/Fail event IDs in a private W0/W7 report. Do not put card data or credentials in this repository.
- Keep Sean Dashboard and cc-sync limited to Sweetfun. Their current single-property auth and source selection do not provide a safe multi-property UI. Each future property needs its own grant, source Sheet, lock, actor policy and isolation tests.
- Run the complete Card cycle in an isolated environment with the new ledger transaction enabled, then reconcile original Card result IDs, old booking payment events and new finance events one to one. A production claim requires a real observed Card cycle after cutover.
- Clear the W3/W4 remaining gates, especially reviewed source links and the LINE private-message/LIFF writer paths, before any W7 cutover. W5 configuration alone does not authorize a finance writer switch.
