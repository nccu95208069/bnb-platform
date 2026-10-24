# OFFLAND → Iron Gate booking/calendar migration

Started 2026-10-25 Asia/Taipei. Owner authorized GitHub publication, deployment,
temporary calendar-read interruption, and the changes necessary for migration.
This is a booking and occupied-room-night cutover, matching Sweetfun's first
release. It does not assert migrated payments or OwlNest channel inventory.

## Verified source and initial baseline

- Source is the existing private `OFFLAND calender 2026` spreadsheet, tab
  `工作表1`, gid `475170922`, time zone `Asia/Taipei`. The other tabs are not
  booking source rows; finance and prices retain their own authority.
- Read-only values check on 2026-10-25: 280 nonempty A:Q data rows; every J
  populated and unique; every I is `OK`; every D/E is exactly one night; no
  two source rows occupy the same date after both A aliases map to one villa.
  The observed check-in range is 2025-12-31 through 2027-05-23. This is a
  moving source, not a cutover snapshot.
- A is `OFFLAND` (260 rows) or `OFFLAND(連住)` (20), both one physical villa.
  Q is the current parent order ID (32 populated); O is card status/payment
  evidence (42 populated). 248 rows have no Q, including two continuation
  rows with neither O nor Q. Never infer parent identity from names, dates,
  adjacent rows, or O. J is the lossless per-room-night identity.
- The current OS Sheet monitor reads A:O and aliases O to order number. This
  conflicts with current source headers and `gmail-check-order` writer schema,
  which explicitly writes Q and preserves O as payment status. Repair this
  without silently rewriting historic OS IDs; record an old-to-new identity
  bridge for displayed links and source reconciliation.
- The dedicated Iron Gate database currently has one active six-room property
  (Sweetfun), and no OFFLAND state. Sweetfun OS currently reads Sweetfun from
  Iron Gate and OFFLAND from Sheet. Gmail and LINE OFFLAND writers remain on
  the legacy path. These are read-only observations, not activation evidence.

## Stage 1 — source and writer inventory

1. Record every writer and its active runtime: Gmail new/amend/cancel and
   recovery, LINE V1/V2 and cards, OS manual/financial paths, human Sheet edits,
   Apps Script triggers, Calendar bridge, jobs and queues. Record exact freeze
   and recovery actions. Confirm present cloud revision and source account;
   source documents alone are not production state.
2. Copy the entire native spreadsheet to an owner-only private backup, read
   back A:Q values, formulas and notes, metadata and permissions, then record
   version and SHA-256 privately. Keep the source Sheet untouched. Prove a
   restore from the backup in an isolated destination before using it for a
   production load.
3. Resolve every row into accepted, cancelled or quarantined, with exact J/Q,
   nightly fee, date, room, notes and cancellation evidence. Any source change
   invalidates the frozen hash and requires a new delta pass.

Gate: every nonempty source row has one disposition; no uncontained conflict;
the private backup is independently readable and restorable; writer inventory
includes a drain and post-cutover prohibition for each active path.

## Stage 2 — read-only OFFLAND shadow

1. Implement an OFFLAND-specific A:Q audit and converter; create a separate
   workspace/property/one-room UUID map and stable booking IDs. Q groups only
   proven same-order rows; blank Q creates independent row bookings. Preserve
   the full source row and notes as restricted evidence. Amounts are room fees,
   never payment events. Keep historical unknowns explicit.
2. Create a read-only epoch-0 Iron Gate OFFLAND state with source links,
   occupied room nights and review fences. Import from the private, hash-bound
   snapshot through an idempotent, property-scoped transaction. Verify every
   booking, J/Q mapping and occupied date bidirectionally against the frozen
   source. No source grant or sales/writer capability at this stage.
3. Implement a property-scoped Iron Gate calendar reader in Sweetfun OS and
   an OFFLAND-only flag. Compare the same date windows in Sheet and Iron Gate
   for month/week/day, booking details, authorized names, prices, source
   warnings and property isolation. Keep Sweetfun's current Iron Gate path.

Gate: zero unexplained missing/extra/changed accepted rows or occupied nights;
no cross-property result; no unapproved live write; source hash still current.

## Stage 3 — writer candidate and rehearsal

