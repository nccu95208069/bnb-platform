# Safari UAT work, 2026-09-08

Status: **in progress, not owner acceptance**.

Verified starting state:
- PR 16 HEAD `7f0afd30beb50b245454376bb845ee77f910bdd7`, open and stacked on PR 15.
- No Actions runs returned for that exact HEAD.
- Public alias points to `dpl_AuPu6FCZNCCa4B83SEjK1vzKyjeL`; health reports `ffd12bcf7e438d04dafdff9029480468a46187d3`.
- Deployment script already uses an exact-revision gate and current source paths. The handoff's claim that it still pins an old SHA is stale.
- Both PR 16 review findings already have code fixes and tests, and both threads were resolved after test verification.
- PR 15 has additional unresolved findings. Partial portal searches/records must fall back instead of asserting uniqueness. Database attribution/timestamp findings remain outside this browser-only deployment and block merging those migrations; no migration has been applied by this task.

Changes under verification:
- Website draft appears before registry lookup completes; registry merges evidence into current edits.
- Browser-local save/restore includes a fixed date window, edited rooms, completed platform scans and pending job handles. Stored snapshots retain capture times.
- Short start request and polling use an isolated no-network Sandbox mailbox. Results can be recovered for 15 minutes across Function instances. No new service or database is provisioned. This does not provide permanent server storage or cross-device sync.
- Historical probe workflows are manual only.
- Mobile overview uses room cards; charts are hidden until prices exist.
- Agoda generic page price nodes are not accepted. Returned listing, room, dates, adults, children, room count and currency must match before a dated state is adopted. Unproven results stay unknown.
- Browser egress has a domain allowlist and private-address exclusions. A blocked response stops subsequent dates on that path.

Capability limits:
- Official website and registry: real public requests, independent failure states.
- Booking: property/catalog attempt only, no dated price or quantity.
- Agoda: five known Sweetfun room URLs, 102 unknown; Offer-scoped status and returned controls are now checked independently; latest live verification is pending. No generic discovery or price claim.
- Trip: blocked on the real attempt at 2026-09-08T04:11:20.414Z; default collection is paused with that timestamp retained. No repeated requests or adopted price/quantity. Re-enabling requires a changed collection route and explicit deployment configuration.
- Public core OTA UAT requires at least one real accepted dated observation. Mocked browser tests do not satisfy that gate.

Acceptance evidence must name an exact commit. Working-tree build/test output is development evidence only.

Live evidence before the latest parser revision:
- `d85ac87d204a5447344f341fd9cf6d26ded4c5e9`: official website returned six room definitions; official registry matched Hotel_A15010000H_035813 with TotalRooms 5.
- Agoda returned five correct room headings, but the original parser did not verify context. Booking returned no verifiable identity/dates. Trip returned restricted alternatives and was stopped.
- A bounded inspection of the accessible Agoda 101 page found actual visible checkInBox/checkOutBox `data-date` values, a USD currency control, and a property Offer region with a sold-out status and source-generated search link carrying adults=2, children=0, rooms=1 and matching stay dates. The request's TWD parameter had been ignored, so that request was not accepted as TWD. The revised collector explicitly requests and verifies USD.
- The collector never derives returned dates from the requested URL, and does not adopt generic page/recommendation prices. Tests cover missing children, currency changes, different rooms/listings, mismatched Offer dates, absent status, and contradictory bookable offers.
- The initial Sandbox network policy used unsupported IPv6 CIDRs. The deployed correction retains IPv4 private-address exclusions and disables IPv6 before navigation.
