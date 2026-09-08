# Price and source correction, 2026-09-08

Owner evidence takes precedence over prior automated acceptance. The screenshots show a multi-room Agoda property with 201 and 202 bookable on September 9, and 101/102/301/302 in a sold-out section. This contradicts the previous five individual-page interpretation. The old URLs came from handoff text, not a separate owner confirmation, and are no longer fallback collection sources.

- Existing browser-local Agoda observations are quarantined on restore and on job completion. Room edits and other platform results remain intact. Legacy sold-out observations and any prices are not displayed.
- The old individual-page collector is withdrawn. Agoda public autocomplete returned the candidate Sweetfun / Taipei with property ID 59714054. Its returned link leads to the search page, not a verified room-offer page. Property identity and the six-room catalog are not yet confirmed. No guessed replacement is deployed.
- A fresh bounded Booking inspection found an AWS WAF challenge shell rather than property content. The route is now classified as blocked and paused. Challenge execution, alternate identities and retries are not attempted. No challenge payload or user cookies belong in this repository.
- Trip remains paused after its prior restricted result.

## Price rules

Agoda current offers can establish availability and a pre-tax display price, but only a verified total including taxes/fees may enter the comparable-price field. The owner screenshot reference for Room 201 is NT$1,815.10 plus NT$281.34, total NT$2,096.44. This is a historical test reference, never a live fallback. Do not calculate taxes using a fixed multiplier. Match property, room, rate plan, dates, adults, children, rooms and currency between offer and checkout summary. Discount labels must remain attached to their offer.

Agoda sold-out section: adopt only the explicit status for that room and active stay context. Ignore sold-out display prices. A room's absence and an incomplete search remain unknown.

Booking: a returned offer table can provide the included-tax stay total without entering checkout, but only after property/stay context and eligibility are verified. The owner's logged-in screenshot must not establish universal Genius eligibility or authorize copying their session.

No personal fields will be filled and no reservation/payment will be submitted as part of quote verification. Current work establishes quarantine and comparison rules; it does not claim completed live price collection.

## Follow-up diagnostic, 2026-09-08

A bounded inspection using the same isolated browser configuration observed HTTP 502 from Agoda `/graphql/search`, while autocomplete and several layout requests returned HTTP 200. The page explicitly reported a search error. This is not a sold-out response and does not establish a WAF diagnosis. The public partner link for ID 59714054 also redirected to search and did not produce an offer table. No user session, alternative IP, CAPTCHA solution or hidden booking API was used. HAR credentials and tracking parameters are excluded from repository evidence.

Booking remains paused after the previously observed WAF challenge. Repository secret names and dedicated preview project environment names did not reveal an existing authorized OTA API integration. Booking's official Demand API requires Managed Affiliate Partner access, a key and affiliate ID: https://developers.booking.com/demand/docs/getting-started/prerequisites . API eligibility and allowed comparison use must be established before selecting it; these credentials are not inferred from owning a property.

Both health endpoints now report live collection as disabled when every collector is paused or withdrawn. A browser API assertion covers this independently of mocked UI fixtures. No live-price UAT invitation is warranted. The remaining work is a usable permitted data source, actual room/date/plan parsing, and live quote verification on the deployed build.
