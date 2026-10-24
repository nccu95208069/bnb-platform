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
- Of the 248 J-only rows, 187 carry an OTA platform label and 61 carry LINE.
  An older Gmail amendment/cancellation that supplies only a platform order ID
  cannot be linked automatically to those J-only bookings; the new writer
  fails closed for human reconciliation. Do not claim automatic historical
  change coverage without a source-backed identity bridge.
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

The owner explicitly authorized the exact restore destination after automatic
approval review rejected an unspecified sensitive-data destination. A separate
native restore-drill copy was created in the owner's My Drive root at 02:29
Taipei time, with owner-only access and all five original tabs. The 4,777
A:Q booking cells match the private backup cell-for-cell, including six
formulas and all notes. Its ID is
`1SiwKRBKJEWWbK1ZuKJktHOKJVW8iG9bzBZYek9W_MNo`. It is disposable;
it was moved to recoverable Google Drive Trash after verification. The
original source and the first owner-only backup remain in place.
The current Cloud Run service revision, configuration, trigger inventory and
zero-traffic candidate cannot be inspected from the connected Google account:
the Google Cloud Console reports missing access to `gmail-order-handler` in
`essential-truth-478816-v1`. No GCP CLI credentials are available locally.

The live Sheet's linked Apps Script project currently lists four installed
triggers: `onEditInstallable`, `onChangeInstallable`, `auditOnOpenMenu`, and
`auditDaily`. They are shown as owned by another user; `onChangeInstallable`
last ran at 00:05 Taipei time on 2026-10-25 with a reported 100% error rate.
The connected `sweetfuntw@gmail.com` account is confirmed as the original
Sheet owner and all four triggers display as owned by that account. The
currently visible script file has no edit/change handler definitions, but
the triggers remain a cutover fence until they are stopped in the final window.
Apps Script's trigger menu offers Delete rather than Pause; record each
setting before removal so any approved rollback can recreate it. The daily
trigger is scheduled for 07:00–08:00 Asia/Taipei with daily error notices.
The daily audit is not read-only: it can create/delete Google Calendar events,
change Sheet notes/backgrounds, and send failure email. Its owner must pause
the daily and menu paths during the final frozen-copy window, then decide
whether and how to keep the old Calendar audit after Iron Gate activation.

Code for the Offland audit/shadow candidate, OS read path and Gmail/LINE
writer fences has been published as draft PRs
[`bnb-platform#78`](https://github.com/nccu95208069/bnb-platform/pull/78) and
[`gmail-check-order#97`](https://github.com/nccu95208069/gmail-check-order/pull/97).
The updated OS candidate is READY in a protected Vercel preview
(`dpl_GfF2LcGFoQxCTmPtta79pgqDW2G1`);
its Offland flag is absent and defaults closed. The same tested frontend source
was subsequently deployed to production as `dpl_6J1AFcGueU9MQgndtaiz7UJjUsfJ`;
Vercel readback confirmed `READY` and alias `sweetfun-os.vercel.app`. A second
environment metadata readback found no `OFFLAND` variables among 76 entries,
so the new reader remains closed and the live Sheet remains the Offland
calendar source. No live writer change or production authority switch is
claimed. The Stage 1 and Stage 3 gates remain open.

The Iron Gate backend code was also built and deployed to production as
`dpl_GgAAFdJXLBRyK5JBst5QBiZ5Q3u3`. Vercel alias readback confirmed
`iron-gate-green.vercel.app` points there and the deployment is `READY`;
an unauthenticated `/v1/properties/<synthetic-id>` request returned the
expected `401`, showing the production runtime is initialized and still
requires a grant. OFFLAND remains read-only epoch 0 with no credentials.

At approximately 02:42 Taipei time, the hash-bound initial snapshot was
imported into the dedicated Supabase project using a short-lived restricted
`iron_gate_shadow_import` login and the reviewed idempotent seed script.
Independent database readback found the separate OFFLAND property at epoch 0,
version 1, `readOnly=true`, 270 bookings, 270 source links, 280 occupied villa
nights, zero source grants, zero receipts and zero issued credentials. Its
stored source hash matches the private snapshot. The temporary login was
returned to `NOLOGIN`, password cleared, expiry set to year 2000, runtime
membership revoked, and its one idle backend terminated; readback found zero
remaining connections. This is a historical shadow only. Any later Sheet
change requires a reviewed delta and a new final frozen snapshot before
authority activation.

The real private snapshot was also projected through the local Iron Gate
service for 18 month windows from the first to last occupied source month.
The audit compared all 280 source nights, 270 group keys and per-night fees
against the calendar projection: zero missing, extra or changed items. This
does not replace an authenticated check of the deployed API.

A temporary, epoch-0, OS-only read credential was issued for a live preview
check, but automatic approval review rejected transmitting that token to the
`sweetfun-os` Vercel Preview environment without destination-specific owner
authorization. The credential was never used, was marked inactive in the
database, and its local token file was removed. No OFFLAND preview variable
was created. A separate proposed broad pull of all Iron Gate production
environment variables was also rejected because it could extract unrelated
secrets. The OS reader now reuses its already configured server-side proof
key, so that broad pull is unnecessary. Live preview setup awaits the owner's
specific answer.

A source-only GCO release package was exported from pushed commit
`1283d1184334835c7670297eb0caf9c6156423af` (155 files; SHA-256
`abf0ff0c485a35b30611dec88971d4b31c73abd4409a8557c801ff14837e81c7`).
This candidate refuses the Offland Gmail Iron Gate route unless the Offland
LINE order-write pause is also enabled; five targeted synthetic checks pass.
No Cloud Build or Cloud Run candidate exists yet because the connected account
still lacks Cloud Run project access.

The OS draft PR also prepares exact final-snapshot authority activation,
next-epoch scoped Gmail/OS credentials, and a no-new-write epoch-2 rollback.
These enforce writer-freeze timestamps and reject source/state drift. Activation
now additionally requires a distinct owner-only final copy created after all
writers are frozen and drained; its A:Q source hash must exactly match the
loaded shadow. A changed source cannot be silently activated.
When the Offland calendar flag eventually turns on, OS will hold calendar
payment entry for explicit reconciliation because the legacy monitor mistook
O (card/payment status) for the Q order identity. Existing OS receipts remain
in their original ledger keys and can be viewed as recovery records when the
original order ID is known; they are not automatically remapped to Q. Booking
fee display is not a payment ledger.
