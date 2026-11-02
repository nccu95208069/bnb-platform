# Historical settlement candidate (W7)

This backend candidate records a reviewed pre-cutover disposition for exactly four
private OS bookings: three with owner-confirmed receipt of the booking total but
unknown cash date and method, and one unpaid. It is **disabled by default**. No
cash event, `property_receipt`, `cash_on`, payment method, or historical revenue is
created. Migration 018 is additive and does not enable a connector or writer.

## Private evidence boundary

An isolated Iron Gate runtime may opt in with
`IRON_GATE_FINANCE_HISTORICAL_SETTLEMENT_ENABLED=true`,
`IRON_GATE_FINANCE_HISTORICAL_MANIFEST_PATH` and the raw file's
`IRON_GATE_FINANCE_HISTORICAL_MANIFEST_SHA256`. The existing finance command flag
and preview secret must also be enabled. The manifest file stays outside Git and
must be mounted privately into that runtime. Startup rejects a missing, changed,
malformed, or non-four-row manifest. Each row pins an IG booking UUID, version,
snapshot hash and total; an OS source-link key and hash; a zero-amount OS receipt
ID, version and hash; Sheet row and money-alias hashes; the exact 64-hex
`checkRows` / `FinanceOrder.source_version` for that Sheet order at owner review;
and the owner's exact decision. The manifest pins full OS, Sheet and
owner-decision hashes as well. This order version changes when the reviewed
Sheet row identity, room, stay dates, room rate or payment status changes. The
private manifest must be regenerated from the reviewed Sheet evidence before
this new field can be used; the backend does not derive or invent its value.

The backend can verify its live IG booking, connector, source link, finance rows
and outbox. It cannot read the external OS, Redis, Sheet or owner evidence during
the command. A trusted operator must recapture and compare those sources before
preparing the private manifest. The manifest SHA is the boundary to that frozen
external review; a current external-source recheck is required before any actual
cutover. A Vercel/serverless deployment has no private local file mount today, so
**production enablement is blocked** until a secure manifest delivery method and
isolated end-to-end validation exist. Do not put the raw manifest in source control
or a production environment variable.

## Restricted API

- `POST /v1/properties/:propertyId/finance/historical-settlements/preview`
- `POST /v1/properties/:propertyId/finance/historical-settlements`
- `GET /v1/properties/:propertyId/finance/historical-settlements/receipts/:requestKey`
- `GET /v1/properties/:propertyId/finance/historical-settlements?as_of_change_seq=N`

Preview and commit require a property-scoped `finance:import` principal from the
OS finance connector, an idempotency key matching the request, and the exact
manifest SHA, booking, source-order key and decision. Commit requires the signed
15-minute preview token. The transaction locks the property, rechecks the IG
booking and source link, rejects existing money or ownership, prior disposition,
open source issue, an unpaid booking with an accepted settling status, and **any
undelivered property-wide Sheet outbox row**. That last gate can block all four
rows until the entire property outbox is drained. It is intentional while the
Sheet snapshot is external to this service. Commit inserts one immutable
zero-cash disposition, one finance change sequence and one request receipt.
The receipt readback compares the stored disposition and its source hashes to
the pinned manifest and verifies the finance change sequence and source link.

`GET /v1/properties/:propertyId/bookings/:bookingId/finance` returns
`legacy_settlement` separately from cash `summary`. A settled row sets
`collection_hold=true`, `historical_cash_detail_missing=true`, and operational
`remaining_due_cents=0` only while its IG booking is unchanged and no competing
money appears. A conflict clears the collection hold, preserves the missing-cash
detail marker, and requires manual review. Cash received and revenue remain
money-event-only. An unpaid row
does not override payer uncertainty: an external booking still has
`remaining_due_cents=null` and requires review; only an independently qualified
direct-source booking can expose a numeric due. The property list endpoint filters
immutable dispositions by a requested finance change pin and includes the source
link hash and Sheet order source version for exact OS catalog and live Sheet
projection matching. A Sheet change after review keeps the order in manual
review instead of silently applying the collection hold.

There is no automatic amend or resolution path for an immutable disposition.
A changed booking, new cash source, or changed source proof remains in manual
review. Native/Card writers and full historical cash reports need their own
cutover validation before this candidate can be enabled in production.
