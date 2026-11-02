# Offland retained orders — 2026-10-29

## Owner decision and scope

The owner requested retaining an existing Offland booking when the guest has paid
a deposit but has not selected replacement dates. Release the old stay, retain
the same booking and payment identities, provide a cross-month pending list,
and later arrange a replacement stay. The owner then authorized implementation
and testing. Production publication and a real guest-booking mutation are not
part of the implementation acceptance recorded here.

This is a new `retained` lifecycle state. Existing `held` bookings keep their
short-term room-holding semantics. A retained order has no current stays and
no current contract price. Its original stays, nightly prices and total remain
in append-only retention history. It is neither a cancellation nor a new order.

## Implemented flow

1. An authorized owner/admin/god opens the exact Offland calendar order and
   selects **轉為保留訂單**. Preview shows all room nights belonging to that ID.
2. Confirm atomically records retention history, removes current stays and
   occupancy, and preserves the original booking/source/payment identities.
3. The calendar's **遺忘無際待改期** control lists retained orders independently
   of the calendar's month and can search guest/contact/order references.
4. **安排入住** starts with empty new dates. Select one or more villa stay
   segments and each night's price, preview availability, then confirm.
5. New stays and price are committed together under booking/inventory version
   guards. A collision leaves the order retained with zero new occupancy.

The read-only list and detail respect property membership and money visibility.
The server independently authorizes every preview, write and operation recovery.
The public adapter maps only configured room IDs to room labels and checks
property/workspace, schema, versions and retained-state invariants on readback.
The OS preview and commit paths accept only proven Offland Q/J import identities
in this rollout. Native OS/LINE bookings without those identities are not offered
the action, even though the generic backend lifecycle supports them.

## Money and reports

- Retain/reschedule never create, refund, transfer, or backdate a payment.
- An empty new ledger does not prove an old deposit was zero. An imported
  Offland order's usable retained amount remains `null`/review-required until
  evidence proves it. This does not block releasing or arranging stays.
- Existing receipts/refunds remain visible with the same IDs and cash dates.
  The retained order is removed from active receivables, collection actions,
  occupancy and stay-month revenue. New stay revenue belongs to the new dates.
- A verified retained amount can display a remaining balance or overpayment.
  Neither display performs a financial transaction. Historical verification
  is per order; no full-property historical reconciliation prerequisite exists.
- Offland general-only finance restrictions remain in force. This feature
  does not enable lodging receipts, refunds, credit transfer or settlement.

## Sources and external rooms

The backend recognizes Offland's actual import identity: Q parent groups and
individual J rows. It never merges orders by guest name or adjacent dates.
Proven Q/J aliases and source links remain owned by the same booking after
retention and after rescheduling. Delayed old source upserts/cancellations are
retained as evidence; they cannot restore old nights, cancel replacement stays,
or create occupancy fences on the released dates merely for source review.
Authorized money readers receive only the proven Q/J alias strings from the
same original source account. Legacy finance hides those old child stay rows
even if a later Sheet export drops their parent Q field; all cash records keep
their original ledger identity. Missing or ambiguous aliases fail closed.
Airbnb reconciliations remain complete historical cohort evidence, while the
current stay projection uses the replacement dates and newly agreed price.

OS occupancy and external OwlNest room state are separate results. Retention
does not dispatch an independent LINE `provider_only` command. Deferred room
work remains scoped to the affected nights; unresolved real provider operations
are not silently cleared. `channel.mode=none` is projected as `not_integrated`,
not as proof that external rooms were opened. The UI explicitly asks the owner
to confirm external room status separately.

## Idempotency and recovery

Preview returns current booking/inventory/authority versions. Commit rechecks
them inside the property transaction. It records the state, audit, receipt and
occupancy together. The OS then reads the authoritative booking and verifies
the exact operation in retention history. A later legitimate booking change
does not make an already-completed operation unknowable.

Before POST the browser saves a member/property-scoped pending request with its
UUID and exact payload. Unknown outcomes retain that key across refresh. Users
can query again or resend the same key/payload; a new key is not generated for
an unresolved operation.

