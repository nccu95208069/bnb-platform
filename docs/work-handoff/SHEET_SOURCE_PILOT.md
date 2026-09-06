# Google Sheet booking source pilot — 2026-09-06

The production calendar can now consume an anonymous, read-only snapshot produced by a dedicated Sweetfun Sheet adapter. This is a one-time data import, not a live Google connection. The operational Sheet is unchanged. The payment sandbox and live pricing engine are not connected to this source.

## Contract and interpretation

- `frontend/src/lib/booking-sources/sweetfun-sheet.ts` maps columns by verified header names, rejects missing/duplicate required headers, and emits the common calendar booking projection.
- J identifies every source row regardless of origin. L optionally identifies the OwlNest parent order; N identifies an OTA order within its platform. A missing L is valid and uses J for row identity. Never infer a multi-row parent relationship from guest name, adjacency, AI status or a unique row ID.
- IDs are namespaced by source and hashed for the public projection. Guest names, original order/OTA IDs, free-text notes, contact details and LINE IDs are not published.
- Daily Sheet amounts remain separate. The current upstream local splitter distributes total order amounts evenly across room-nights, placing the remainder in the first entry. The Sheet amounts are not proven original OTA nightly rates or net payouts.
- Owner-confirmed semantics (2026-09-06): `done` means the guest has paid in full and maps to `paid`. It does not establish OTA collection or settlement into the property account. Other incomplete/blank states remain `unknown`; no ledger receipts are synthesized.
- `requirements_known: false` means legacy numeric UI defaults do not establish the absence of pets, extra beds or guest requirements.
- Duplicate IDs, overlapping room-nights, unchecked rows and unknown rooms are quarantined. Affected calendar slots show an explicit conflict marker with no invented price. Unknown whole-property allocations block all six rooms and quarantine physical-room records on the same date.
- Snapshot metadata exposes source identity, observation time, content version, read-only/anonymized flags, price basis and lack of authoritative availability/payment ledger.
- Query returns complete parent order groups, even across month boundaries; UI sums only the actual nightly amounts in its visible period. An incomplete parent ID must not be presented as a verified full order total.
- Owner confirmed telephone/LINE orders, cancellations, date changes and room changes are fully maintained in this Sheet. This establishes order coverage; it does not supply maintenance/stop-sell inventory.

Source issues are retained in the snapshot. They are not yet production-persisted Mission Manager incidents. All operational writes remain disabled for this source.

## Storage and deployment

The source snapshot is an ignored server artifact: `frontend/.calendar-data/source-snapshot.json`. Never commit it, raw Sheet exports, guest data or Google credentials. `.vercelignore` permits uploading this deliberately anonymized artifact to the owner-authorized Vercel project. Next.js traces it into the calendar server function; it is never in `public/`.

Runtime `CALENDAR_SOURCE=sheet_snapshot` activates the source. Missing/broken configured snapshots return 503, never fictional bookings. `NEXT_PUBLIC_CALENDAR_SOURCE=sheet_snapshot` labels the sidebar; it is not authorization. Public demo identity remains enabled only for the anonymous read-only projection. `NEXT_PUBLIC_PAYMENT_SANDBOX=false` keeps local test workflows off the production site.

Production environment settings must be set on the project itself. Promoting a preview can replace deployment-specific runtime settings with production settings; always query the final production API and check `data_mode`, source version and counts after promotion.

**Deployment prerequisite:** prepare and validate the anonymized snapshot before every deployment from a clean checkout. The public Git repository does not contain the data artifact. A Git/CI deployment without it will intentionally fail closed. This pilot should move to authenticated durable source storage when live synchronization is implemented.

From `frontend/`, run `node --experimental-strip-types scripts/import-sheet-snapshot.mjs /absolute/private/input.json` with `{ values, observedAt }` from an authorized header-and-rows read. The adapter strips identity before writing the ignored artifact. Do not commit the private input. Set nonsecret Vercel flags with `vercel env update NAME production --value VALUE --yes`; stdin values can preserve an unintended trailing newline. Confirm exact values and final production responses rather than relying only on a successful deployment.

## Future source integration

Each connector should produce a common versioned model, keeping source ID, property ID, immutable parent order ID, stable room-night ID, source event/version, observation time, cancellation/deletion status and field semantics. Do not deduplicate across connectors by guest name. Preserve mappings from OTA confirmation ID to channel-manager order ID to the internal order.

Recommended live design: upstream completes an entire write batch, then emits a signed event with event ID and batch version; the receiver performs an idempotent ingestion and validation before atomically publishing a new snapshot. Retain last valid data and show stale/error status on failure. Add periodic reconciliation to capture manual edits and recover lost notifications. Do not publish intermediate delete-then-insert states.

