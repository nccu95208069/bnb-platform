# Calendar change notifications — 2026-11-03

The owner requested calendar updates after LINE or OTA creates, amends or cancels an order, without waiting for the one-minute refresh. Iron Gate now emits a private notification after an outbox event commits. Sweetfun OS receives only an invalidation and performs its existing authorized calendar read. Source ingestion must still finish first, and display latency includes that read.

## Current release state

The owner explicitly authorized the production notification permissions and trigger on November 3. Migration `iron-gate/sql/022_calendar_realtime_notifications.sql` is applied, and the two active properties have separate server-only topic capabilities. Hosted verification passed: both private subscriptions joined, an unknown topic was denied, client publication failed, an independent same-topic observer received no forged event, a rolled-back notification was absent, and a committed synthetic notification was delivered. These checks did not change a booking, payment or external room state.

The application candidate is built and ready, but **has not been promoted**. Its 825 uploaded source files match frontend commit `f55d2c9` exactly. It starts from the verified production baseline `e3641ad` and retains its calendar read-status changes, credential-renewal probe, competitor-radar routes and release policy. Authenticated browser acceptance of sold/unsold invalidation, reconnection and the resulting current read remains pending. The production website still uses its previous refresh behavior at this checkpoint.

The later source-only integration adds this handoff, the reviewed migration and its isolated test; it does not alter the candidate's frontend bytes. No booking-backend runtime redeployment is required. A Git merge and an application promotion remain separate actions under [the production release policy](PRODUCTION_RELEASE_POLICY.md).

## Behavior and access

- Outbox insertion covers create, date change, cancellation and amendments that do not advance the inventory version. Transaction rollback emits nothing; broadcast errors do not fail a valid booking transaction.
- The private event contains only a property identifier and a decimal cursor. A randomly generated 256-bit topic grants notification receipt only. It grants no booking reads, no mapping-table reads and no publication rights. Topic values and environment contents are never stored in this repository.
- `/api/v1/calendar/stream` validates the current owner/member cookie and every selected property. It binds notification configuration to the corresponding calendar grant, rechecks current membership and credentials every 15 seconds using a fresh authentication wrapper, and closes within four minutes for bounded reconnection.
- The browser receives only `{property, revision}`. It then uses the ordinary authorized calendar endpoints, retaining role redaction, source verification and device-cache isolation. Notifications do not claim OwlNest synchronization or payment completion.
- Both calendar modes keep the stream connected during reads, coalesce bursts and schedule one trailing refresh for a change received during loading. All prepared month windows are invalidated, including the old month after a cross-month move or cancellation. Subscription readiness and reconnection trigger a fresh read; hidden/offline tabs close their streams. The minute refresh remains a recovery fallback.

## Validation and completion checks

The integrated frontend passed 46 focused tests: 14 server/authentication/renewal tests and 32 realtime, read-status, device-cache and synchronization tests. TypeScript, targeted ESLint and the release-policy guard passed. Earlier database validation passed eight isolated PostgreSQL tests covering the real LINE/OTA service paths, RLS boundaries, rollback and unavailable broadcasts; the hosted acceptance above separately verifies delivery and access against the managed service.

Before application promotion, complete authenticated candidate acceptance and confirm that the current production alias, source and settings have not changed. After promotion, verify the actual alias and repeat the affected sold/unsold and reconnection checks. Physical-phone touch acceptance is separate from browser viewport testing. Do not describe the complete calendar feature as live until those application checks pass.

To stop notification delivery, deactivate only the configured property mappings and retain the minute/foreground read paths. Reverting this notification feature must not roll back later booking or finance protections. See [the database bridge contract](CALENDAR_REALTIME_DATABASE_2026-10-30.md) for capability rotation, migration prerequisites and isolated test setup.
