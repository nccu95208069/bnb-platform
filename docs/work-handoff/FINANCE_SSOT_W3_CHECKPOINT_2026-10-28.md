# Finance SSOT W3 checkpoint — 2026-10-28

This branch is stacked on W2 PR #107. The OS cutover flag remains off in every environment.

## Implemented candidate

- `012_finance_ssot_os_catalog.sql` adds OS account digits, recurring amount/day/method/description, payout month offset, revision reason note, and private advance snapshots. It grants only property-scoped catalog inserts and limited plan updates. `013_finance_ssot_activity_read.sql` adds a property-scoped read policy for finance operation audit rows.
- Sweetfun OS has a separate finance credential and `OS_SWEETFUN_FINANCE_SSOT_ENABLED` switch. Its candidate writer checks the current source projection, validates legacy UI inputs, submits Iron Gate commands, and verifies the exact request receipt. Unknown write results recover using the same request key. It does not write the Redis finance store when switched on.
- The candidate read path projects active document revisions from Iron Gate, treats reversals and voids correctly, uses reviewed source links to assign receipt allocations, and supplies the existing OS finance and finance-summary screens. New OS manual entries can be edited or voided; native and Card entries retain their booking link. The old calendar payment form becomes read-only when the switch is on.
- The legacy path remains in place when the switch is off. No production migration, connector, credentials, backfill or deployment was changed.
- The OS audit page now queries Iron Gate's property-scoped accepted revision and operation history, including non-cash settings. Missing historical detail is marked partial rather than fabricated. After the switch, the Sweetfun imported-order calendar payment badge uses the accepted ledger projection and fails closed if an exact order link is absent. Staff without full finance access get an unconfirmed badge instead of stale Redis data.

## Local verification

- PostgreSQL 15 isolated database: 012 applied repeatedly; command transaction test and native/Card atomic rollback test pass.
- PostgreSQL 15 isolated database: 013 applied; activity pagination/filter query and non-cash audit rows pass with runtime role.
- Iron Gate `npm run check` passes. Frontend TypeScript check and changed-file ESLint pass. Finance bridge tests cover preview, idempotent receipt readback and unknown result recovery. Projection tests cover amendment, void, refund netting and plan metadata. Existing finance route tests passed with the switch off.

## Blocks before W7 cutover

- Redis finance and payment records still require an exact per-row transform, reviewed source links, shadow import and zero-difference reconciliation. No production snapshot was taken in this branch.
- Existing audit records contain only the fields preserved by each source; the candidate shows incomplete operations as such. The current audit endpoint must be checked against a deployed Iron Gate service before enabling OS.
- The UI needs an explicit Iron Gate preview before user confirmation. The current candidate performs preview within server submission for linked bookings.
- New source-order links after cutover need a live reviewed mapping workflow. Historic imports cannot be used after cutover.
- The candidate has not yet passed an end-to-end test against a deployed Iron Gate service or a real direct edit in Google Sheets.
- The frontend production build is currently blocked in this isolated workspace by the environment's inability to resolve `fonts.googleapis.com`; TypeScript and changed-file ESLint pass.

## Same-request recovery review

The OS adapter now queries the scoped Iron Gate request receipt before loading a potentially newer finance projection. Money and plan commands carry a server-generated SHA-256 fingerprint of the original OS request. A retry returns an already accepted result only when that fingerprint matches; a changed payload with the same request key is rejected. This closes the gap where a committed command followed by a failed HTTP readback could be stranded by the next request's stale `projection_version`. The Iron Gate API must support `origin_request_hash` and echo it in accepted money and plan receipts before this candidate can be enabled. Focused bridge/projection tests (9), frontend TypeScript, and changed-file ESLint pass. No production flag or writer was changed.

An OS void of its own booking-linked receipt now carries exact booking/version guards; otherwise Iron Gate rejects every such void. The SSOT read model also marks OTA and mixed-payment bookings as needing review when the payer or obligation is not established. Their numeric receivable is withheld from OS totals and payment forms, while the UI shows the affected orders and labels the monthly receivable and total as pending review. Verified OTA payouts count as property cash; guest-paid observations remain non-cash. A canceled imported booking keeps its verified historical source link for receipt and refund readback without creating a current receivable. Legacy finance behavior stays behind the off switch.

Rollback while the flag remains off: no action needed. If tested with the flag on in an isolated environment, turn `OS_SWEETFUN_FINANCE_SSOT_ENABLED` off and retain Iron Gate receipts for comparison; do not replay accepted commands into Redis.