The current Google connector access in this task is not a reusable website credential. Configure a least-privilege service identity or delegated OAuth connection for the application before implementing ongoing reads. Source permissions need not become public.

Apps Script edit triggers do not run for API/script writes. Drive resource notifications are an alternative but still require a receiver, renewal and subsequent reads; they do not supply a complete changed-row payload. End-to-end delay includes Gmail polling, parsing/Sheet writes, ingestion and browser refresh. No subsecond SLA is claimed.

Official references: [Apps Script trigger restrictions](https://developers.google.com/apps-script/guides/triggers/installable#restrictions), [Drive change notifications](https://developers.google.com/workspace/drive/api/guides/push).

## Verification

- `node --experimental-strip-types --test tests/sweetfun-sheet.test.mjs`: privacy projection, unknown payment semantics, conflict quarantine, stable parent grouping, nightly amounts, whole-property ambiguity and schema/date rejection.
- `tests/browser/sheet-source.js`: source/September counts, read-only controls, nightly detail, Back, whole-property blocks and POST rejection. This is a read-only browser verification; it never modifies the Sheet.
- Frontend lint/build and production API/browser checks are required. Existing week-carousel unused-import warning predates this change.

## Owner follow-up and TODOs

- [ ] Preserve original OTA per-night/per-room prices instead of only evenly allocated Sheet amounts; owner explicitly deferred this.
- [ ] Add separate guest-payment, OTA-collection and property-settlement fields plus a proper payment ledger. Do not infer settlement from `done`.
- [x] All AI/manual/LINE rows follow J row identity, optional L parent identity and N OTA identity.
- [ ] Event-driven Sheet synchronization: watch the specific Drive file for content changes, including API and manual updates; fetch the target tab, compare source-keyed snapshots, represent removed rows as retired source records, and publish a validated batch atomically. Notifications from other tabs/format-only edits should not alter bookings. Persist subscription identity/expiry, renew before expiry, deduplicate messages and reconcile periodically. Direct upstream batch-complete notification remains useful to avoid delete/reinsert intermediate states. Durable storage, application Google authorization and a receiver are still required; subscription is not enabled by this pilot.


## Acknowledged historical issues

Owner defers the already-listed historical issues. `--acknowledge-current-issues` was applied once to that exact baseline. It must never be used in recurring imports. Normal imports carry only acknowledged fingerprints from the immediately preceding snapshot; resolved issues drop out, so recurrence can alert again. Fingerprints cover issue type, source identity and relevant conflicting row content, independent of row position. Added/changed conflicts are not automatically acknowledged.

Source summaries distinguish `new_issue_rows` from `historical_issue_rows`. Suppress the old cleanup banner; show acknowledged slots neutrally as historical room status. Preserve unresolved allocation/money exclusions rather than choosing a record or counting duplicate revenue. This changes acknowledgement/triage, not source truth or financial validation.

For initial synchronization, recommend minute-scale authoritative reconciliation plus a writer batch-complete webhook to accelerate. Treat Google push as optional; it cannot replace source reads, channel renewal and failure recovery. No recurring synchronization has been enabled.

## Confirmed rolling comparison window — 2026-09-06

Owner requests a smaller routine comparison scope:

- Use Asia/Taipei calendar dates. Include check-in dates on or after today minus 30 calendar days, with no future upper bound. For 2026-09-06 this means 2026-08-07 onward, inclusive; do not limit future bookings to the pricing engine's 90-day horizon.
- Also include earlier check-ins that have not checked out. For the Sheet's room-night rows, retain complete linked parent groups when needed to keep stay details and totals consistent.
- Preserve previously imported older records for historical calendar browsing. Aging out of the rolling window is not cancellation, deletion or issue resolution.
- If a previously tracked J identity disappears from a filtered result, resolve its current source presence and dates before retiring it. A changed check-in can move outside the window. An authoritative source read/index is required to distinguish this from a deletion; an incomplete batch or failed read never proves deletion.
- Keep out-of-scope unresolved issue fingerprints and acknowledgements. The current full-snapshot import's retirement behavior cannot be applied directly to partial results. Retire an acknowledgement only after an authoritative check verifies resolution.
- Reading and comparing are separate costs. This Sheet is not sorted by stay date; the last N rows are not a valid substitute for the date predicate. Start with correct source reads and scoped comparison; optimize fetched ranges only with a reliable source index or upstream query contract.

This records the agreed design for future ongoing synchronization. The deployed one-time snapshot and its full historical calendar remain unchanged; no recurring job or Google subscription is enabled by this decision.

## Monitor implementation follow-up

The owner subsequently requested implementing monitoring. The local implementation and verified read-only connection are documented in [SHEET_MONITOR.md](SHEET_MONITOR.md). Production activation is still pending the first-time storage integration terms and cloud deployment verification. The pilot's deployed snapshot boundary remains in force until activation is verified.
