# Calendar change intake — 2026-10-07

Status: implemented and locally verified in commit `b269a5b`, pushed to draft PR #26. Production activation awaits explicit owner approval; no new production environment variables or deployment have been applied.

## Owner decisions

- One authenticated intake covers booking create/update/cancel, room open/close, channel prices, and sales probability changes for Sweetfun and OFFLAND.
- A producer notifies OS only after its authoritative write and readback. Receiving a notification is not proof that reconciliation is complete.
- Gmail ingestion remains in the existing order service (Gmail Watch / Pub/Sub -> validated Sheet write). OS reads the authoritative Sheet; it does not build a second mailbox writer.
- LINE booking actions retain the existing owner's confirmation and verified write workflow.
- bnb-pricing is responsible for its authorized three-day pricing workflow and verified OwlNest writeback; OS receives actual prices and model provenance through the intake.
- Routine OwlNest observation should run once daily at a persisted random time between 08:00 and 09:00 Asia/Taipei. Order notifications must not cause extra OwlNest polling.
- Sheet occupancy and last-observed channel inventory are separate facts. Stale channel stock must not overwrite an authoritative unsold Sheet observation. Unsold does not promise a channel is open for sale.

## Coordination and TODO

- [x] Contact the owner-authorized `bnb-pricing` session for its current runner, readback, snapshot and retry contract.
- [x] Complete and validate the OS receiver and producer contract.
- [x] Deliver the final callback contract to bnb-pricing and verify its existing client against the local receiver for both properties.
- [ ] **Deferred at the owner's explicit request:** after the receiver is ready and the current booking-assistant deployment is complete, coordinate LINE / Gmail / room-toggle callbacks with `訂房小助手`. Do not interrupt or modify its deployment. This remains required follow-up work, not a completed integration.
- [x] Verify controlled duplicate, stale, concurrent and interrupted deliveries in isolated local Redis without changing real bookings, room availability or OwlNest prices.
- [ ] Record release and production activation evidence; do not call local implementation deployed.

## Current evidence

- Existing Sheet monitor polls once per minute and requires two stable observations at least 30 seconds apart for changed rows. Preserve that protection against transient or incomplete source reads.
- Current calendar screens poll once per minute. A durable revision/check path is needed to expose source changes promptly without depending on a specific browser session.
- Current live availability incorrectly lets a historical OwlNest zero count or lock replace the Sheet-unsold state.
- Current header reads the first queried cell's observation timestamp, which can be a historical date outside the refreshed interval.
- bnb-pricing's three-day two-property runner is under construction; do not describe it as already enabled.

The final HTTP schema, authentication configuration, tests and release evidence will be added here as implementation is verified.

## HTTP contract

- `POST /api/v1/calendar/changes`, JSON (maximum 2 MiB), dedicated `Authorization: Bearer` credential. Cookie sessions do not authorize writes.
- Required envelope: `schema:1`, `event_id` (8–128 ASCII identifier), `property_id` (`sweetfun` / `offland`), UTC `occurred_at`, `source_version`, nonempty unique `changes` (`booking`, `prices`, `sales_probability`, `inventory`), `verified:true`.
- Prices/probabilities require the existing schema-1 `pricing_snapshot`; its version equals `source_version`. Complete producer export is accepted, merged by date/room; omitted dates are retained. Stock-only notifications use `inventory_snapshot:{version,observed_at,cells:[{date,room,count,is_lock}]}`. Unknown envelope/cell fields are rejected; do not send guest information.
- A callback means the producer already completed authoritative write/readback. Booking callbacks re-read the configured Sheet and preserve its two-observation/30-second confirmation rule. They do not write Sheets and never read OwlNest.
- POST `200` + `verified:true` = applied. `202` = durably accepted and awaiting checks. Retry the same event/body; cron also resumes due events every minute. `409` = reused ID with different body, superseded, partially applied or failed; inspect rather than inventing a new ID. `429` = queue/rate bound, retry later.
- GET the returned relative `status_url` using the same credential; verify `event_id`, `source_version`, `verified:true`. GET `200` alone is insufficient. Receipt proves publication at `completed_at`, not that later observations do not exist.
- Per-property serialization, immutable event bodies, atomic snapshot/receipt commits with compare-and-set, readback, 30-day terminal receipt retention. Pending events are durable; up to eight checks with 30-second to 5-minute backoff, then explicit `failed`.
- Maximum 100 outstanding events/property and 60 new events/client/property/minute. Exact retries do not consume new-event quota.
- Errors return fixed codes without upstream content or credentials.

