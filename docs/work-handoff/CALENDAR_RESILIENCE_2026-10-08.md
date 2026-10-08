# Sweetfun OS calendar resilience — 2026-10-08

## Incident and approved scope

On 2026-10-07 at 23:00–23:03 Asia/Taipei, the authenticated operational calendar returned 503 even though both anonymous booking snapshots still existed. The old route treated a failure while attaching private Sheet fields or payment information as a failure of the entire calendar. The exact transient provider cause was not recoverable from the old generic error handling. The owner approved phased remediation. WEB-04 was initially paused and was subsequently resumed by its human owner in the website chat.

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

Phase 1 runtime `7464b51` is live on `https://sweetfun-os.vercel.app`. The staged production deployment `dpl_9xLhLXkdJBSSHShQ4LRH38U3HTo4` passed the default cloud build; anonymous calendar reads returned 401. Promotion and primary-domain readback succeeded. A fresh authenticated browser page displayed both properties, and the UI showed separate successful/attempted timestamps. Calendar requests at approximately 00:19 and 00:20 Asia/Taipei returned 200 with sanitized stage logs. No booking/payment/notification mutations were used for acceptance.

The attempted local authenticated candidate probe could not read the protected owner-session configuration through `vercel env run`; this is a local secret-access limitation, not a production authentication failure. Authenticated readback was completed in the normal logged-in browser after promotion.

The previous website runtime is preserved. The website chat's human subsequently resumed WEB-04 acceptance; that work remains in the website chat. No website API contract was changed by this calendar release.

## Phase 2 — private server snapshots and independent backup

Implementation now saves an entire property's calendar, including private names, notes and last-confirmed payment status, only after successful current-source verification. A month slice, redacted price response, empty snapshot, failed payment read, pending revision or mismatched current private row cannot replace the complete saved view. The authenticated API prefers a last-good private view during an occupancy, name or payment provider failure. It returns the saved timestamp and readonly flags; the normal property and price projection runs on every request. Revoked membership and an authentication-store outage still fail closed. No private content or backup URLs are placed in public/browser persistent storage.

Both stores hold AES-256-GCM encrypted, compressed envelopes with per-source keys derived from the existing protected owner-session secret. Redis atomically keeps the last three distinct versions, fences older completions, and expires after 30 days. Private Vercel Blob uses immutable version paths and keeps three distinct versions after each verified write. Reads reject captures older than 30 days and can recover from a corrupt newest envelope using an earlier valid version. Secret rotation invalidates older ciphertext until new successful snapshots are produced.

The primary refreshes on successful calendar reads and the existing one-minute Sheet monitor. The monitor reuses its Sheet response, without storing names in anonymous monitor state or adding a Google request. Its five-minute slots also refresh the independent Blob replica; backup age is explicit. Replica failures are logged without failing a successful live calendar. A source/storage outage cannot bypass login or property authorization.

Dedicated private store `sweetfun-calendar-private-backup` (`store_UspHre2e0fjLIqP1`, hkg1) is connected only to `sweetfun-os` production. `CALENDAR_BACKUP_BLOB_STORE_ID` selects it; production uses project OIDC and the dedicated encrypted read-write token supports approved local maintenance. A synthetic file passed real private write/read verification and anonymous HTTP 403, and was deleted after testing. No existing guest bookings, finance records or outbound notifications were changed.

Additional verification covers real Redis ordering/history, encrypted envelope tampering and expiry, independent replica failure, corrupt latest copy, first page load, previously unvisited months, empty/failed source responses, API property/price restrictions and access revocation. A scheduled-route integration test verifies one Google values read produces both the anonymous monitor and a separate encrypted private snapshot. The combined checks comprise 63 service/route/storage regressions and 6 DOM checks; TypeScript and full lint pass (six pre-existing warnings). Local default Turbopack is blocked by this host’s port-binding restriction; the local Webpack build and default cloud build both pass. Phase 2 runtime `4546190` was promoted as `dpl_ddjJub7sBeP8FfRrgeZij5jxuybX`; the no-intervening-release guard confirmed the previous `dpl_9xLhLXkdJBSSHShQ4LRH38U3HTo4` before promotion. Candidate app authentication returned 401/private/no-store after valid deployment access. Primary alias readback confirms the new deployment, and a fresh authenticated page at approximately 00:52 Asia/Taipei displayed both properties with healthy sync. Both stores are populated and have been read back. The independent Sweetfun copy was captured at 00:55:32.579 and OFFLAND at 00:55:24.484 on October 8 Asia/Taipei; their encrypted envelopes were 309,681 and 51,793 bytes. Both corresponding anonymous Blob requests returned 403. Primary copies continued refreshing at 00:55–00:56. These are actual production worker outputs, not synthetic seed files. Fault injection remains isolated to the test environment; no production source was disabled to demonstrate fallback. Rollback target is the previous Phase 1 deployment.
