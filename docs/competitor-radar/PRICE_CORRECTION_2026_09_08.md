# Price and source correction, 2026-09-08

Owner evidence takes precedence over prior automated acceptance. The screenshots show a multi-room Agoda property with 201 and 202 bookable on September 9, and 101/102/301/302 in a sold-out section. This contradicts the previous five individual-page interpretation. The old URLs came from handoff text, not a separate owner confirmation, and are no longer fallback collection sources.

- Existing browser-local Agoda observations are quarantined on restore and on job completion. Room edits and other platform results remain intact. Legacy sold-out observations and any prices are not displayed.
- The old individual-page collector is withdrawn. The exact multi-room property URL is pending; screenshots lack the URL bar and public search has not established its identity. No guessed replacement is deployed.
- A fresh bounded Booking inspection found an AWS WAF challenge shell rather than property content. The route is now classified as blocked and paused. Challenge execution, alternate identities and retries are not attempted. No challenge payload or user cookies belong in this repository.
- Trip remains paused after its prior restricted result.

## Price rules

Agoda current offers can establish availability and a pre-tax display price, but only a verified total including taxes/fees may enter the comparable-price field. The owner screenshot reference for Room 201 is NT$1,815.10 plus NT$281.34, total NT$2,096.44. This is a historical test reference, never a live fallback. Do not calculate taxes using a fixed multiplier. Match property, room, rate plan, dates, adults, children, rooms and currency between offer and checkout summary. Discount labels must remain attached to their offer.

Agoda sold-out section: adopt only the explicit status for that room and active stay context. Ignore sold-out display prices. A room's absence and an incomplete search remain unknown.

Booking: a returned offer table can provide the included-tax stay total without entering checkout, but only after property/stay context and eligibility are verified. The owner's logged-in screenshot must not establish universal Genius eligibility or authorize copying their session.

No personal fields will be filled and no reservation/payment will be submitted as part of quote verification. Current work establishes quarantine and comparison rules; it does not claim completed live price collection.
