# BNB-SAAS v1 shared identity and event contract — 2026-10-12

This is the OS-side contract for the website and LINE/Gmail teams. It freezes the
identity, authority, idempotency and recovery rules before another integration
is activated. **A contract is not an assertion that every flow below is
deployed.** The native website binding and reservation API are implemented.
The customer-tenant event readback endpoint in this branch is default-disabled
and has only synthetic verification. The legacy Sheet/OwlNest bridge is not
implemented.

## Identity and tenancy

| Concept | Canonical owner | Rule |
| --- | --- | --- |
| Tenant / workspace | OS `workspace.id` (UUID) | Every lookup and write is scoped by this ID. Slug, email, hostname and site name are display or routing hints, never tenant authority. |
| Property | OS `property.id` (UUID) | Must belong to the workspace and the actor/binding's property scope. Legacy `sweetfun`/`offland` IDs belong only to the older calendar-change API. |
| Physical room | OS `property.rooms[].id` (UUID) | The only unit for occupancy and conflicts. Site room-type/content IDs map to these through an owner-approved binding; they cannot substitute for them. |
| Order | OS `booking.id` (UUID) | Stays stable across hold, confirmed payment, amendment and cancellation. External order IDs and display references are aliases, scoped by source and property. |
| Website binding | OS `binding.id` (UUID) | Server-owned `siteId → workspaceId/propertyId/ownerAccountId` plus approved room mapping and configuration hash. A browser cannot assert or change the tenant. |
| Source record | `sourceSystem + sourceAccount + propertyId + externalId` | Preserve the original identifier and source version. A missing or ambiguous ID must enter review, not be matched by guest name alone. |

Only OS issues canonical IDs. The public guest site receives an opaque binding ID
and a server-held binding token, and sends only the approved room-type ID in
quote requests. The private editor completes owner authorization before it can
receive the token. LINE/Gmail resolves a verified sender/recipient through a
scoped binding, then sends `bookingId`; it cannot provide an arbitrary
`workspaceId`, `propertyId`, room ID, price or owner identity as authority for
a mutation. The event readback endpoint accepts IDs as claims but checks them
against the credential's configured tenant/property/source scope and the OS
order. Website owner actions recheck current membership and property scope.

New website bindings are disabled for sales when the owner approves the
connection. The connected status exposes `salesEnabled:false`; a second,
versioned owner action in the OS workspace enables sales after inventory
review. Reapproving an existing binding preserves its current sales setting.
Legacy service credentials still use exact `site_ids`. A dedicated Studio
credential can opt in to new UUID-v4 site IDs; this admission is disabled by
default. It creates only an expiring application. The verified intended owner
must compare the displayed site ID and Studio origin, then approve the OS
connection and physical-room mapping. An unapproved site receives no binding
token, and even an approved new binding remains closed for sales. The Studio
must show the same stable site ID to the owner. No production Studio opt-in is
installed by this branch.

The public self-service target does not require PM to precreate owner accounts
or collect email addresses. A new owner can supply their intended email in the
Studio flow and verify it through the browser-bound OS login link before
approving a binding. Website ChatGPT login is not itself an OS identity proof.
The current import-to-booking compatibility gap and safe rollout sequence are
tracked in [BETA self-service OS admission](BETA_SELF_SERVICE_OS_ADMISSION_2026-10-12.md).

## Booking and occupancy state

OS is authoritative for **native** booking and hold writes. Availability is an
observation; a quote is temporary; neither reserves inventory. Reservation
rechecks the approved mapping, price, stay and *all* native bookings, active
holds and blocks for each physical room-night, then saves the order and receipt
in one compare-and-set operation. Check-out is exclusive. Concurrent attempts
for the last room result in exactly one successful occupant. A hold occupies
inventory until its own verified conversion/release; expiry alone does not free
it. Payment conversion keeps the same `orderId` and requires an actual receipt.
Status `preparing` or `review_required` cannot be displayed as confirmed.

For Sweetfun/OFFLAND legacy inventory, the operational Sheet remains the final
record and OwlNest is the OTA inventory endpoint. Native OS occupancy cannot
replace either. No public sale or external-stock success claim until the
deployed Sheet order-ID field, read/write/readback, source version, OwlNest
close/release and shared serialization are verified. The known OFFLAND O/Q
order-ID discrepancy is a blocking mapping question. Imported calendar/Sheet
coverage is limited to the owner-confirmed interval; a missing source row or
unresolved collision is **unknown**, not a free room.

