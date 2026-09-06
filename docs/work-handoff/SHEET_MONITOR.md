# Sweetfun Sheet monitor

## Status

Implemented on the local `codex/unsold-calendar` branch. Unit tests and a read-only connection to the actual Sheet pass. Production activation is pending the owner's acceptance of the first-time Upstash integration terms, successful storage provisioning, server credential configuration, deployment and a verified scheduled run. The existing site must continue to say automatic synchronization is disabled until those steps occur.

## Behavior and scope

The proposed production schedule is one check per minute. Compare check-ins from Taipei today minus 30 calendar days, inclusive, with no future upper bound. Retain ongoing earlier stays and complete explicit parent groups. Preserve historical records outside the window. Follow a tracked J identity even when its date is changed out of the window; do not infer deletion from omission in a filtered query. Room-night conflicts and whole-property ambiguity remain quarantined. Known historical acknowledgements stay quiet; new or materially changed in-scope issues remain visible.

The initial activation builds a complete private source index. Later runs compare the selected window and affected identities/groups; existing older cards absent from the initial read remain archived. Source rows still require one full bounded A:L read because the Sheet is not date-sorted and deleted/moved identities must be distinguished. No claim is made that the Google read cost is reduced. Dates/identities/schema that cannot be interpreted fail the check rather than remove bookings. An entirely cleared Sheet requires investigation.

Changed content must appear in two successful observations at least 30 seconds apart. Reordering rows does not change the business version. A source error clears the pending candidate. This mitigates delete/reinsert transitions, but is not an upstream transaction-complete signal: a partial batch stable across multiple checks could still be published. A signed upstream batch-complete/version contract remains the stronger future guarantee. Typical expected end-to-end delay is about 1–3 minutes with a visible browser; this is not a latency SLA.

## Contracts

- `GET /api/cron/sheet-monitor`: Vercel scheduler trigger; `POST` invokes the same controlled check for an operator/Agent. Requires server `CRON_SECRET` of at least 32 characters, supplied as a bearer credential. No target Sheet, arbitrary URL, row contents or acknowledgement overrides are accepted from callers.
- `GET /api/v1/sources/sheet/status`: same operator credential, returns enabled state, safe sync status and the last 50 published change summaries. Never returns source rows, Google credentials or original order IDs.
- Calendar GET exposes only its existing anonymized projection, plus last check, last publication, cutoff and `waiting/healthy/confirming/error/stale`. Open browsers refresh each minute and on return to the tab. Source errors retain the last valid snapshot; storage failures return 503 and the browser retains already loaded data. Never fall back from a live storage failure to an older bundled seed or fictional bookings.

The deterministic monitor is a connector worker. Its bounded persistent audit is not the full Mission Manager; creating production blocking child Missions for new conflicts remains a separate integration. All booking and payment writes remain disabled for this source.

## Storage and authorization

Upstash Redis REST holds a private compressed state under `sweetfun:sheet-monitor:v1`. It includes the minimal room/date/platform/amount/payment/check fields and J/L source keys needed for reconciliation, the anonymous projection, pending digest, checks and bounded audit. Guest names, notes, contacts, OTA confirmation IDs and LINE IDs are excluded. It must not be made public or committed. The free resource must use `autoUpgrade=false`, `prodPack=false`, `eviction=false`; a quota failure must preserve existing data rather than automatically purchase capacity.

An expiring 120-second source lock prevents concurrent workers. A Lua commit checks ownership before atomically replacing state, so an expired worker cannot overwrite a newer one. Publication is followed by an authoritative read verification. Functions have a 60-second execution limit; provider requests have bounded timeouts. Compressed storage reduces repeated transfer; uncompressed states above 8 MiB fail before publication. Provider error bodies and secrets are never returned to clients.

The Google reader uses the Sheets read-only OAuth scope, a server credential, fixed spreadsheet ID and exact sheet ID/title/timezone checks. The local existing ingestion service-account key successfully performed an isolated read test; it has not yet been copied into Vercel. A dedicated Sheet-viewer service account is preferable for long-term isolation. No Google writes, Drive watch subscription or upstream Gmail changes are involved.

## Activation and rollback

1. Complete owner-approved Upstash terms and verify a free, non-upgrading, non-evicting resource is linked only to production. Do not overwrite local environment files while connecting it.
2. Configure server-only `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SHEET_MONITOR_GOOGLE_CREDENTIALS` and a newly generated `CRON_SECRET`. Do not print or commit these values. Vercel integration variable names may need explicit mapping to these runtime names.
3. Run the reader/store integration against the intended services without changing Sheet contents. Preserve the existing anonymous bundled seed and historical exception fingerprints.
4. Set `SHEET_MONITOR_ENABLED=true` and keep `CALENDAR_SOURCE=sheet_snapshot`. Merge `frontend/scripts/sheet-monitor-vercel.example.json` into the actual frontend `vercel.json`. A minute schedule is supported by the verified existing Pro team; do not change its billing plan.
5. Build/deploy, verify unauthenticated trigger/status calls return 401, observe two separate real checks and a confirmed publication, then verify production calendar source/version and the human status banner. A manual invocation alone does not prove the scheduler is running.
6. Disable by setting `SHEET_MONITOR_ENABLED=false`, removing the schedule and redeploying. This returns to the bundled snapshot, so first export an approved anonymized latest snapshot as the seed if freshness is needed. Keep Redis state for investigation; never silently delete it or modify source bookings.

## Verification

`node --experimental-strip-types --test tests/sheet-monitor.test.mjs tests/sweetfun-sheet.test.mjs` covers Taipei cutoff, unlimited future, long-stay/group closure, out-of-window moves, history retention, add/change/delete, repeated observations, transient deletion, reorder, conflict acknowledgement and recurrence, empty/schema failures, privacy, status freshness, concurrency/fencing, restart, provider errors, auth, Google read contract and compressed REST round-trip. Tests use synthetic records and mocked provider responses; they do not prove the cloud Redis service or production scheduler is provisioned.

The isolated Google connection read 1,530 current rows successfully, with 1,500 accepted rows, 30 acknowledged historical problem rows and zero new problem rows. It did not publish a new snapshot or modify the Sheet.

All 29 tests pass; the production build passes. Frontend lint has no errors and one pre-existing unused-import warning in the week carousel. `tests/browser/sheet-monitor.js` passed against a local production build: both protected routes reject unauthenticated callers; all five sync states and the cutoff render correctly; returning focus refreshes the calendar. Its status metadata is explicitly simulated in an isolated browser, not a claim that cloud scheduling already works.

Official references: [Vercel scheduling](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Upstash REST](https://upstash.com/docs/redis/features/restapi), [Google service accounts](https://developers.google.com/identity/protocols/oauth2/service-account), [Sheets values read](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get).
