# Monthly booking reporting — owner-approved approximation

2026-10-24: the owner approved approximate last-year pace and use of existing room-fee amounts, without waiting for historic cancellation/amendment snapshots or complete extra-fee separation.

`GET /v1/properties/:propertyId/business-report` now adds `monthly` (schemaVersion 1). The existing service-only `booking:aggregate`, empty field scope, property/epoch authorization and private/no-store response remain unchanged. No new booking-read or mutation permission is added.

The projection uses the same normalized booking/night allocation as the daily report. Confirmed room-nights belong to their actual stay months, checkout exclusive. Distinct bookings with stays in each month are secondary and are not additive across months. Exact existing allocations take precedence; integer remainder allocation conserves total cents when estimates are necessary. Zero-price, unpriced and paid nights remain distinct. Existing amounts are treated as room-fee approximations; no other fee or payment ledger is added.

For current/future months, last-year comparison filters present confirmed records by original booking date up to last year's current Taipei date, with verified first-notification fallback. Historical cancellation/amendment states are intentionally ignored. Missing dates exclude only affected cutoff comparisons, with a count; they do not block current monthly totals. Completed months compare full corresponding prior-month totals. February 29 clamps to February 28. Known-zero baseline yields an absolute delta without a percentage; absent earlier history is null rather than zero.

`firstObservedStayDate` is the earliest stored stay, including retained cancelled/held records; it is an observation boundary, not proof of complete history. The reporting window ends six months after the current Taipei month. True room-night collisions or invalid monthly data return monthly:null without breaking the existing daily report. Consumers must display unavailable, not a zero report or frozen-Sheet fallback.

No production booking, payment, notification, source claim or channel state is changed. Deployment and authenticated production acceptance are recorded separately; tests alone do not establish publication.