## Mutation and event versions

The canonical `booking.version` increments on every accepted order mutation;
`workspace.version` fences concurrent inventory writes. A source-specific
`source_version` (e.g. Sheet revision, Google event version, website binding
configuration hash) identifies the observation that was actually read. It must
not be inferred from wall time or replaced by a newly generated retry ID.
An outbound event represents a *verified state transition*, not a request to
write the booking again. Producers save an immutable event ID and payload in a
durable outbox in the same transaction as, or after readback of, the
authoritative mutation. The implemented, default-disabled readback endpoint is
`POST /api/integration/customer-events/v1` with this exact JSON shape:

```json
{
  "schema": 1,
  "event_id": "stable-producer-id",
  "workspace_id": "OS-issued UUID",
  "property_id": "OS-issued UUID",
  "order_id": "OS-issued UUID",
  "order_version": 2,
  "source_version": "opaque-original-source-version",
  "source": "gmail",
  "kind": "booking.changed",
  "occurred_at": "2026-10-12T00:00:00Z",
  "verified": true,
  "check_in": "2026-10-20",
  "check_out": "2026-10-22",
  "room_ids": ["OS-issued room UUID"]
}
```

No guest details, credentials, bank data or free-text message in this event.
`source` is `website`, `line`, `gmail` or `owlnest`; `kind` is
`booking.created`, `booking.changed`, `booking.cancelled` or `hold.converted`.
The dedicated Bearer credential has SHA-256 hash and explicit
`workspace_id`/`property_ids`/`sources` allowlists in server-only
`CUSTOMER_EVENT_CLIENTS`; `CUSTOMER_EVENTS_ENABLED=true` is also required.
Neither setting is installed by this branch. Payload IDs, current dates, rooms,
order version and terminal state must match the OS order. The endpoint does
**not** write an order, toggle OwlNest, parse Gmail or independently verify an
external source version. The producer remains responsible for that source
write and readback before setting `verified:true`.

POST returns `200` with the same `event_id`, `order_id`, `order_version`,
`source_version`, `workspace_version`, `completed_at`, `verified:true` and a
relative `status_url`. GET that URL with the **same** Bearer credential and
check the exact IDs/versions and `verified:true`. The receipt lasts 30 days.
It proves the OS snapshot at `completed_at`; a later order mutation requires
its own versioned event and receipt.
Exact POST retries return it; changed payload under one event ID is `409`.
If the OS order is absent, stale or different, POST returns
`409 SOURCE_NOT_VERIFIED` without a receipt. The producer retains the original
outbox event, resolves the discrepancy and retries the **same** body/ID;
notification retry must not repeat the booking or inventory write. The
workspace read and receipt commit share a compare-and-set fence. The old
`/api/v1/calendar/changes` contract accepts only `sweetfun`/`offland`; it is
not this tenant endpoint and must not be reused with a customer UUID.

## Idempotency, failure and notification handoff

The website uses one client-generated UUID `idempotencyKey` per reservation
intent in both the body and header. OS stores a permanent request receipt
bound to the exact payload. Exact retry or `requests` lookup returns the same
`orderId`; a changed payload with the same key is `409`. A quote cannot be
consumed twice under different keys. On timeout the site queries the original
key, never creates a new order intent or assumes a room was held.

Owner commands use a separate stable `requestKey`, expected connection and
booking versions, and explicit confirmation. Before acting, LINE/Gmail must
inspect the current OS order and verified sender binding. After acting, they
read the same order/version and show the resulting OS state. On a timeout they
replay the **same** key or inspect it; they do not issue a fresh mutation.
Payment evidence is an actual receipt, not a notification or guest promise.

OS notification jobs are keyed by order transition and channel. They are
enqueued only after the authoritative order write. Delivery workers have
scoped action/channel credentials; successful send receipts are persisted.
Unknown send outcomes require reconciliation before a retry. Email/LINE failure
changes only notification state and cannot create another order, change
occupancy or imply payment. A guest may see `queued`, `sent`, `failed` or
`unknown`; none of these labels is an order confirmation by itself.

