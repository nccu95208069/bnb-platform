# Sweetfun OS calendar resilience — 2026-10-08

## Incident and approved scope

On 2026-10-07 at 23:00–23:03 Asia/Taipei, the authenticated operational calendar returned 503 even though both anonymous booking snapshots still existed. The old route treated a failure while attaching private Sheet fields or payment information as a failure of the entire calendar. The exact transient provider cause was not recoverable from the old generic error handling. The owner approved phased remediation; WEB-04 acceptance remains paused.

## Phase 1 behavior

- Read snapshots, private guest details and payments separately for each authorized property. Each read has a 6.5-second deadline. Google reads receive cancellation signals; optional late completions never replace the response.
- If guest details fail, retain snapshot bookings and explicitly mark names/notes unconfirmed. If payments fail or return an incomplete ledger response, mark payment status unknown and remove current-paid claims for that property.
- Keep a failed property's missing snapshot distinct from empty inventory; another property's data remains available. All snapshots unavailable still returns a private, uncached 503.
- Retain data only in mounted browser memory after a refresh failure. Retries remain readonly until success. Unloaded date coverage is blocked, malformed successes cannot replace the prior view, and late older requests are ignored.
- Scope retained data to member identity, role and property permissions. A 401/403, logout or scope change clears it. No private calendar is written to browser persistent storage.
- Preserve readonly flags across contiguous stay segments and all affected parent-order segments. Snapshot views block calendar payment and notification-mark actions; payment APIs continue to require their existing authoritative checks.
- Track the last successful confirmation of the published snapshot separately from the latest attempted check. Failed or still-pending observations do not advance successful confirmation time. Older states show an unknown successful timestamp until a successful check runs.
- Emit sanitized stage, property, HTTP status, duration, release and request ID logs. Persist phase health and at most 200 failure/recovery events for 30 days in `sweetfun-os:calendar-health:v1:{state,history}`. Older request completions cannot regress health. The third consecutive failure emits a `calendar_consecutive_failure` alert log; no email or LINE alert is sent. Diagnostics have a 500 ms deadline and cannot fail the calendar.

## Verification

- 57 service/route/auth/privacy/regression checks pass, including 429, timeout, malformed/empty responses, one-property failure, payment failure, partial ledger responses, readonly fallback, successful-time semantics and revoked membership.
- DOM tests cover initial loading, retained readonly data throughout retry, malformed responses, new date coverage, old request completion, access revocation, scope changes and absence of browser persistent data.
- Real local Redis tests verify third-failure alerting, recovery, monotonic updates, 200-event limit and retention expiry. Diagnostics provider failure does not reject the calendar.
- Full frontend lint passes with six pre-existing warnings. TypeScript passes. Local production build passes with Webpack; default local Turbopack cannot follow this checkout's shared `node_modules` symlink. The staged cloud build will validate the default production builder.
- All simulated failures use isolated synthetic fixtures. Production Sheet bookings, payments and guest notifications are not modified by these tests.

## Release status

Pending staged production build and live readback. This change is based on the existing website lifecycle runtime and retains that release's behavior.

## Remaining approved phase

A complete, versioned private last-good snapshot (guest details and payment state included) and an independent backup store are not yet implemented in Phase 1. Present fallback uses the existing anonymous server snapshot plus any already-loaded browser view. Independent storage cannot bypass current authentication or property/price authorization; an authentication outage still fails closed. No secondary storage is currently configured on this Vercel project.
