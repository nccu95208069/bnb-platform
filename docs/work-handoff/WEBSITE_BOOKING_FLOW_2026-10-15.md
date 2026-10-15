# Studio → published guest site → OS booking repair — 2026-10-15

## Root cause and resulting behavior

The cross-system check opened a newly approved empty calendar without the required owner acknowledgment. `EMPTY_CALENDAR_CONFIRMATION_REQUIRED` was missing from the HTTP error map and became a generic 503. The endpoint now returns actionable 409 responses for missing empty/static-source acknowledgment or source coverage. The integration check asserts that rejection writes nothing, then sends the explicit acknowledgment and verifies successful opening.

The primary OS deployment was still based on `aadb24d`, while the Studio integration check used the separate beta checkout. This change builds on the actual production runtime, plus its documentation-only successor `6c1252a`, preserving the shipped calendar/settings behavior. It brings the booking dependencies needed by the current Studio flow: owner-approved UUID site admission, disabled initial sales, confirmed calendar coverage, CSV/XLSX import, effective readiness, and authoritative order-version/payment readback.

New UUID admission is restricted to existing authenticated Studio clients. The optional `WEBSITE_BOOKING_STUDIO_SELF_SERVICE_ORIGINS` JSON array selects exact existing HTTPS Studio origins; it does not rotate/read secret registries or enable legacy clients. The owner must verify their email, approve the exact site and property, and explicitly open sales. Existing client tokens, exact site grants, calendars and bookings remain intact. Malformed/unregistered origins fail closed. No new email grant is activated by this setting.

## Verification

- 155 backend checks pass, including HTTP routes with a dedicated local Redis instance, authorization, tenant isolation, double-booking races, idempotency, sales rejection/no-write, and order/payment readback.
- 26 DOM checks pass for owner approval, website opening, holds and import controls.
- 19 Studio/guest/OS integration scenarios pass using the real Workers and Next route handlers with isolated synthetic stores. The guided builder covers all three layouts, saving a design, publishing its exact revision, owner approval, explicit sales opening, quoting, booking and authoritative order readback.
- A real local browser successfully submitted a synthetic booking and reloaded/queried the same order. No payment or external notification was sent.
- TypeScript passes. ESLint has zero errors and five existing warnings. The local production build passes; deployment build verification is recorded below when available.

## Release and acceptance boundary

Engineering and isolated acceptance are complete. Production deployment/probe results will be appended after verification. No production customer record has been created during this repair.

The production customer login is not yet authorized for a specific Google account. Automatic approval review rejected the Google sign-in click for that reason; the user was asked to identify/authorize an account or sign in themselves. Until that is supplied, the authenticated live create/publish/approve/book/readback acceptance remains pending. Do not describe isolated tests as a completed live booking or as provider-email delivery verification.

Rollback baseline: primary deployment `dpl_HBSeHvEVGsqo83x2A3RPZFzmmQ3c`, runtime `aadb24da920a418f2bef267e78a9854c94e634f2`.
