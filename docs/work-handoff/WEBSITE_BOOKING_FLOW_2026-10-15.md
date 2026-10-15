# Studio → published guest site → OS booking repair — 2026-10-15

## Root cause and resulting behavior

The cross-system check opened a newly approved empty calendar without the required owner acknowledgment. `EMPTY_CALENDAR_CONFIRMATION_REQUIRED` was missing from the HTTP error map and became a generic 503. The endpoint now returns actionable 409 responses for missing empty/static-source acknowledgment or source coverage. The integration check asserts that rejection writes nothing, then sends the explicit acknowledgment and verifies successful opening.

The primary OS deployment was still based on `aadb24d`, while the Studio integration check used the separate beta checkout. This change builds on the actual production runtime, plus its documentation-only successor `6c1252a`, preserving the shipped calendar/settings behavior. It brings the booking dependencies needed by the current Studio flow: owner-approved UUID site admission, disabled initial sales, confirmed calendar coverage, CSV/XLSX import, effective readiness, and authoritative order-version/payment readback.

New UUID admission is restricted to existing authenticated Studio clients. The optional `WEBSITE_BOOKING_STUDIO_SELF_SERVICE_ORIGINS` JSON array selects exact existing HTTPS Studio origins; it does not rotate/read secret registries or enable legacy clients. The owner must verify their email, approve the exact site and property, and explicitly open sales. Existing client tokens, exact site grants, calendars and bookings remain intact. Malformed/unregistered origins fail closed. No new email grant is activated by this setting.

## Verification

- 155 backend checks pass, including HTTP routes with a dedicated local Redis instance, authorization, tenant isolation, double-booking races, idempotency, sales rejection/no-write, and order/payment readback.
- 26 DOM checks pass for owner approval, website opening, holds and import controls.
- The full calendar/import/login DOM group also passes all 40 checks. Its first CI run exposed a pre-existing harness omission: the passwordless test provided `window` and `document` but not global `location`, although the shipped component reads `location.search` for its return path. Supplying the real JSDOM location restores the intended lost-response test; it now additionally asserts two requests for the same email. No production login code changed for this correction. CI run `38663159927` passed Backend, Frontend and Customer workspace isolation for the harness follow-up.
- 19 Studio/guest/OS integration scenarios pass using the real Workers and Next route handlers with isolated synthetic stores. The guided builder covers all three layouts, saving a design, publishing its exact revision, owner approval, explicit sales opening, quoting, booking and authoritative order readback.
- A real local browser successfully submitted a synthetic booking and reloaded/queried the same order. No payment or external notification was sent.
- TypeScript passes. ESLint has zero errors and five existing warnings. The local production build passes; deployment build verification is recorded below when available.

## Release and acceptance boundary

Engineering, isolated acceptance and authenticated live browser acceptance are complete. The owner-requested repair is deployed. The owner explicitly authorized the test identity and independent synthetic property/order, then completed the normal email sign-in in the same browser. One clearly marked non-operating test property and one synthetic unpaid reservation were created through the production interfaces; existing customer properties and orders were not changed.

Live acceptance on 2026-10-15 (Asia/Taipei):

1. Created and saved the synthetic property in Studio, checked the three design previews, selected the light layout, and published saved revision 3 to the stable public guest URL. The guest page displayed the synthetic property without requiring the Studio login.
2. Submitted the booking connection from Studio. The verified owner reviewed the matching site identity, one physical room, two-person capacity, initial nightly price of TWD 1,800.50, availability dates and synthetic non-binding terms. Approval created an independent OS calendar, with sales initially closed.
3. Confirmed empty-calendar inventory in OS and explicitly opened sales. OS returned the successful ready state. Refreshed Studio, opened its separate sales switch, and verified that the public guest page became bookable. The formerly failing activation step completed without a 503.
4. Booked one room for two adults for 2026-10-20 through 2026-10-21. The guest page showed one held reservation at TWD 1,800.50, a 24-hour hold deadline and zero recorded payments. Reloading and querying recovered the same reservation. OS listed exactly one held order and its matching dates, room, amount and synthetic contact details.
5. A separate guest tab queried the same room and dates while the hold was active and was rejected for insufficient inventory.
6. Released that hold from the OS order detail. The authoritative readback showed the reservation released/cancelled and no payment entries. The original guest page then showed the same reservation ended; the separate guest tab could quote the same dates again at TWD 1,800.50. No second reservation was submitted.
7. Paused sales in both Studio and OS. The public guest page returned to paused booking, and OS showed zero active holds. The synthetic cancelled order remains as audit evidence; no production record was deleted.

Screenshots are retained as local project evidence only, outside the Git checkout. No owner email, guest lookup code, session information or screenshot was committed. This verifies booking/hold, readback, inventory exclusion, cancellation and release on the deployed services. It does not claim real payment settlement, delivery of booking notifications to a real mailbox, LINE delivery or OTA synchronization; the guest contact was deliberately synthetic and the notification UI remained pending.

Rollback baseline: primary deployment `dpl_HBSeHvEVGsqo83x2A3RPZFzmmQ3c`, runtime `aadb24da920a418f2bef267e78a9854c94e634f2`.

## Verified production release

- Runtime commit: `1ae8320` on `codex/booking-flow-503-20261015`; draft PR [#40](https://github.com/nccu95208069/bnb-platform/pull/40) targets the existing production source branch.
- OS deployment: `dpl_DsyaqZuR4n27mzaY6YxWd9tkZ7rB`, URL `https://sweetfun-76ruigxwd-sweetfuns-projects.vercel.app`. Cloud TypeScript/build passed. Candidate requests exercised configuration parsing and returned the expected application-level 401 for an unauthenticated connection request.
- The exact-origin setting was saved for `https://stayform-ai-studio.nccu95208069.chatgpt.site`. Existing stored credential registries were not read, rotated or replaced. Only the opt-in flag changed.
- Promotion completed, and a separate lookup of `https://sweetfun-os.vercel.app` resolved to this deployment. The public workspace entry returned 200; the same unauthenticated booking-connection probe returned 401 with `UNAUTHORIZED`, not a configuration 503. The browser displays the expected customer login form.
- Studio v60: pushed source `d80fc87dd9d6d4f49dda5630ab4e45bfccea1136`, successful deployment `appgdep_6ad024aed52481918e7542c84e3cb308`, at `https://stayform-ai-studio.nccu95208069.chatgpt.site`. Only the cross-system checks and local preview setup changed; guest Site v13 is unchanged.
- GitHub destination review initially blocked the branch push. Read-only evidence confirmed the authenticated GitHub user owns the existing repository and has ADMIN permission; the remote production branch matched `6c1252a`. The new commit contained application code, synthetic tests and docs only, and key/token scans found no matches. With that evidence the retry was approved and the branch/PR were created.
