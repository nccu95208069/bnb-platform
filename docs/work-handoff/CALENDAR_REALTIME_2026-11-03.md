# Calendar change notifications — 2026-11-03

The owner requested calendar updates after LINE or OTA creates, amends or cancels an order, without waiting for the one-minute refresh. Iron Gate now emits a private notification after an outbox event commits. Sweetfun OS receives only an invalidation and performs its existing authorized calendar read. Source ingestion must still finish first, and display latency includes that read.

## Current release state

The owner explicitly authorized the production notification permissions and trigger on November 3. Migration `iron-gate/sql/022_calendar_realtime_notifications.sql` is applied, and the two active properties have separate server-only topic capabilities. Hosted verification passed: both private subscriptions joined, an unknown topic was denied, client publication failed, an independent same-topic observer received no forged event, a rolled-back notification was absent, and a committed synthetic notification was delivered. These checks did not change a booking, payment or external room state.

The application is **live on the primary domain** after the owner explicitly approved the exact candidate-to-production switch. Authoritative deployment lookup confirms that [sweetfun-os.vercel.app](https://sweetfun-os.vercel.app) serves READY deployment `dpl_AGnuMq4pFM8xcuA3waVDdPtbKXJ5`. Its 825 uploaded source files match frontend commit `f55d2c9` exactly. It starts from the verified production baseline `e3641ad` and retains its calendar read-status changes, credential-renewal probe, competitor-radar routes and release policy.

Authenticated owner-browser acceptance passed on both the staged deployment and the primary domain. The direct deployment URL remains [sweetfun-ar8zxf36n-sweetfuns-projects.vercel.app](https://sweetfun-ar8zxf36n-sweetfuns-projects.vercel.app). The previous deployment, `dpl_DkGRnQAn6kmubfMFsJqfWFkgm4nT`, is the compatible recovery target for this release; confirm that no newer production changes would be lost before using it.

The later source-only integration adds this handoff, the reviewed migration and its isolated test; its newer commit hashes do not alter runtime `f55d2c9` or the deployed frontend bytes. The booking-backend runtime was not redeployed. PR #132 remains draft and unmerged; application promotion and Git merge are separate actions under [the production release policy](PRODUCTION_RELEASE_POLICY.md).

## Behavior and access

- Outbox insertion covers create, date change, cancellation and amendments that do not advance the inventory version. Transaction rollback emits nothing; broadcast errors do not fail a valid booking transaction.
- The private event contains only a property identifier and a decimal cursor. A randomly generated 256-bit topic grants notification receipt only. It grants no booking reads, no mapping-table reads and no publication rights. Topic values and environment contents are never stored in this repository.
- `/api/v1/calendar/stream` validates the current owner/member cookie and every selected property. It binds notification configuration to the corresponding calendar grant, rechecks current membership and credentials every 15 seconds using a fresh authentication wrapper, and closes within four minutes for bounded reconnection.
- The browser receives only `{property, revision}`. It then uses the ordinary authorized calendar endpoints, retaining role redaction, source verification and device-cache isolation. Notifications do not claim OwlNest synchronization or payment completion.
- Both calendar modes keep the stream connected during reads, coalesce bursts and schedule one trailing refresh for a change received during loading. All prepared month windows are invalidated, including the old month after a cross-month move or cancellation. Subscription readiness and reconnection trigger a fresh read; hidden/offline tabs close their streams. The minute refresh remains a recovery fallback.

## Validation and completion checks

The integrated frontend passed 46 focused tests: 14 server/authentication/renewal tests and 32 realtime, read-status, device-cache and synchronization tests. TypeScript, targeted ESLint and the release-policy guard passed. Earlier database validation passed eight isolated PostgreSQL tests covering the real LINE/OTA service paths, RLS boundaries, rollback and unavailable broadcasts; the hosted acceptance above separately verifies delivery and access against the managed service.

PR #132 at `610a8e0` also passed all five CI jobs: Frontend, Backend, Iron Gate, Customer workspace isolation and Production release policy. The pre-promotion remote check confirmed that `main` was still `e3641ad` and the production alias still served its previously verified deployment. The separate mobile unsold-layout change in draft PR #131 is not part of this release and was neither merged nor deployed at that check.

Authenticated staged acceptance used metadata-only synthetic notifications with the real production read paths; it did not create or modify bookings, payments or room inventory:

- With both properties selected in sold mode, each of two notification rounds advanced both successful-read timestamps within approximately four seconds. The rounds were 25 seconds apart, demonstrating updates before the one-minute fallback.
- In unsold mode, a Sweetfun notification completed the current-month authorized read in 2.85 seconds and rebuilt all five prepared following months. An Offland notification completed the corresponding read in 2.08 seconds and likewise rebuilt its five following months.
- At a 390 × 844 browser viewport, an Offland sold-mode notification advanced the successful-read timestamp within approximately three seconds, without horizontal overflow.
- Browser reload restored the subscription, and a subsequent notification again triggered a successful current read.

After promotion, authenticated primary-domain acceptance independently verified:

- Both properties in sold mode advanced their successful-read timestamps within approximately three seconds of a notification.
- Offland and Sweetfun unsold current-month reads returned HTTP 200 in 2.24 and 3.36 seconds respectively, with all five prepared following months rebuilt successfully for each property.
- The browser's EventStream received a property-scoped change 0.237 seconds after the synthetic notification was sent. The ensuing authoritative availability read returned HTTP 200 in 4.00 seconds after the event.
- Browser reload and a temporary actual offline/online transition restored the stream. After reconnection reported ready, another notification reached the EventStream in 0.239 seconds. Normal network settings and the original viewport were restored after acceptance.

These primary-domain checks used notification metadata only and did not create or modify a booking, payment or room-inventory record. Browser viewport testing does not establish physical-phone acceptance. A manual hidden-tab experiment is not claimed; hidden-tab lifecycle behavior retains automated regression coverage. The separate unsold-layout issue remains with unshipped PR #131.

The final production readback confirmed both notification mappings active and the trigger enabled, with the outbox count and maximum event cursor unchanged from the acceptance baseline. The 06:38:52–06:48:52 UTC runtime-log scan found no error or fatal entries. The final primary browser showed both sold calendars healthy, with normal network settings restored.

To stop notification delivery, deactivate only the configured property mappings and retain the minute/foreground read paths. Reverting this notification feature must not roll back later booking or finance protections. See [the database bridge contract](CALENDAR_REALTIME_DATABASE_2026-10-30.md) for capability rotation, migration prerequisites and isolated test setup.
