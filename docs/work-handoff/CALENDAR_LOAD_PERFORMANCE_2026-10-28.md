# Calendar loading performance — first implementation

The owner requested the first two items in the calendar performance plan:
measure loading stages, reuse the server-verified session, and repair adjacent
month prefetch. Payment storage/query redesign and cross-page private caches are
separate work.

## Behavior

- The main server layout passes only the existing public session projection to
  the client guard. Bootstrap occurs in a client effect; rendering on the server
  never mutates the shared client store.
- A request-object-scoped cache reuses member, principal and owner credential
  reads within one request. A new request validates current membership and
  credential bindings again.
- Client initialization reuses a successful check for at most 30 seconds. Window
  focus and calendar access failures explicitly force revalidation. Every API
  request still enforces server authorization. Reset or a newer bootstrap makes
  older pending session responses ineligible to restore access.
- Each month request validates and commits its result before its shared pending
  promise is removed. Fast neighbors become available independently; navigation
  does not discard a completed prefetch from the current scope and generation.
- Scope changes, reloads, versions and authorization failures isolate outstanding
  requests. A reload clears the window cache even when inventory version has not
  changed, so name and payment updates are fetched. The last displayed result
  remains available as an explicitly refreshing/stale fallback.
- Private calendar data remains limited to the mounted view and seven windows.
  No booking cache is written to browser storage or shared between sessions.

## Measurements

`Server-Timing` on calendar/session GET responses exposes fixed numeric
`auth`, `source`, `payment` and `total` durations. Total includes the diagnostic
write before the handler returns. `source` is the inclusive source wait and can
contain Sheet payment stages; `payment` is accumulated stage work across sources.
They are not mutually exclusive and must not be added together. Bounded payment
timeouts are timed when the reader emits its completed stage event, not when a
late provider promise eventually settles.

The browser records `calendar.auth`, `calendar.open` and `calendar.range` measures.
Calendar display waits for coverage, including an empty but successfully loaded
month, and two animation frames. Direct entry starts at browser navigation;
later in-app mounts start at mounting. Range timing starts when the new range is
committed, so it excludes input dispatch overhead. These timings describe a paint
opportunity, not a physical-display or physical-device measurement.

Opening `/calendar?calendar_perf=1` enables local console diagnostics with fixed
metric names and numeric timings, including the allowed Server-Timing stages.
No date ranges, query strings, guest data, IDs, credentials or response bodies are
logged. The navigation entry preserves diagnostic opt-in after URL normalization.
Nothing is sent to a separate analytics service.

## Validation and release boundary

Regression coverage includes bootstrap/no extra session request, stale-store
bootstrap recovery, focus revocation, role changes, logout during a pending
request, month completion ordering, navigation during prefetch, old generation
isolation, version changes, background authorization failure, and payment/name
changes without a new inventory version. Diagnostics are tested against both
successful and timed-out reads and for exclusion of private values.

Local compilation, authorization and DOM verification are complete. Release
identity, authenticated browser measurements and comparison evidence are kept
outside this public repository. Small-sample controller-observed timings include
browser automation overhead; they do not establish p95 or a service-level target.
