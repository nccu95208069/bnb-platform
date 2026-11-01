# Monthly booking reporting — owner-approved approximation

2026-10-24: the owner approved approximate last-year pace and use of existing room-fee amounts, without waiting for historic cancellation/amendment snapshots or complete extra-fee separation.

`GET /v1/properties/:propertyId/business-report` now adds `monthly` (schemaVersion 1). The existing service-only `booking:aggregate`, empty field scope, property/epoch authorization and private/no-store response remain unchanged. No new booking-read or mutation permission is added.

The projection uses the same normalized booking/night allocation as the daily report. Confirmed room-nights belong to their actual stay months, checkout exclusive. Distinct bookings with stays in each month are secondary and are not additive across months. Exact existing allocations take precedence; integer remainder allocation conserves total cents when estimates are necessary. Zero-price, unpriced and paid nights remain distinct. Existing amounts are treated as room-fee approximations; no other fee or payment ledger is added.

OFFLAND reporting uses its authoritative `offlandImport` provenance to select the single-villa profile, the public room label `包棟`, and the owner's existing 60% estimated-net-profit ratio. Sweetfun and generic properties retain the existing 68% default. Contradictory Sweetfun/OFFLAND import markers are invalid rather than an invitation to guess a profile. The ratio is returned in `monthly.netProfitRatio`; consumers must use that value rather than copying another property's display formula.

The same profile selects the original OFFLAND snapshot for allowlisted platform labels, unanimous original booking-date fallback and validated per-stay amounts. Current source-event metadata and exact authoritative room-night prices keep precedence; stale imported evidence is not used after a source amendment. The returned daily report remains anonymized and shares its authoritative state version with the monthly report. Report generation never writes back to the frozen Sheet.

`paidRoomNights` means known positive room price, not a verified payment. The aggregate daily `paid` boolean is not a complete OFFLAND receipts ledger and must not be used to claim an unknown payment is unpaid. Report authorization stays `origin=service`, `booking:aggregate`, `fields: []`, scoped to the specific property's current authority epoch.

For current/future months, last-year comparison filters present confirmed records by original booking date up to last year's current Taipei date, with verified first-notification fallback. Historical cancellation/amendment states are intentionally ignored. Missing dates exclude only affected cutoff comparisons, with a count; they do not block current monthly totals. Completed months compare full corresponding prior-month totals. February 29 clamps to February 28. Known-zero baseline yields an absolute delta without a percentage; absent earlier history is null rather than zero.

`firstObservedStayDate` is the earliest stored stay, including retained cancelled/held records; it is an observation boundary, not proof of complete history. The reporting window ends six months after the current Taipei month. True room-night collisions or invalid monthly data return monthly:null without breaking the existing daily report. Consumers must display unavailable, not a zero report or frozen-Sheet fallback.

No production booking, payment, notification, source claim or channel state is changed. Deployment and authenticated production acceptance are recorded separately; tests alone do not establish publication.
