# Sweetfun and OFFLAND Sheet monitor

## Status

Live on https://sweetfun-os.vercel.app/calendar as of 2026-09-06. The owner explicitly authorized OFFLAND credential access, approved Vercel and accepted the Upstash terms. Both property schedules have executed without manual invocation after deployment. Current deployed application: https://sweetfun-8qfcufnbm-sweetfuns-projects.vercel.app. Changes are local on `codex/unsold-calendar` and deployed through the authorized Vercel CLI; no GitHub push/merge is implied.

## Behavior and scope

The production schedule is one check per minute per property. Compare check-ins from Taipei today minus 30 calendar days, inclusive, with no future upper bound. Retain ongoing earlier stays and complete explicit parent groups. Preserve historical records outside the window. Follow a tracked J identity even when its date is changed out of the window; do not infer deletion from omission in a filtered query. Room-night conflicts and whole-property ambiguity remain quarantined. Known historical acknowledgements stay quiet; new or materially changed in-scope issues remain visible.

The initial activation builds a complete private source index. Later runs compare the selected window and affected identities/groups; existing older cards absent from the initial read remain archived. Source rows still require one full bounded A:L (Sweetfun) or A:O (OFFLAND) read because the Sheet is not date-sorted and deleted/moved identities must be distinguished. No claim is made that the Google read cost is reduced. Dates/identities/schema that cannot be interpreted fail the check rather than remove bookings. An entirely cleared Sheet requires investigation.

Changed content must appear in two successful observations at least 30 seconds apart. Reordering rows does not change the business version. A source error clears the pending candidate. This mitigates delete/reinsert transitions, but is not an upstream transaction-complete signal: a partial batch stable across multiple checks could still be published. A signed upstream batch-complete/version contract remains the stronger future guarantee. Typical expected end-to-end delay is about 1–3 minutes with a visible browser; this is not a latency SLA.

## Contracts

- `GET /api/cron/sheet-monitor`: Vercel scheduler trigger; `POST` invokes the same controlled check for an operator/Agent. Requires server `CRON_SECRET` of at least 32 characters, supplied as a bearer credential. No target Sheet, arbitrary URL, row contents or acknowledgement overrides are accepted from callers.
- `GET /api/v1/sources/sheet/status`: same operator credential, returns enabled state, safe sync status and the last 50 published change summaries. Never returns source rows, Google credentials or original order IDs.
- Calendar GET exposes only its existing anonymized projection, plus last check, last publication, cutoff and `waiting/healthy/confirming/error/stale`. Open browsers refresh each minute and on return to the tab. Source errors retain the last valid snapshot; storage failures return 503 and the browser retains already loaded data. Never fall back from a live storage failure to an older bundled seed or fictional bookings.

The deterministic monitor is a connector worker. Its bounded persistent audit is not the full Mission Manager; creating production blocking child Missions for new conflicts remains a separate integration. All booking and payment writes remain disabled for this source.

## Storage and authorization

Upstash Redis REST holds a private compressed state under `<property-id>:sheet-monitor:v1:<source-id>`. Each source has its own lock, state, pending confirmation and audit. The earlier unprovisioned single-source key was replaced before any production activation; there is no cloud state to migrate. State includes the minimal room/date/platform/amount/payment/check/guest-count fields and canonical row/parent source keys needed for reconciliation, the anonymous projection, pending digest, checks and bounded audit. Guest names, notes, contacts, OTA confirmation IDs and LINE IDs are excluded. It must not be made public or committed. The free resource must use `autoUpgrade=false`, `prodPack=false`, `eviction=false`; a quota failure must preserve existing data rather than automatically purchase capacity.

An expiring 120-second source lock prevents concurrent workers. A Lua commit checks ownership before atomically replacing state, so an expired worker cannot overwrite a newer one. Publication is followed by an authoritative read verification. Functions have a 60-second execution limit; provider requests have bounded timeouts. Compressed storage reduces repeated transfer; uncompressed states above 8 MiB fail before publication. Provider error bodies and secrets are never returned to clients.

The Google reader uses the Sheets read-only OAuth scope, a server credential, fixed spreadsheet ID and exact sheet ID/title/timezone checks. The owner-authorized existing ingestion service-account credential is configured only as a sensitive server-side production variable; both actual Sheets were verified. A dedicated Sheet-viewer service account is preferable for long-term isolation. No Google writes, Drive watch subscription or upstream Gmail changes are involved.

