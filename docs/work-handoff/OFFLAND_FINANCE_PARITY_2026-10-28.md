# Offland OS and shared LINE finance candidate

Status: implemented and tested candidate; not deployed or cut over.

## Accepted scope

The owner requested Offland income and expenses in Sweetfun OS and in the same
LINE OA used for Sweetfun. Both clients must use the same property-scoped Iron
Gate ledger. General income may have no booking; lodging income must identify
the exact current booking and pass the current balance/coverage checks.

The work is based on the W7 shared-ledger candidate, with the released calendar
performance and amount-reconciliation changes retained. This document does not
replace W7 source reconciliation or authorize a production import.

## Implemented behavior

- `OS_OFFLAND_FINANCE_SSOT_ENABLED` and
  `IRON_GATE_OFFLAND_SSOT_FINANCE_GRANT` are independent of Sweetfun's settings.
  The existing Offland calendar grant, authority epoch, rooms and signing proof
  provide the booking-read scope. Grants from a different property are rejected.
- OS financial reads, previews, confirmation, same-key recovery, pending slots
  and activity history use the selected property. Enabled but invalid settings
  fail closed instead of falling back to the old Redis money writer.
- Offland reads the entire authoritative booking collection twice, checking
  every page, property, workspace, epoch, cursor and booking version. The stable
  display/allocation identity is `IG-<booking UUID>`; cancelled identities remain
  available for prior payment allocations and refund obligations.
- Receipts from LINE, OS and other accepted ledger sources contribute once to
  the same balance. Refunds subtract cash; cancelled orders retain net receipts
  as potential refund obligations. Missing historical coverage remains unknown.
- Eligible native Offland lodging receipts use the shared financial form.
  Sweetfun's existing native/card panel is preserved. Offland never opens that
  Sweetfun-specific payment panel. General income, expenses and recurring costs
  use the same selected-property preview and confirmation workflow.
- Offland's financial summary and calendar payment display read the shared
  ledger. The old calendar receipt writer becomes read-only after cutover and
  directs the user to the Offland financial workspace. Failed financial reads
  preserve occupancy and mark payment information unconfirmed.
- The common live source-link API accepts `origin=os` with the `os_manual`
  connector, in addition to the existing LINE path. It still binds property,
  booking UUID/version, source snapshot, operator, authority and idempotency.
- `capture-os-finance-source.mjs` captures an explicitly selected property's
  Redis finance/payment namespaces twice using read-only commands. Raw snapshots
  are exclusive-create, mode 0600 and prohibited inside a Git checkout. Output
  contains counts and hashes only.

## Historical booking boundary

An imported booking, a source-paid flag, a source link, and an empty canonical
ledger do not prove complete prior cash history. Imported/external bookings,
unknown totals and unresolved source/payment evidence therefore retain
`historical_review_required`; their apparent remaining balance is not a new
payment request. Existing accepted cash is still visible.

The common W7 contract does not yet expose a complete historical-coverage
watermark or an authoritative remaining-balance contract that can unlock all
imported Offland bookings. The separate historical-settlement disposition for
selected Sweetfun orders is not such a coverage proof. Imported lodging receipt
parity remains an explicit dependency, even after general income/expenses are
ready for independent acceptance.

## Owner-authorized new-entry rollout — 2026-10-29

The owner explicitly authorized step 1 (deploy OS/LINE shared finance) and
postponed steps 2 and 3 (historical import/reconciliation and historical booking
balance verification). This supersedes the historical-import prerequisite below
for **new Offland general income and expenses only**. Sweetfun's existing writer
and settings stay unchanged. No historical receipt is inferred or imported.

- The independent Offland flag selects the canonical ledger and disables the
  legacy OS money writer. It must remain off until the common backend, scoped
  source connectors and separate grants are verified.
- `OS_OFFLAND_FINANCE_HISTORY_STATUS=not_imported` explicitly marks the report
  as new-ledger cash only. Financial overview, bookkeeping and order summary
  explain that historical cash is absent and is not evidence of nonpayment.
- `/finance/history?property=offland` reads the original OS finance entries and
  calendar receipts without modifying them or reconciling sources. The endpoint
  enforces current finance role, property scope and private response headers.
- Old LINE and OS records remain in their original stores; legacy requests must
  not be automatically replayed into the new ledger. Imported booking receipts
  remain under review until a separate authoritative balance check is completed.
- After the first new-ledger write, never roll back to a legacy-writer release or
  disable SSOT to recover. Set `OS_OFFLAND_FINANCE_WRITES_PAUSED=true` on the
  SSOT-capable release to stop new commands while retaining reads, grants, history
  and original pending request keys; then repair forward.
- Release identity, cutover timestamp and both-client acceptance remain separate
  operational evidence; these code changes alone do not mean production is live.

## Original full-history rollout contract

1. Review the common backend and deploy the prerequisite additive migrations in
   their prescribed order, with all new finance writers closed. Verify a real
   isolated database readback first.
2. Create three new stable UUIDv4 connector candidates for Offland only:
   `os_manual`, `line_finance`, `os_legacy_payment`. Bind the correct property and
   exact source account, initially disabled with no cutover timestamp. Preserve
   every subsequent configuration change in the configuration audit history.
3. Capture and reconcile Offland OS and LINE sources independently, including
   active/void records, accounts, plans, revisions, operations and outstanding
   requests. A successful scan of zero receipts is evidence for that source only.
4. Freeze the relevant old writer, refresh the source watermark, import only
   reviewed candidates, and verify every preserved entry, total and revision.
   Issue separate property-scoped OS and LINE grants. Configure the common
   preview secret and the appropriate property flags.
5. Independently accept general income and expenses through OS and the same LINE
   OA: preview, confirm, authoritative readback, other-client read, replay and
   cross-property refusal. Preserve Sweetfun's separate release gate.
6. Keep imported booking receipts under review until the coverage and current
   remaining-balance contract is implemented and independently verified.

Actual source instances, captures, counts, private audit findings and deployment
evidence are maintained outside this public repository. No credentials, guest
identities or raw historical records belong here.

## Verification

- Shared finance, Offland model/routes, legacy payment and calendar regressions:
  75 passing checks at the integrated candidate.
- Actual component/DOM checks, including Offland routing and preservation of
  Sweetfun's native panel: 6 passing checks in the final targeted run.
- Existing source-capture/backfill regressions: 17 passing checks.
- Common OS source-link change: 12 related checks, including actual PostgreSQL
  isolation, scope, preview, replay and version-change cases.
- TypeScript and production Webpack build pass; frontend lint has zero errors
  and seven existing warnings. CI includes the new finance/property and DOM suites.

These are isolated engineering checks. They are not a production import,
two-client live-money acceptance, physical-phone test, or release claim.