For a request that never arrived or can no longer apply, **放棄未完成操作，重新預覽**
atomically stores a `not_applied` receipt with the original request hash. If the
command already succeeded, the existing applied receipt wins. If abandonment
wins, a delayed original POST returns the same tombstone and cannot mutate the
booking. Only a verified applied/not-applied response clears local pending
state; a GET 404 alone is not proof of non-execution.

## API and activation

Backend endpoints under `/v1/properties/:propertyId/bookings`:

- `GET ?status=retained&limit=100` — date-independent bounded pagination.
- `GET /:bookingId` — current detail plus permitted retention history.
- `POST /:bookingId/retain-preview`, `/retain`.
- `POST /:bookingId/reschedule-preview`, `/reschedule`.
- `POST /:bookingId/retained-request-abandon` — original request key/action/input.
- Existing `GET /v1/properties/:propertyId/requests/:requestKey` — recovery.

OS endpoints live under `/api/v1/bookings/retained`; abandonment uses
`/:bookingId/abandon`. Every mutation requires same-origin JSON and a UUID
`Idempotency-Key`; every response is private and non-cacheable. Previews do
not require an idempotency key. Backend authorization uses `booking:amend` for
the lifecycle and its receipts, and `booking:read` for query-only members.

The OS feature starts closed. Activation requires both an existing authoritative
Offland calendar configuration and:

- `IRON_GATE_OFFLAND_RETAINED_ENABLED=true`
- `IRON_GATE_OFFLAND_RETAINED_GRANT`: a separate same-workspace/property OS grant
  containing `credentialId`, `clientId`, `workspaceId`, `propertyId`, `token`.
  Backend actions: `booking:read`, `booking:amend`; permitted fields:
  `guest_name`, `contact`, `notes`, `money`, `payment_status`.

No `payment:write`, finance-ledger write, or channel-control permission is needed.
Read-only snapshot mode cannot enable this feature. Existing finance/manual
booking switches do not implicitly enable it. A deployed system containing
retained orders must keep readers that understand this state; rolling back to a
reader that requires non-empty stays would break those reads.

## Validation record

Validation uses dedicated backend lifecycle/source/concurrency tests, real
signed HTTP-to-OS adapter tests, legacy/shared-finance regressions and rendered
component tests. Coverage includes refresh/recovery, unsubmitted requests,
permission redaction, changed input invalidating a preview, multi-segment
prices, cross-month discovery and Q/J regrouping without duplicate money.

- Backend type checking and build pass. The complete backend suite reports
  496 passed, zero failed and 23 optional database skips.
- A separate local PostgreSQL run executes all 32 lifecycle and repository
  tests without skips. It verifies connection reopening, transaction rollback
  after a late audit failure, unchanged payment history, source protection and
  exactly one winner when two orders target the same last room.
- The related calendar/manual/payment regressions pass (84 tests), finance
  regressions pass (119 tests), and rendered retained/manual/finance workflows
  pass (33 tests). New signed HTTP, legacy overlay and Airbnb lifecycle cases
  pass together (23 tests).
- Final frontend lint has zero errors and seven existing warnings. TypeScript
  and the production Webpack build pass; Google font CSS uses the local test
  response fixture so verification does not depend on a font download.
- Real Chromium at 1440×1000 and 360×800 completes calendar → retain preview →
  confirm → pending-list search → replacement preview → confirm → new-month
  calendar. The same booking ID, released original nights, unchanged payment
  history and empty pending list after rescheduling are verified. All 58
  recorded API responses are HTTP 200; there are no page errors.
- The final mobile date fields use one column so the full year remains visible.
  Stable dialog captures verify opaque backgrounds and no horizontal overflow.
  This is browser viewport testing, not physical iPhone acceptance.

The browser report and screenshots are private workspace evidence under
`verification/offland-retained-20261029/`, outside this repository. No deployment
or production flag activation is claimed by this validation record.

All acceptance data is synthetic. No real guest booking, payment, source Sheet,
or OwlNest inventory is changed by these tests.