## Source imports and rollout gate

Per-property Google Sheet and Google/iOS/Android ICS/ZIP imports use
property-scoped snapshots, a preview and explicit selection/coverage
confirmation. They retain source references and hashes, reject overlapping
room-nights, use workspace-version compare-and-set on commit, and make an exact
commit retry return the original batch. Missing/cancelled calendar source
records enter review; cancellation with received money requires settlement.

The BETA-03 Excel/CSV entry in this branch accepts bounded `.xlsx` and
UTF-8/Big5 `.csv` uploads. It stages each file tab for one hour in the same
property/account-scoped source store as Google Sheet and reuses the same
deterministic column/room suggestions, manual mapping, grouped order preview,
confirmation, conflict check, CAS commit, retry receipt and guarded undo.
Filename plus tab name is the stable file-source namespace, so revised uploads
must keep those names. This is a one-time migration, not automatic file sync;
the source file is unchanged. Rule suggestions are not an AI inference and
never bypass human confirmation. Unselected or conflicting rows remain in
review. The upload does not prove that future OTA changes or omitted source
files are covered; an active source or a separate owner check is needed before
using that period for public sales.
The `.xlsx` intake measures each ZIP entry's actual expanded bytes before
parsing, in addition to checking declared sizes and the total expansion cap.

Before any public pilot, run at least two synthetic tenants through the same
IDs and credential paths: cross-tenant/property access must fail; two parallel
last-room attempts must leave one occupant; an OTA-sold room-night must block a
direct reservation even if a stale website quote says available. Also verify
loss of the POST response, exact retry, changed-payload conflict, event
readback, and notification failure without a second inventory write. Real
customer data and external Sheet/OwlNest field mapping are still missing, so
this gate does not authorize public booking or claim end-to-end OTA protection.

## Implementation pointers

- Native website API: `WEBSITE_BOOKING_API_2026-10-07.md`,
  `frontend/src/lib/website-booking/{connections,booking,notifications}.ts`.
- Native OS occupancy/holds: `OS_HOLDS_PRICING_2026-10-07.md`,
  `frontend/src/lib/customer-workspaces/{holds,operations,calendar-import}.ts`.
- Legacy two-property change receipts: `CALENDAR_CHANGE_ENDPOINT_2026-10-07.md`.
- Tenant OS event receipt: `frontend/src/lib/customer-events/contract.ts` and
  `frontend/src/app/api/integration/customer-events/v1/route.ts`.
- Calendar import onboarding: `CALENDAR_ONBOARDING_2026-10-04.md` and
  `CALENDAR_PREVIEW_FIRST_2026-10-04.md`.

## Isolated verification and remaining work (2026-10-12)

The file intake and existing Sheet import share the same scope and commit path.
The focused suite passes 42 tests: two synthetic file-import tenants, source
scope, revised-file deduplication, conflicting room-night, xlsx parsing,
last-room website/hold contention, a stale website quote after a synthetic
OTA booking, event credential isolation/readback, and loss/retry behavior. Frontend ESLint and TypeScript pass;
the production Webpack build passes. These are local synthetic checks, not
provider or public-site acceptance.

The tenant event endpoint was also exercised through actual local HTTP POST
and GET calls backed by a synthetic Redis REST fixture: two tenants received
separate receipts, exact retry/readback matched, cross-tenant read/write were
rejected, and a changed payload under the same event ID returned 409. The
fixture used synthetic credentials and did not contact production Redis.

`BETA-03` remains open for real owner formats, mobile file selection and
source-coverage acceptance. `BETA-02/INT-01` native private flow is implemented;
legacy Sheet/OwlNest formal confirmation and public sale remain blocked.
`BETA-04/OS-05/OWL-01` external tenant LINE identity and multi-customer
OwlNest credentials/mapping/readback, and `BETA-05/ING-01` tenant Gmail/OTA
authorization, four-platform parsing and durable sender are not implemented
by this branch. The tenant OS receipt exists only as a default-disabled
readback endpoint; no producer is wired to it and no scoped production
credential is installed. The deployed legacy endpoint cannot be used as a
shortcut. The tentative cross-line checkpoint is 2026-10-26.
