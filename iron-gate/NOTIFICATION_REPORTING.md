# Daily order reporting by first new-order notification

Decision: 2026-10-24, Asia/Taipei. The owner chose **新單通知日** for Sweetfun daily
orders. This changes the reporting date definition; it does not invent an OTA
booking-created date. Release, data-recovery and live-verification status must be
recorded separately in the release handoff.

## Source and reporting contract

The authenticated Gmail source writer identifies a source message with
`gmail-v1:<Gmail internalDate milliseconds>:<SHA-256 of message ID>`. Its new-order
path requires an unlinked booking; a modification or cancellation requires an
existing link. The backend validates source origin, property/workspace/authority,
the active source grant and its source system/account before accepting an event.
No Gmail deployment or change to the incoming source-event payload is required.

On a successful new canonical booking only, the backend captures
`SourceLink.firstNewOrderNotification = {schema:1, receivedAt, sourceVersion,
requestKey}`. Capture additionally requires source system
`sweetfun-calendar-sheet`, the authenticated subject `gmail-order-handler`, a
valid Gmail source version and a service-valid UUID request key. The notification
cannot occur after canonical creation. The request UUID's version is not an
authorization or date proof; the source API accepts valid UUID4 and UUID5 keys.
Client and grant IDs may rotate without changing the trusted subject contract.

This evidence is immutable across amount repairs, amendments, cancellations,
channel checks and LINE reconciliation. The current mutable `sourceVersion`
must never become a daily-report date fallback. Report projection verifies the
source link and the exact successful creation receipt at booking version 1 before
supplying only `receivedAt` to the calculator. Raw source references, message
hashes, request keys and canonical IDs remain private.

`Booking.bookedAt` is unchanged, including null. Order-detail `bookingDate` and
advance-booking days use the original date only. Daily grouping uses
`countedDate`, with `dateBasis` equal to `notification`, `booking-date` or
`unknown`. Existing verified booking dates can support explicitly labelled
historical/other-source fallbacks; they are not relabelled as notifications.
Confirmed canonical bookings remain the counting unit. Multi-room/long-stay
orders count once, and currently cancelled bookings remain excluded.

Report metadata includes `dailyOrderDateBasis: "new-order-notification"`,
`notificationDateOrders`, `bookingDateFallbackOrders`, `unknownDailyDateOrders`,
`dailyComparisonComparable` and `notificationCoverageFrom`. Original-date
unknown counts remain separate from unknown effective reporting dates.

## Complete comparison periods

The earliest observed order does not establish a complete day. A property may
hold `reportingPolicy = {schema:1, authorityEpoch, notificationCoverageFrom,
recordedAt}` after the new capture code is deployed and verified. The guaranteed
coverage date is at least the next full Taipei day after establishment. The
loader checks the current authority epoch and valid canonical dates; a later
authority transition cannot silently inherit comparison coverage.

For a completed 2026-10-24 rollout, the earliest guaranteed coverage is
2026-10-25. Recovering notices from 10/22–10/24 does not prove complete historical
coverage for those days. Both seven-day comparison windows must be within the
explicit coverage, even when a window contains zero orders. Missing dates or
prices and mixed date bases also prevent trustworthy comparisons. Until then,
daily totals still display and comparative percentages/verdicts are suppressed.

## Bounded recovery of existing source links

The read-only report never repairs data. Operators use the separately reviewed
metadata recovery procedure. It requires one private projected snapshot and one
explicit private manifest, both owner-readable only. Neither file, generated SQL,
nor production references belong in Git or a deployment package.

`scripts/export-source-notification-recovery.sql` is a read-only query template
for the exact property and source-version set. It returns property scope/version,
SHA-256 of the authoritative JSONB text, active source-grant metadata, candidate
booking identity/date/version flags, their source links, source receipts and all
candidate audits. It never selects guest, contact, stay, price or email-body data.
The candidate audit hash is computed over `jsonb_agg(audit_json ORDER BY audit_id)`.
Use one database statement so the projection and hashes share one snapshot.

The manifest contains only these keys:

```text
schema: 1
propertyId, workspaceId, authorityEpoch, expectedInventoryVersion
sourceAccount, clientId, subjectId, grantId
sourceVersions: the exact unique versions to recover (1–50)
recoveryKey: a new service-valid UUID for this maintenance operation
notificationCoverageFrom: the guaranteed next full Taipei day or later
```

Run the pure dry run from the Iron Gate directory:

```sh
node --experimental-strip-types scripts/prepare-source-notification-recovery.mjs \
  /absolute/private/input.json /absolute/private/manifest.json
```

It has no database or network client. Standard output contains counts and a proof
digest, with no guest or order identifiers. It refuses ambiguous, imported,
diverged or previously stamped candidates. Each selected booking must have
exactly one `source.applied` audit at version 1, the exact scoped writer and
creation receipt, matching property and booking versions, and a source timestamp
no later than canonical creation. Later source-fact, payment and channel audits
may exist; another source application or unexplained history is rejected. One
historical accepted request may use UUID4; this does not change any evidence or
authorization checks, and does not establish why that UUID version was used.

After reviewing the dry run, add a third private output path to prepare SQL:

```sh
node --experimental-strip-types scripts/prepare-source-notification-recovery.mjs \
  /absolute/private/input.json /absolute/private/manifest.json /absolute/private/recovery.sql
```

The output file is newly created with mode 0600 and is never overwritten. **The
generated SQL intentionally contains `COMMIT`; generation does not execute it.**
An authorized operator must separately review and execute it against the intended
database. Deploy backend capture first, then refresh the projection and manifest
if a source event advances the version. Do not bypass a failed version/hash gate.

The transaction locks the property under serializable isolation, rechecks scope,
version, complete state hash and candidate audit hash, and repeats the original
event/receipt/time proof against authoritative rows. It stamps only the source
link identified by the booking's exact source key. It advances the property
version once and may establish the same-epoch reporting policy; it refuses an
existing conflicting policy. It preserves the complete booking collection,
original `bookedAt`, booking versions, rooms, occupancy, payments, receipts,
channel operations, fences and source versions. Notification and policy audit /
outbox events are appended in the same transaction, with final readback checks.
No database schema change or expanded runtime authority is required.

If the outcome is unknown, inspect the exact link metadata, reporting policy,
property version and maintenance audit before doing anything further. Do not
replay Gmail events, clear claims or regenerate a new request merely to force a
repair. Verify the live reporting API and dashboard after the committed change,
including Taipei day counts and preserved null original booking dates. Counts
derived from recovered notification timestamps must be labelled as notifications.