## Deployment configuration and rollback

1. Complete owner-approved Upstash terms and verify a free, non-upgrading, non-evicting resource is linked only to production. Do not overwrite local environment files while connecting it.
2. Configure server-only `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SHEET_MONITOR_GOOGLE_CREDENTIALS` and a newly generated `CRON_SECRET`. Do not print or commit these values. The store also supports the integration-provided `KV_REST_API_URL` and `KV_REST_API_TOKEN`; these are the current production credentials.
3. Run the reader/store integration against the intended services without changing Sheet contents. Preserve the existing anonymous bundled seed and historical exception fingerprints.
4. Set `SHEET_MONITOR_ENABLED=true`, `BOOKING_SHEET_SOURCES=sweetfun,offland`, and keep `CALENDAR_SOURCE=sheet_snapshot`. The actual `frontend/vercel.json` contains independent `/api/cron/sheet-monitor/sweetfun` and `/api/cron/sheet-monitor/offland` minute jobs. A minute schedule is supported by the verified existing Pro team; do not change its billing plan.
5. Build/deploy, verify unauthenticated trigger/status calls return 401, observe two separate real checks and a confirmed publication, then verify production calendar source/version and the human status banner. A manual invocation alone does not prove the scheduler is running.
6. Disable by setting `SHEET_MONITOR_ENABLED=false`, removing the schedule and redeploying. This returns to the bundled snapshot, so first export an approved anonymized latest snapshot as the seed if freshness is needed. Keep Redis state for investigation; never silently delete it or modify source bookings.

## Verification

`node --experimental-strip-types --test tests/sheet-monitor.test.mjs tests/sweetfun-sheet.test.mjs` covers Taipei cutoff, unlimited future, long-stay/group closure, out-of-window moves, history retention, add/change/delete, repeated observations, transient deletion, reorder, conflict acknowledgement and recurrence, empty/schema failures, privacy, status freshness, concurrency/fencing, restart, provider errors, auth, Google read contract and compressed REST round-trip. Tests use synthetic records and mocked provider responses; they do not prove the cloud Redis service or production scheduler is provisioned.

Cloud verification: both sources completed two-observation publication, compressed Redis write/read verification, and production API projection checks. The last manual bootstrap ended at 2026-09-06T03:08:10.346Z; later automatic checks advanced to Sweetfun 03:10:13.103Z and OFFLAND 03:10:16.742Z, then continued advancing in the browser. This confirms the deployed schedules run independently of this task.

Initial live publication: Sweetfun 1,530 rows / 1,500 accepted / 30 historical problem rows / zero new; OFFLAND 239 / 235 accepted / four new problem rows. Both source health states were healthy and automatic synchronization enabled. Two properties and seven physical units returned; all bookings were read-only. Unauthenticated calls to both property cron paths and the status path returned 401. Real Sheet edits were not manufactured for this test; addition/change/deletion and transient intermediate states are covered by synthetic tests.

All 35 tests and production build pass. Frontend lint has no errors and one pre-existing unused-import warning in the week carousel. The isolated browser fixture covers all five simulated sync states and focus refresh; it now supports per-source status metadata. Production browser verification confirms property switching, OFFLAND daily detail with nightly amount and total guest count, and advancing actual sync timestamps. Month/week/day switching and an OFFLAND linked two-night detail (10/1–10/3, each night 7,346 TWD, total 14,692 TWD) were also verified in production.