1. Route OFFLAND Gmail new/amend/cancel and recovery through a dedicated
   property-scoped Iron Gate source grant, with exact request key and readback.
   Route or explicitly freeze the OFFLAND LINE order paths and OS manual
   writes. The old Sheet writer and new Iron Gate writer must never both own
   a message/event. Finance and OwlNest remain on their separately verified
   paths; the calendar must not imply channel stock has changed.
2. Build and run synthetic new/amend/cancel, retry, ambiguous-order, one-villa
   collision, permission and fail-closed tests. Deploy zero-traffic candidates
   and compare runtime identity, secrets, jobs, queues and configuration with
   current production. Test the real owner read-only calendar against the
   shadow; do not create synthetic guest orders in production.
3. Rehearse freeze, drain, delta capture, epoch activation, OS read flip,
   writer cutover and restoration in an isolated environment. Record a
   no-new-write rollback path and a post-write reconciliation path.

Gate: all actual entrypoints have a tested destination or a visible temporary
pause; zero unknown pending writes; candidate and current revisions identified;
automatic recovery never guesses an uncertain outcome.

## Stage 4 — production cutover and observation

1. Select a low-traffic window. Record current revisions, scheduler/queue
   states and source modified time. Pause every old OFFLAND writer; wait for
   the longest in-flight request and verify no new Sheet writes. Capture a
   final owner-only copy and compare every source row, note and delta to the
   loaded shadow. Abort on unexplained drift.
2. Activate OFFLAND authority epoch 1 using the exact final source hash and
   property version. Promote the prepared OS calendar reader and writer
   revisions. Confirm only the intended service receives traffic; resume
   background entrypoints one by one with readback. Keep the original Sheet
   as a frozen audit source.
3. Verify authenticated calendar month/week/day and property isolation,
   source lookup, Gmail/LINE routes, scheduler outcomes, errors and the first
   real OFFLAND order receipt. Compare the original Sheet modified time and
   new Iron Gate receipt; no dual write. Reconcile every post-cutover event.

Stop/recover: before the first Iron Gate write, return to the captured old
writer only after proving zero new receipts. After the first Iron Gate write,
never simply point traffic back to the old Sheet; pause, reconcile every event
and occupancy, and choose a controlled forward repair or rollback.

## Status

Stage 1 source preflight is partly complete. An owner-only native Drive backup
was created on 2026-10-25 at 01:57 Taipei time. All 4,777 A:Q cells, including
six formulas and notes, matched the original; its five tabs and private owner
permission were verified. A private XLSX export was independently opened and
parsed. Its normalized A:Q source hash and 270-booking ID map live only in
private temporary files, never in Git. The initial candidate covers all 280
source rows and 280 villa nights with no overlapping date or rejected row;
22 Q-linked groups and 248 J-only rows produce 270 bookings. It has no payment
events and no stock or channel activation.

The isolated Drive restore-copy drill remains pending. Automatic approval
review rejected creating a second copy from the owner-only backup because the
destination was not specified precisely enough for sensitive guest data. Do
not retry it with a different tool or destination without explicit approval.
The current Cloud Run service revision, configuration, trigger inventory and
zero-traffic candidate cannot be inspected from the connected Google account:
the Google Cloud Console reports missing access to `gmail-order-handler` in
`essential-truth-478816-v1`. No GCP CLI credentials are available locally.

The live Sheet's linked Apps Script project currently lists four installed
triggers: `onEditInstallable`, `onChangeInstallable`, `auditOnOpenMenu`, and
`auditDaily`. They are shown as owned by another user; `onChangeInstallable`
last ran at 00:05 Taipei time on 2026-10-25 with a reported 100% error rate.
The two edit/change triggers remain a cutover fence until their owner confirms
their runtime behavior and can pause them. The daily audit's read-only nature
must also be checked against the live script, not inferred from its name.

Code for the Offland audit/shadow candidate, OS read path and Gmail/LINE
writer fences has been published as draft PRs
[`bnb-platform#78`](https://github.com/nccu95208069/bnb-platform/pull/78) and
[`gmail-check-order#97`](https://github.com/nccu95208069/gmail-check-order/pull/97).
The OS candidate is READY in a protected Vercel preview (`dpl_78kULw7XxrQxxEbVMyaRqD8CV5KX`);
its Offland flag is absent and defaults closed. The production alias remains
on `dpl_6tdddv9FWVShckyVDPtCTFUvmuwr`. No database load, live writer change,
production deployment, or production authority switch is claimed. The Stage
1 and Stage 3 gates remain open; the live Sheet is still the Offland calendar
source.