## Configuration / access

`CALENDAR_CHANGES_ENABLED=true` enables intake/recovery. `CALENDAR_CHANGE_CLIENTS` is a JSON array of `{id,token_sha256,properties,changes}`. Each service has a distinct random token of at least 32 characters; only its SHA-256 hash is configured on OS. Configurations are server-only and never committed. Producers keep `CALENDAR_CHANGE_URL` and `CALENDAR_CHANGE_TOKEN` in their private runtime. No global Redis credential is required by a producer.

Authenticated UI GET without `event_id` returns only a property-scoped revision; no raw prices, guest fields or service receipts. Visible calendars check every 15 seconds and reload only after a version change; existing minute refresh remains available.

## Occupancy, prices and routine observation

Sheet determines sold/unsold/conflict. Channel inventory is displayed separately with its last-observed time; old zero count/lock cannot turn Sheet-unsold into unknown/blocked. A newer manual OwlNest read takes precedence over older stock overlays. Prices, probabilities and inventory each preserve their own timestamps. Price header uses the latest actual price observation across snapshot cells, not the first displayed historical cell.

`CALENDAR_DAILY_OBSERVATION_ENABLED=true` enables one daily read attempt per property at a persisted random minute during 08:00–09:00 Asia/Taipei. The cron checks the stored plan in that window; it does not poll OwlNest each minute. A durable claim is saved before the single OwlNest GET. Overlapping deliveries, restarts, failures and uncertain outcomes do not cause extra automated reads that day. Failed/interrupted checks retain prior observations; manual refresh or the next day can recover. Missed windows are not caught up after 09:00.

## Verification

44 domain/integration regressions + 1 DOM test pass. Existing `calendar_outbox.py` successfully completed Sweetfun and OFFLAND synthetic outbox → actual local POST handler → Redis → GET proof → durable verified state. Producer files were read only; no production callbacks or OwlNest changes were used for this test.

- Isolated local Redis 7.2.5: actual Lua scripts, concurrent enqueue, exact duplicate, ID conflict, property/client receipt isolation, stale publisher fences, read/write races, delayed observation protection, pending Sheet change surviving processor restart, ≥30-second confirmation, route POST→GET readback, disabled/auth rejection, no OwlNest calls from intake, daily schedule concurrency/failure behavior.
- Availability regression: Sheet occupancy stays independent, newer stock overlay wins, newer manual stock wins, stock callback does not freshen price timestamps.
- DOM: version change triggers refresh once; unchanged revisions and hidden screens do not reload.
- TypeScript and production build pass. ESLint has only pre-existing warnings after new unused test imports were removed.

## Remaining integrations

- bnb-pricing supplied a default-disabled client/outbox with offline tests; three-day pricing automation is not claimed enabled. Interface handoff sent; production enablement remains in that producer's approved workflow.
- LINE/Gmail/toggle callbacks remain deferred per owner. This task did not message or modify the booking-assistant deployment.
- A separate WEB-04 consultation reported a potential OFFLAND order-ID mapping discrepancy (writer Q vs reader O). This is unverified producer/schema evidence and must be checked against the live header and deployed writer before changing any mapping. Do not fold a hold lifecycle or schema migration into this release.

## Release handoff

- Existing production baseline remains `dpl_AybNCF8mH99eVjENCapnqchTc1h2` (2026-10-06 main Sheet notes release).
- Automatic approval review rejected the attempted creation of `CALENDAR_CHANGE_CLIENTS`, `CALENDAR_CHANGES_ENABLED`, and `CALENDAR_DAILY_OBSERVATION_ENABLED`, stating that persistent production configuration/scheduled activity needs explicit authorization. No commands in that rejected operation ran. Owner approval was requested with the exact scope.
- After approval: install the prepared scoped configuration without printing values, stage the tested production commit, validate auth/field/property rejection without sending fabricated production prices, promote, verify both calendar screens, and record actual deployment evidence here. Hand the producer its private configuration path only after endpoint acceptance. Keep the producer's schedule/activation decision in its own workflow.
- Dedicated credential material is local, ignored and mode 0600; never place it in this document or the PR. It grants only two-property pricing/probability/inventory intake, no booking writes and no Redis access.