Official references: [Vercel scheduling](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Upstash REST](https://upstash.com/docs/redis/features/restapi), [Google service accounts](https://developers.google.com/identity/protocols/oauth2/service-account), [Sheets values read](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get).

## Multiple properties and verified OFFLAND contract

`booking-sources/config.ts` owns the allowlist of verified sources: target spreadsheet/tab identity, property/room mapping, server credential variable and private seed file. `BOOKING_SHEET_SOURCES` selects registered keys; it cannot register arbitrary targets. Operator/cron/status routes accept a `source` key (default `sweetfun`) after authentication. The adapter namespaces row IDs, parent IDs and issue acknowledgements by source. Reconciliation rejects a state from another source; store reads/commits verify its source ID. Source snapshot reads also verify property and room membership.

The registered OFFLAND source is spreadsheet `1jBJq1xWmM7xKpUxFjsLYQc7EbLAWmcMjQK0SBbaORuc`, `工作表1`, gid `475170922`, Asia/Taipei. The authorized metadata/data read and upstream `src/sheets/offland_updater.py` establish:

- A `房間`: `OFFLAND` and `OFFLAND(連住)` both represent the same physical `offland-villa` / 包棟 unit.
- J `唯一ID`: row identity, present in all 239 initial rows. Do not infer parent relationships from it.
- O `刷卡狀態`: misleading header; the actual writer stores OwlNest order ID here. It is optional parent identity (32 initial rows populated, 207 blank), never proof of card payment. No source headers were changed.
- L `入住人數`: total guest count such as `8人`; distinct from extra guests. Missing values remain unknown.
- G `房費`: formatted TWD such as `NT$10,000`; strict normalization retains the Sheet's nightly amount. Upstream allocation is not proof of original OTA per-night pricing.
- H `全額支付狀態`: 231 blank and eight `not_yet` initially; no confirmed paid state or fabricated receipts. M payment date, N paid amount and P payment UID are initially empty. The read ends at O.
- Names, notes, contact details and original source IDs are excluded from the public projection. The private normalized index keeps only necessary source keys and operational fields.

Initial issues (row numbers at 2026-09-06 import; source edits may move them): 223/224 duplicate J across 2026-09-12 and 2027-01-15; 183/236 overlap the villa on 2026-12-25. These four rows are quarantined and three dates blocked. They are not automatically acknowledged under the owner's earlier Sweetfun historical exception instruction. Other 235 rows are imported, including 24 September room-nights.

The shared collection reads each source independently. One unavailable source produces a property-specific error without replacing it with demo bookings or suppressing the other property. Snapshot membership checks and separate source-prefixed IDs, acknowledgements, locks and commits prevent cross-property mixing. Synthetic tests cover isolation, unknown/prototype source rejection, currency and guest-count normalization, O-column parent grouping, and partial-source failure.

## Remaining boundaries

This monitor does not update Google Sheets, change Gmail ingestion frequency, subscribe to Google push, expose guest identity, publish live room prices, create receipts, or implement the full production Mission Manager. A dedicated viewer-only Google identity is a future credential-isolation improvement. Source overlap markers and bounded monitor audit still need the planned blocking-Mission integration before operational writes are enabled. Upstream atomic batch/version notification and original nightly OTA pricing remain follow-up work.

## Calendar follow-up: continuous stays and names — 2026-09-06

Owner requested real guest names and continuous month-view stays (photo shows a gap between the two nightly cards). Month stays now render as one grid-spanning button per visible week, with collision-free lanes, clipped continuation edges at week boundaries, an in-card guest label and preserved detail/history behavior. Overflow expands whole lanes so a stay never jumps or vanishes midway through the week. Three synthetic layout tests cover adjacent nights, competing arrivals and exclusive checkout/week clipping. Build/lint and 390px browser checks pass; the OFFLAND 11/14–11/16 stay is one two-column bar and opens its two-night detail.

Real guest names are requested but **not enabled yet**: the currently deployed calendar API is unauthenticated and production Supabase settings are placeholders. The owner was asked whether access should be owner-only or owner plus authorized colleagues; no answer received at implementation time. Continue the pending name-display task by establishing the approved authenticated audience, configuring actual login and server-side property membership enforcement, then introducing a private identity projection. Do not merely remove anonymization from the public adapter or retain names in anonymous seed artifacts. Existing J/parent identity rules still govern grouping; equal names never prove a shared stay. Current monitor state deliberately omits names, so displaying them requires a separately protected data read/store path and unauthorized-response tests, not only a UI change.

### Compact month presentation (2026-09-06)

Following the owner's Google Calendar comparison, month bars show room + short channel in one line (Bkg = Booking, Ago = Agoda, Trip = Ctrip, Owl = OwlJourney, 直訂 = direct). Six room lanes are visible by default; selected inventories can raise this to eight. Stays remain one clickable span per week. Full labels and details retain anonymous guest identifiers; real-name access remains pending. Status is now a collapsed native disclosure; failure/stale status and newly disputed rows remain visible outside its expanded explanation. The browser monitor fixture opens this disclosure before checking detailed state text.

Verification: lint, production build, three stay-layout cases, and browser checks at phone/desktop sizes. This changes neither monitoring schedules nor public data projection.
