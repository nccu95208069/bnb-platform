# Website booking integration v1

Implementation contract agreed between the website, OS and booking assistant on
2026-10-07. This document describes the implemented native contract; release evidence
and limits are recorded at the end. No production activation is implied.

## Owner-authorized connection

The private editor uses a configured service credential whose allowed `siteIds`
and editor origin are server-owned. A guest/browser never receives this token or
a booking binding token. Service routes reject cookie authentication.

`POST /api/integration/website-booking/v1/connections`

`prepare` request:

```json
{
  "schemaVersion": 1,
  "action": "prepare",
  "requestId": "UUID-v4",
  "siteId": "configured-site-id",
  "siteName": "Example property",
  "ownerEmail": "verified-owner@example.invalid",
  "configurationHash": "64-lowercase-hex",
  "reservationConfig": {},
  "roomRecords": [{"id":"content-room-id","name":"Double room"}]
}
```

`reservationConfig` is the website's public reservation configuration, with
`ownerEmail` omitted. Its hash is SHA-256 of the exact JSON serialization
`{reservationConfig,roomIds:roomRecords.map(r=>r.id)}`. OS independently validates
and recomputes it. The hash is a version, never write authorization.

Response: `{schemaVersion:1,state:"awaiting_owner",connectionId,configurationHash,
approvalUrl,expiresAt}`. The opaque connection lasts 60 minutes. The approval URL
is on the configured OS origin: `/website-booking?connection=<uuid>`. It contains
no credential. The editor can open it in a second tab and retain its progress.
Identical prepare retries recover the original connection; changed content with
the same request ID is rejected. The service also provides `status` with
`{schemaVersion:1,action:"status",siteId,connectionId}`.

OS requires a verified email matching the intended owner, shows the actual
configuration, and requires explicit inventory and policy confirmation. New
owners can verify email through the existing browser-bound login flow. They can
create a native calendar without Sheet/OwlNest, or select an eligible native
property they own and explicitly map content room types to physical room IDs.
No browser-supplied workspace ID is authoritative without the owner's membership
check. Existing or imported unknown inventory is never assumed empty.

On approval, OS atomically saves the workspace/property, binding, site index and
consumed connection. `status` then returns to the private editor:
`{schemaVersion:1,state:"connected",bindingId,bindingToken,configurationHash,
inventoryMode,calendarUrl}`. The editor stores the token in private server
metadata and strips it from its browser response. No token travels in a URL.

One client/site has one binding. A fresh `prepare` for that site is a pending
configuration change requiring the same original owner and explicit approval.
Public bootstrap/quote/reservation calls cannot change configuration. Existing
quotes are invalidated on a configuration change. A connection cannot silently
switch an existing site to a different property or owner.

## Guest service

Keep the existing five POST actions:
`/api/integration/website-booking/v1/bindings/{bindingId}/{action}`. Use the
binding's server credential and common envelope
`{schemaVersion:1,configurationHash,source:"Official Website"}`. Extra authority
fields such as tenant, workspace, actor, room IDs, price and total are rejected.

| Action | Input beyond common envelope | Response |
| --- | --- | --- |
| `bootstrap` | none | `schemaVersion:1,state:ready/unavailable,inventoryMode:platform_only/owlnest,configurationHash` |
| `availability` | `checkIn,checkOut,roomTypeId,quantity,adults,children` | `options[{roomTypeId,availableUnits}],availabilityToken,checkedAt` |
| `quotes` | same stay plus `availabilityToken` | `quoteId,currency:TWD,totalCents,expiresAt,nightly[{date,unitPriceCents,quantity}]` |
| `reservations` | `quoteId,guest{name,email,phone,note},acceptedPolicy:true,idempotencyKey` | reservation status below |
| `requests` | original `idempotencyKey` | current reservation status or `not_found` |

Availability is a short-lived observation, not a lock. Quotes expire after five
minutes. Reservation rechecks the price configuration, dates, live native
occupancy and last-room conflict before atomically saving the canonical booking,
permanent request receipt and notification outbox. Parallel manual/website/native
hold writes use the same workspace CAS. The checkout date is excluded. Whole
house and individual room offers map to the same physical rooms.

`Idempotency-Key` header must equal the body UUID for `reservations`. A repeated
request never allocates another order, even after quote expiry, response loss or
process restart. The receipt survives for the order lifecycle. Changed content
under the same key returns 409. A quote is single-use across request IDs.

Status response: `{status,orderId,reference,holdUntil?,notifications}`. Status is
`hold_active`, `hold_expired_waiting_owner`, `preparing`, `review_required`,
`confirmed`, `released` or `rejected`. `holdUntil` is present for both hold states;
an expired deadline does not release occupancy. Each notification field
`guestEmail/ownerEmail/ownerLine` is `queued/sent/failed/unknown`. No guest PII,
payment credentials, tenant identifiers or owner recipients are in a guest
response. Request lookup remains possible after a configuration change or
disabled new sales, using the original binding credential.

`hold_active` means actual authoritative occupancy succeeded. If an external
channel is bound, Sheet and OwlNest verified close must also be complete. A
durably queued operation alone is `preparing` or `review_required`.

## Booking assistant boundary

OS owns native bookings, hold/receipt version checks and durable notification
outbox. The assistant owns authenticated recipient/LINE binding and external
delivery/execution. Notification failure never redoes a booking or room toggle.
An uncertain send must be reconciled, not blindly retried. Credentials select
explicit bindings and actions; no global customer-store credential is shared.

The native hold lifecycle remains 24 hours from successful occupancy, expiry
awaits owner, extension is explicit, actual deposit converts the same order,
release removes only that order's reason, and late money cannot reclaim a sold
room. `Official Website` remains the immutable source when acted on through LINE.

Sweetfun/OFFLAND require their original Sheet order identity and a single
authority across existing entrances. Legacy mode must remain unavailable until
the deployed field mapping, source version, pre/post-readback and common
serialization have been verified. A native copy of the legacy orders is not an
acceptable substitute. OFFLAND's O/Q identity discrepancy is a release gate.

## Activation and evidence

Implementation in progress in `codex/os-website-integration-20261007`, based on
PR #29 (`66cd7d8`). New service defaults disabled. All integration verification
uses isolated test properties, synthetic guests and local stores. No live
reservation, notification, external room toggle or recurring job is enabled by
this document.

## LINE pairing and same-order commands (implemented; isolated verification)

The owner connection screen now offers `POST /api/website-booking/owner` with
`{action:"line-prepare",connectionId,requestKey}` under the verified owner's
same-origin cookie session. The response contains `pairingId`, `pairingToken`,
`expiresAt` and `command: "連接OS <token>"`. Tokens last 10 minutes, stay in screen
memory, and contain no recipient. Retrying the same request key returns the same
command. Re-pairing leaves the prior recipient in place until successful consume.
The screen confirms completion only when its exact `pairingId` matches the
server's `connection.binding.linePairingId`.

The assistant verifies LINE's webhook signature and accepts pairing only from a
one-to-one user event. It derives `recipientId` from that verified event, never
from message text or a group/room. It calls:

`POST /api/integration/website-booking/v1/line-binding`

```json
{"schemaVersion":1,"bindingId":"UUID","pairingToken":"bindingUUID.pairingUUID.signature","recipientId":"U<32 hex>"}
```

Use a dedicated worker Bearer with `line_binding` capability. Exact replay by
that worker and recipient returns `state:"connected"`; altered recipient,
expired/unapproved pair, revoked owner or a replaced pair is rejected. Successful
consume atomically saves the pair and binding with a workspace membership fence.
Neither a public booking token nor an owner browser can self-assert a LINE ID.

`POST /api/integration/website-booking/v1/owner-actions` uses a dedicated worker
with `owner_actions`. Common input:
`{schemaVersion:1,bindingId,recipientId,bookingId,action}`. `recipientId` must be
the actual verified one-to-one sender and match the current owner pairing. OS
selects account/workspace/property from the stored binding and rejects all
caller-supplied substitutes. Only website orders in that binding are eligible.

| action | Additional input |
| --- | --- |
| `inspect` | none |
| `hold-extend` | `requestKey,version,bookingVersion,confirmed:true,confirmPlatformOnly:true` and either `hours:12/24` or ISO UTC `expiresAt` |
| `hold-convert` | same version/confirmation fields, `confirmedReceipt:true,amount,method,receivedAt`, optional `receiptAccountId,allowOverpayment,note` |
| `hold-release` | version/confirmation fields |
| `hold-late-payment` / `hold-refund` | version/confirmation fields plus actual receipt fields |

`inspect` returns `bookingId,reference,version,bookingVersion,status,holdPhase,
holdUntil,checkIn,checkOut,total,received,remaining,source,receiptAccounts`.
`receiptAccounts` contains only configured account ID, display name and last four
digits. Mutations return the same readback plus
`operation:{key,verified:true,replayed}`. Amount is TWD units, `receivedAt` must
be a real receipt time, and method is `cash/bank/card/other`; bank/card requires
a configured receipt account. The connector must obtain the owner's actual
confirmation and current versions; a notification button is never authority to
silently overwrite newer changes. Preserve the original request key and exact
content on uncertain response. Do not create a second booking or change source.
Revocation/re-pairing and workspace mutations are fenced in the shared atomic
write. Released late payment records money without restoring occupancy.

## Worker discovery, notifications and email delivery

`POST /api/integration/website-booking/v1/bindings` accepts only
`{schemaVersion:1,action:"discover"}`, a worker Bearer with `notifications`, and
no Cookie. It returns `{schemaVersion:1,bindings:[{bindingId,lineConnected,
inventoryMode:"platform_only"}],channels:[...]}`. No input can select another
site, client, owner, workspace or recipient. Discovery reads only each configured
binding UUID and each exact site index. Unapproved/revoked/ineligible entries are
omitted; storage failure remains an error. It never scans all customers.

`WEBSITE_BOOKING_WORKERS` is a strict JSON list:

```json
[{"id":"line-pilot","token_sha256":"SHA256_OF_DEDICATED_SECRET","site_scopes":[{"client_id":"configured-editor","site_id":"configured-site"}],"actions":["notifications","line_binding","owner_actions"],"channels":["ownerLine"]}]
```

`binding_ids:[UUID,...]` is an alternative or additional exact grant. No wildcard
is accepted. Grant scopes select only the currently approved site binding; every
call rechecks current owner/property authorization, and writes fence its binding,
workspace and site index. Separate credentials are used for editor provisioning,
guest binding and LINE delivery. A registry cannot reuse a token for two workers.

`POST /api/integration/website-booking/v1/notifications` is server-only: Bearer,
JSON, no Cookie or Origin. Common body is
`{schemaVersion:1,action,bindingId,attemptId:UUID}`.

- `claim`: optional `channels:["ownerLine"]` within the worker's grants. At most
  one job per durable attempt, with `id,attemptId,event,channel,recipient,subject,
  text,bookingId,bookingVersion,state:"sending",claimExpiresAt`. Response also
  has `results,replayed,hasMore,queueFingerprint`. The same attempt never claims
  another job. Empty or terminal attempts require a new UUID on the next poll.
  A persistent bounded scan avoids another channel's backlog starving delivery.
- `ack`: adds `jobId,outcome:"sent"/"failed"/"unknown"`, with a real `providerId`
  required for sent. Errors are fixed uppercase `errorCode` identifiers without
  message text/PII. The original worker/attempt must match; a retry recovers the
  exact ACK, and altered acknowledgement is rejected.
- `reconcile`: only the original uncertain attempt, `outcome:"sent"`, real
  `providerId` and `providerReadbackVerified:true`. Preserve the original ACK;
  never requeue/resend an unknown attempt.
- `enqueue_expired`: queues due owner reminders once for the actual hold state.
  It does not release occupancy or requeue old guest confirmation mail.

Workers persist a pre-send record and read it back before the sole provider call.
Claims and provider acceptance are distinct; missing/timeout responses remain
unknown. Recheck the exact claim before dispatch; a changed booking or recipient
must not receive stale content. A generic note/tag edit does not invalidate an
otherwise unchanged notification.

Native email uses the existing authenticated `sendCustomerLifecycleMail` path.
`GET /api/cron/website-notifications` requires the existing `CRON_SECRET` Bearer,
customer workspaces enabled, and
`WEBSITE_BOOKING_EMAIL_DELIVERY_ENABLED=true`. It reads
`WEBSITE_BOOKING_EMAIL_BINDINGS` and/or exact
`WEBSITE_BOOKING_EMAIL_SITE_SCOPES` (same client/site pairs). This discovers a new
owner-approved calendar without per-property environment edits. Each run sends
at most ten emails. A durable cursor, pre-send CAS, provider receipt and outbox
ACK survive restart/response loss. Unknown attempts are not resent. Provider
accepted means SMTP/Gmail accepted the message; it does not prove inbox delivery.
The runner stays available for existing orders when new website sales are off.

## Deployment configuration and remaining live acceptance

New connection/pairing/sales require `WEBSITE_BOOKING_ENABLED=true`, existing
`CUSTOMER_WORKSPACES_ENABLED=true`, and `CUSTOMER_HOLDS_ENABLED=true`. Owner
operations still require the workspace and hold switches; disabling new sales
alone never prevents managing the existing orders. The private editor registry
`WEBSITE_BOOKING_CLIENTS` contains exact `id,token_sha256,site_ids,editor_origin`.
The OS login/calendar origin must be the intended deployment via existing
customer-origin configuration. All credentials remain server-only; never use
NEXT_PUBLIC variables, URL query parameters or committed files for secrets.

`vercel.json` registers a once-per-minute call to the protected email route;
the route remains disabled unless its explicit Email or expiry flag is enabled.
`WEBSITE_BOOKING_EXPIRY_REMINDERS_ENABLED=true` queues owner reminders separately
from `WEBSITE_BOOKING_EMAIL_DELIVERY_ENABLED`. Both use the exact configured
`WEBSITE_BOOKING_EMAIL_BINDINGS` / `WEBSITE_BOOKING_EMAIL_SITE_SCOPES`; disabling
Email never disables LINE expiry reminders. The expiry task keeps occupancy and
queues each semantic expiry event once.
Activation must configure the LINE runner/webhook,
exact pilot scopes and existing mail service; validate those real provider paths
with an explicitly chosen test recipient and isolated property. Store fresh
handoff credentials in a restricted temporary file or secret manager and remove
the temporary copy after both configured services verify the scope. Do not paste
credentials into chat or the repository. Legacy Sweetfun/OFFLAND stay unavailable
until their original Sheet identity/common executor/OwlNest readback is verified.

## Verification and review

- 100 domain/actual-route regressions cover new APIs, current owner/browser
  authorization, notifications, email crash recovery, existing holds, login,
  calendar onboarding and operations; all pass.
- 33 DOM/UI checks pass, including 19 owner-connection/pairing cases.
- Three actual HTTP-handler + disposable local Redis Lua tests pass: parallel
  same-key/last-room transactions, fresh-store readback, exact-site discovery,
  owner approval, LINE pairing, real hold conversion and receipt replay.
- Website chat reports 11 cross-service isolated checks, including its actual
  adapter/guest flow and Python LINE connector against the actual OS routes;
  provider calls use synthetic recipients and synthetic receipts.
- Full TypeScript and optimized webpack production build pass. Full lint has no
  errors; six pre-existing warnings remain outside these changes.
- Independent review found and fixed stale unused pairing takeover, absent-setup
  native property compatibility and global shutdown bypass. Additional review
  fixes fence pending connection revisions, ambiguous site tuples, quote/retry
  interleavings, current room allocation and semantic notification supersession.

These results verify code and isolated persistence. They do not represent live
email inbox receipt, LINE delivery, legacy source writes or a production release.
The release preflight discovered production now serves pricing-only PR #30 merge
`bde9b4a`; merge commit `360a4c7` now preserves that deployed source. The pricing
receiver, merge logic, quote routes and decision UI match that production commit.
Post-merge checks pass: 69 domain/route checks, all six real Redis website/pricing
checks (including the two skipped without Redis), 22 relevant DOM checks, full
TypeScript/webpack build and changed-file lint. CI now runs the new suites on
customer-onboarding PRs using its existing disposable Redis service.

### Deployment approval boundary

Draft PR #31 is the reviewable implementation. On 2026-10-07 the staged
production deployment command was rejected by automatic approval review before
execution. The stated reason was that a production-target deployment enabling
booking/holds and transmitting environment configuration lacked explicit
production activation/credential-transfer authorization; skipping domain
assignment was not considered sufficient isolation. At that first rejection, no deployment, environment
update, credential handoff, real booking or provider send had occurred.

The concrete activation scope is one native pilot website, preserving deployed
pricing commit `bde9b4a`; separate editor and LINE credentials; exact site grants;
owner email verification and explicit room/policy approval; gated scheduled
email delivery; and the existing LINE service adapter. Existing Sheet/OwlNest
properties and automatic pricing remain out of scope. That authorization block was resolved by the direct owner in the
訂房小助手 chat: on the explicit question covering Happy House three-service
deployment, credentials and notification activation, the owner answered 同意
(turn `01a115fe-c597-7222-b3d7-040ce28ddc93`). The OS chat independently read that
human message. The approved scope remains the single native pilot; no legacy
Sheet/OwlNest activation or real guest tests are authorized by this release.

GitHub CI for PR #31 head `9a522e7` did not start. All three job annotations
(Backend, Frontend, Customer workspace isolation) report the account is locked
due to a billing issue. Do not describe these as executed failing tests or as
passing CI. Local verification above remains valid; the billing block needs
account-owner resolution before CI can run.

### Approved-activation runbook

1. Verify the direct owner's approval and re-read the production alias/source;
   preserve any newer production changes beyond `bde9b4a` before deploying. The
   last verified rollback target is `dpl_EuNR8x2nNFkZgDyVeb2eGwbZq1r9`, serving
   `https://sweetfun-gr20axrin-sweetfuns-projects.vercel.app`.
2. Use existing project `prj_ivLgoZInXdIuwHtzWCH5SFHDSQup`, team
   `team_rtARGegsahiZ6hOY7l2dUWGw`, from this branch's `frontend`. Verify that exact
   project link before any command. Keep the existing customer namespace, mail,
   session, calendar and pricing configurations. Never pull/print their secrets.
3. Configure only the new variables through restricted file input: the exact
   editor registry `WEBSITE_BOOKING_CLIENTS`, independent LINE worker registry
   `WEBSITE_BOOKING_WORKERS`, `WEBSITE_BOOKING_EMAIL_SITE_SCOPES`,
   `WEBSITE_BOOKING_ENABLED`, `CUSTOMER_HOLDS_ENABLED`, and
   `WEBSITE_BOOKING_EMAIL_DELIVERY_ENABLED`, and
   `WEBSITE_BOOKING_EXPIRY_REMINDERS_ENABLED`. Do not overwrite an existing registry
   without merging its verified prior entries. Initial candidate email delivery
   stays false, while scoped expiry reminders are enabled independently; no real
   bookings or guest contacts are used for a smoke test.
4. Build a protected candidate with `vercel deploy --prod --skip-domain --scope
   sweetfuns-projects`, using the exact approved source and the narrowly scoped
   runtime settings. Verify READY, deployment provenance, unauthenticated denial,
   service scope, input rejection, no-store responses and native owner screen.
   Use normal protected-deployment access; do not disable protection.
5. Configure the new editor token only in the private Sites worker and the
   separate worker token only in the existing LINE service. LINE grant channels
   are ownerLine only; actions are notifications/line_binding/owner_actions.
   Both grants use client `stayform-editor-pilot-v1` and site
   `appgprj_6ac35c2aa3c08191866d46ffbd495d82:happy-house`. Remove temporary token
   copies after verified secret-manager handoff; never put tokens in a URL.
6. Promote only the verified candidate to the existing OS domain under the
   explicit activation approval. The owner must still verify email and confirm
   real room mapping, prices and rules; the agent cannot approve these for them.
   Then validate one explicitly chosen isolated booking and provider recipient,
   same-order lifecycle/retry and notification readback. Enable scoped email
   delivery and the LINE runner only as authorized and verify actual provider
   receipts separately from outbox enqueue and inbox delivery.
7. Keep the website stopped if authorization, live provider acceptance or room
   mapping cannot be verified. Roll back the alias to the recorded deployment
   for a release failure; retain existing canonical orders and durable receipts.
   Disabling new sales never releases occupied rooms or triggers unknown sends.

Post-approval expiry scheduler regression: all 12 Email delivery/cron cases pass.
The actual cron handler with SMTP/new sales disabled queues exactly one ownerLine
expiry reminder, performs no external send, keeps the canonical held order and
produces no duplicate reminder on retry. TypeScript and changed-file lint pass.

### Candidate deployed; persistent activation rejected again (2026-10-07)

The follow-up direct human approval permitted candidate deployment to proceed.
Vercel built commit `2af1aaae268a2e1f1347bd6596ba9c536b0cde06` successfully:
`dpl_2wEeqPrG1j9VS636RtY94GX2jekZ`, READY at
`https://sweetfun-2bkr06nvy-sweetfuns-projects.vercel.app`.
The candidate has deployment-scoped exact pilot registries, booking/hold and
expiry switches enabled, and Email delivery disabled. The generated project
alias was assigned; primary `sweetfun-os.vercel.app` was independently re-read
and still points to `dpl_EuNR8x2nNFkZgDyVeb2eGwbZq1r9` (pricing source `bde9b4a`).

Nine real protected HTTP checks pass: anonymous connection refusal, editor/LINE
credential separation in both directions, other-site denial, browser-cookie
refusal, forged discovery scope refusal, exact-site discovery with ownerLine-only
channels and zero approved bindings, invalid pairing refusal and invalid owner
command refusal. The unauthenticated owner route also returns
`authenticated:false`, `Cache-Control: private, no-store` and no-referrer.
These checks create no binding, booking, receipt or notification.

The next command to add seven previously absent project-level production
variables was rejected by automatic approval review **before execution**. It
would persist the two scoped registries, scheduler site scope, booking/hold flags,
and Email/expiry flags, including Email=true. The review stated that the current
trusted user message did not explicitly authorize that precise permanent
production configuration and real notification activation. No project-level env
was added, no raw token was handed to Sites/LINE, and the primary alias was not
promoted. Do not repeat that action through another tool or chat.

A concrete approval question is pending in the OS chat covering those permanent
settings, actual Email/LINE activation, separate credential handoff and primary
domain promotion. Both partner chats were informed and agreed not to bypass this
boundary. After approval, resume steps 3–7 above; re-check the primary version for
intervening releases, preserve it, build with the final approved Email flag,
repeat the relevant smoke checks, and verify the owner-controlled activation.
Real provider acceptance and phone/inbox receipt remain unverified. The user
must still approve their own email, physical rooms, price and policy; no agent
may synthesize that approval. Temporary credentials remain local and private.

### Direct OS-chat approval and production release (2026-10-07)

A third review refused cross-chat consent as sufficient evidence. The owner then
answered **同意全部 directly in the OS chat** to the concrete permanent settings,
separate credential handoff, real Email/LINE notification and primary-domain
promotion question. This resolves the earlier activation approval boundaries;
no further duplicate permission request is required for this agreed scope.

Before applying settings, the primary deployment was re-read as the preserved
pricing release `bde9b4a`; all seven new project-level variables were absent.
The seven settings in the runbook were then added successfully as sensitive
production variables, without overwriting any existing setting. Editor and LINE
credential hashes were independently checked against separate 0600 local files;
exact client/site scopes, ownerLine-only channel and three worker actions match.
Both Email and expiry flags are true. No old mail, session, namespace, pricing or
external-calendar secrets were pulled or replaced.

The final candidate built successfully and was verified READY:
- Runtime source: `66838f724ca0897ecfb08d444a0a29cbfa71aefd`.
- Deployment: `dpl_wWr4qXCS9rRMsjDPchUTUbPEgLfx`.
- Deployment URL: `https://sweetfun-iet33keyi-sweetfuns-projects.vercel.app`.
- Primary URL: `https://sweetfun-os.vercel.app`.
- Prior rollback target: `dpl_EuNR8x2nNFkZgDyVeb2eGwbZq1r9`.

All nine real candidate scope/refusal checks pass. Immediately before promotion,
the primary deployment was compared with the preflight baseline; no intervening
release existed. Vercel promotion succeeded and a fresh alias read points to the
new deployment. The project cron definitions now target this deployment,
retaining the seven existing schedules and adding the protected every-minute
`/api/cron/website-notifications` task.

Five direct public-primary HTTP checks also pass **without Vercel bypass**:
anonymous editor access 401; external LINE discovery 200 with only ownerLine and
zero approved bindings; cross-site editor refusal 403; unauthenticated owner
response 200/authenticated:false; and anonymous scheduler access 401. Every
response has no-store headers. No booking, receipt, room or provider was changed
by these checks.

The separate credential files were handed by path only to their responsible
Sites and LINE chats under the explicit owner approval. No raw secret appears in
chat or Git. Installation/readback and removal of the temporary files are still
pending partner confirmation. LINE owns its safe Cloud Run transition and must
not prolong a pause waiting for OS. The user must still complete verified owner
approval of rooms/prices/policies and private LINE pairing. Real notification
acceptance and inbox/phone receipt have not yet been demonstrated; the live
worker being enabled is not proof that a notification was delivered. Legacy
Sheet/OwlNest identity migration and automatic pricing remain outside this pilot.

Post-promotion observation detected 401 responses from real website-notification
cron invocations while existing customer-calendar/order-health cron invocations
on the same deployment returned 200. The new route's extra Cookie/Origin veto
was removed: it now uses the same constant-time, required CRON_SECRET check as
those established schedulers and [Vercel's documented cron authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
Cookie/Origin never grant authorization; missing/wrong secrets still return 401.
The actual-route regression now covers authenticated requests with both context
headers and denies cookies/origin combined with missing or incorrect secrets.
All 12 email/cron tests, changed-file lint and TypeScript pass. The corrected
runtime and actual scheduler success still require deployment verification below.

#### Corrected scheduler verified on the primary deployment

Cron-auth fix source `211ab2f163b4b5cd2c97fc1f076c83dd9dd0edb2` built READY and was
promoted as `dpl_6AyLMRwjvXF1dGdUcadHttZswXsL`, URL
`https://sweetfun-e6dz7smwr-sweetfuns-projects.vercel.app`. Fresh alias and project
reads verify the primary domain and every-minute website schedule both point to
this deployment. The before-promotion guard confirmed no other chat had changed
the current primary, and the preserved pricing files still match `bde9b4a`.

Real platform invocations returned HTTP 200 at **2026-10-07 20:02:16 and 20:03:16
Asia/Taipei** (UTC 12:02:16.255 and 12:03:16.341). The earlier 12:00:44 UTC 401
belongs to the candidate anonymous Cookie/Origin refusal check, before promotion.
No CRON_SECRET was fetched or changed. The code still requires its exact dedicated
bearer, and no cookie/origin grants access. This verifies the live scheduled
execution path, not delivery to an inbox or phone.

Sites confirmed the public guest deployment succeeded at environment revision 2:
`appgdep_6ac63376e6b08191aae66ddd4030ef82`, saved version
`appgprj_6ac35c2aa3c08191866d46ffbd495d82~appgver_523d2716bb4081919f9a91898c611822`,
source `545863b8fd578bef6bb7b78f4e38df36ee477fc0`, public URL
`https://stayform-guest.nccu95208069.chatgpt.site`. Only the OS origin and secret
editor token were added; its prior publish secret was preserved. Native metadata
readback confirms secret classification without returning the value. Sites also
verified primary-origin anonymous 401, an allowed-site nonexistent connection
410 and other-site 403, all no-store. Following that installation confirmation,
the OS-created editor-token temporary handoff file was removed.

LINE confirms its separate token is installed in Secret Manager and the enabled
zero-traffic candidate `gmail-order-handler-int02-live-4d81071` is Ready. Its
real OS poll returns 200 with zero counts, and its existing-path and new access
checks pass. LINE owns the now-authorized safe production switch and polling
scheduler; final traffic/readback and worker-file removal await its completion.
It has been given the two successful OS cron timestamps above. Owner calendar
approval and LINE pairing remain user steps; no test notification was sent.

#### Owner entry point after deployment

Open the private [website builder](https://stayform-ai-studio.nccu95208069.chatgpt.site/build/)
and go to step 4, 發布設定. Choose 建立全新訂房日曆 (or 編輯新日曆設定 if already
filled), enter actual rooms, prices, dates and the owner's email, then choose
建立並連接日曆 → 前往 OS 確認. The human owner verifies the email and approves the
mapping and policy in OS, then generates the private LINE pairing command and
sends it to the assistant. Back in the builder, choose 檢查連接結果, save and
publish/update the public website. Do not substitute agent approval for these
steps or open sales against unconfirmed room inventory.

#### Three-service deployment completed; temporary credentials removed

The LINE owner chat reports `gmail-order-handler-int02-live-4d81071` now serves
100% of production traffic. It re-read the production secret reference (pinned
version 1), all 32 prior settings plus the six intended native additions, exact
OS site grants and zero binding list. Its production OS poll returned HTTP 200
with all counts zero. The safe transition paused background ingress for 335.75
seconds, then restored Gmail push, backfill and the OwlNest queue to their prior
states. The actual Gmail route returned 200 with zero messages/errors.

The `website-line-notifications` every-minute scheduler and review-required alert
using the existing operational recipient were created. Its latest verification
reports an actual scheduler HTTP 200 and no post-release error. This is separate
from the already recorded two successful OS scheduler runs. The operator can now
perform the owner onboarding steps above; the system has not automatically
approved their inventory or paired their LINE identity.

After the LINE owner explicitly confirmed cloud installation/production readback
and authorized local cleanup, the OS-created line-worker-token file was removed.
The previously removed editor token and all remaining files in the OS-owned
pilot handoff directory are now cleaned up; no raw credential remains in those
temporary handoff files. The two live credentials remain independently stored by
their respective services. No real guest booking or test message was created.
Owner pairing, phone/inbox receipt and the first intended provider delivery are
still user acceptance steps, not an unfinished deployment permission request.


## WEB-04 lifecycle completion follow-up (2026-10-07)

A follow-up audit found that native hold transitions already queued notifications,
but formal-order `terms` and `cancel` operations did not. The owner also lacked a
native website-order stay amendment. These are implemented, verified and deployed; final release evidence is recorded
below. Human owner activation and real delivery acceptance remain outstanding.

### Owner amendment and formal cancellation

`POST /api/customer-workspaces/{slug}/operations`, using the existing authenticated
owner/admin cookie and same-origin checks, accepts `action: "website-amend"` with
`requestKey`, workspace `version`, `bookingId`, `bookingVersion`, `confirmed: true`,
`checkIn`, `checkOut`, physical `roomIds`, and a positive numeric `total`.
`allowOverpayment: true` is required if the new total is below recorded receipts.

The operation is limited to one native website stay in held/confirmed status.
It retains the order ID, receipt ledger, original accepted terms and hold deadline.
The owner explicitly confirms the complete new price; the old quote's nightly
breakdown is removed. Room capacity comes from the approved mapping and cannot
fall below the existing guest count. Mapping and workspace snapshots are both
fenced in the atomic transaction. Existing orders, expired holds and manual blocks
remain occupancy reasons; an amendment and a guest reservation cannot both take
the last room. Imported/multi-stay orders remain outside this command.

The order detail UI shows the before/after stay, physical rooms and one total,
requires confirmation and retains the original versions while editing. Unknown
outcomes keep the exact request key and lock other mutations until retried.

Existing formal `terms` changes queue `booking_changed`; settled `cancel` queues
`booking_cancelled` and requires server-side `confirmed: true` for website orders.
Cancellation still requires zero net room/extra receipts. Refund registration
preserves the original ledger; it never transfers funds. Hold release remains the
existing separately confirmed hold operation. These mutations atomically save the
order, operation receipt and three-channel notification jobs before authoritative
readback. Private notes, tags and payment bookkeeping do not create duplicate
order-change notices. Delivery is still the existing durable Email/LINE outbox.

### Guest result contract and accepted terms

Every successful reservation or original-key lookup additionally returns:

```ts
stay: {
  checkIn: string; checkOut: string; roomTypeName: string; quantity: number;
  adults: number; children: number; totalCents: number | null; currency: "TWD";
}
acceptedTerms: { transferInstructions: string; cancellationPolicy: string } | null
```

The stay is derived from the current canonical order, including after amendment
or cancellation, without guest identity/contact data or physical room IDs.
Whole-house quantity remains one only while the full original whole-house offer
still matches; a mixed room selection uses the generic public label 房間預訂.
New reservations save the accepted payment/cancellation text atomically at creation.
Old orders without that snapshot return null and ask the guest to contact the inn;
today's website settings never masquerade as the original accepted policy.

New notification jobs use semantic fingerprint version 2, including expected
deposit and accepted terms. Persisted jobs with no version keep the exact original
fingerprint algorithm through claim, retry and ACK. Existing expiry receipts are
recognized across that upgrade, so a deployment alone cannot trigger a duplicate
reminder. Expired holds remain occupied after amendment, with no automatic renewal
or cancellation. A confirmed-order change never claims that its balance is paid.

### Verification and remaining acceptance

- 106 targeted business, notification, email, login and existing order regressions
  pass. They include immutable policy snapshots, last-room contention, stale versions,
  capacity/mapping races, outbox failure, response loss and duplicate prevention.
- 5 actual Next.js HTTP/Redis Lua tests pass against a disposable loopback-only
  Redis. They verify amendment, same-ID conversion/refund/cancel, updated guest
  summaries, atomic jobs, fake-provider readback, cross-origin denial and recoverable
  legacy-source conflict. No production data or real recipient is used.
- 15 new/related DOM checks pass, including a real business-service amendment with
  a lost successful response, exact-key retry, unchanged payments/deadline and
  permission/locking behavior. This is not physical-device acceptance.
- TypeScript, scoped lint and the local production webpack build pass. Independent
  review found and repaired insufficient-capacity acceptance and a legacy-source
  error incorrectly returned as an unknown 503; the latter now returns recoverable
  409. Prior pricing source remains unchanged.

Owner verification, inventory/policy approval and LINE pairing remain human steps.
Real provider receipt and inbox/phone arrival need the explicitly selected isolated
first order and recipients. Legacy Sheet/OwlNest integration (`INT-03`), producer
callbacks (`ING-01`) and automatic pricing (`INT-04`) are separate unfinished work.


### Follow-up production release and cross-service readback

The owner-authorized follow-up source `8b9a267be936ed02283421d33b519bcb96f44efa`
built READY as deployment `dpl_8aQQW9jkZbsRFy2Ue74xqAtpLxxM`, candidate URL
`https://sweetfun-4f7wsi4gq-sweetfuns-projects.vercel.app`. The pre-promotion guard
confirmed the primary still pointed to the prior scheduler fix, with no
intervening release. Promotion succeeded and fresh alias readback confirms
`https://sweetfun-os.vercel.app` points to this exact READY deployment. The prior
`dpl_6AyLMRwjvXF1dGdUcadHttZswXsL` remains the rollback target. Existing production
settings and the eight scheduled routes were retained; no new credentials or
owner-approved bindings were created by this follow-up.

Seven candidate HTTP scope/refusal checks pass. Direct primary requests without
Vercel bypass additionally verify anonymous `website-amend` returns 401 and the
owner entry returns `authenticated: false`, both with private/no-store caching.
The real platform `/api/cron/website-notifications` invocation returned **HTTP 200
at 2026-10-07 21:47:16.326 Asia/Taipei** (13:47:16.326 UTC). The earlier 401 in
candidate logs was the deliberately anonymous scheduler smoke check before
promotion. No secret was printed or fetched for that readback.

The Sites owner confirms both releases succeeded with their existing audiences:

- Guest site: `https://stayform-guest.nccu95208069.chatgpt.site`, release v5,
  source `df9706dbae4f6f799457f79cc72ad3070ecb4e49`, deployment
  `appgdep_6ac64d3c3b6881918f780fcc4ca25f33`, environment revision 2.
- Private builder: `https://stayform-ai-studio.nccu95208069.chatgpt.site/build/`,
  source `c2225bbebda5fa65f2c2a6bba61534e9a1a2af37`, deployment
  `appgdep_6ac64e17f8588191a6763281af63801e`, environment revision 1.

The Sites owner reports 14 cross-layer isolated cases through the actual Sites
worker, OS routes and Python worker/Email runner. They cover amendment, original
accepted terms despite a subsequent policy edit, same-order refund/cancellation,
current guest lookup and single mock-provider delivery. These are source-level
integration tests with synthetic recipients, not proof of real provider delivery.
The guest lookup displays current stay/price/status and notification outcome and
retains its lookup key after cancellation; a new booking requires an explicit
new-request action.

An additional isolated execution using the LINE service's existing
`NotificationWorker` and test fixture verified both `booking_changed` and
`booking_cancelled`: claim, one mock send, ACK/readback and a subsequent empty
tick. No LINE source modification or real send was needed. The LINE owner reports
its independently authorized latest production revision
`gmail-order-handler-t36-7a8b8fa` serves 100%, retains the native worker/settings,
and restored all background ingress after its own release. That unrelated LINE
feature release does not constitute WEB-04 delivery acceptance.

GitHub CI run `37630686057` for this source did not start any of its three jobs:
each annotation says the account is locked due to a billing issue. Local checks
and the Vercel production build passed, but CI must not be recorded as passing.
PR #31 remains a draft. Documentation-only follow-up commits do not replace the
recorded live runtime source above.

The exact owner entry remains the private builder's step 4, **發布設定** →
**建立全新訂房日曆** (or **編輯新日曆設定**) → actual rooms/prices/availability and
owner email → **建立並連接日曆** → **前往 OS 確認**. The human verifies their email,
approves the actual inventory and policy, and sends the generated private LINE
pairing command personally. Then **檢查連接結果**, save and publish/update the site.
A selected isolated first order and approved Email/LINE recipients are still
required for a real end-to-end delivery check. No live test order or notification
was generated. WEB-04 stays in acceptance until those human steps and actual
receipts are verified.

## Owner acceptance progress — 2026-10-08

The human completed browser-bound email verification and personally confirmed
the isolated test calendar. The authenticated owner page now reports the website
connected, and opening the calendar verifies one test-only physical room with no
bookings. The approved fixture is one room for two people, TWD 1,000 per night,
with accommodation dates October 20–22 and explicit no-payment/no-real-stay
terms. This is not approval to sell actual accommodation.

The private builder's normal **檢查連接結果** flow read back the connected state;
the confirmed settings were saved to the browser draft. Its booking preview
shows October 20 check-in / October 22 check-out as two nights, one room, two
adults and a TWD 2,000 trial total, with the approved test terms. The page
explicitly states that preview creates no booking, occupancy or notification.

The owner's earlier restriction to keep the test unpublished remains in force.
The public guest site's booking button still leads to its existing Booking.com
destination; the new test setup has not been published. No live reservation,
payment, cancellation or booking notification was generated in this acceptance
step. Browser preview evidence must not be counted as live order acceptance.

After the human privately sent the pairing command, the normal owner-page
refresh confirmed **本次 LINE 配對完成**, with a pairing time of 10:17 Asia/Taipei
on October 8. This verifies the account binding, not delivery of a booking
notification.

Live booking acceptance now requires a private test path or explicit permission
to publish the test settings. The existing guest Worker loads the published
snapshot for new availability, quote and reservation requests, while the private
preview intentionally has no write effects. Do not bypass that distinction or
publish against the owner's earlier restriction. No full website-to-calendar
or real booking Email/LINE delivery success is claimed. Legacy Sheet/OwlNest
acceptance remains separate.

### Private acceptance deployment and first live order — 2026-10-08

After the owner chose private acceptance, the existing owner-only Sites builder
received `/acceptance/` and an identity-checked private proxy. The guest service
received service-authenticated private acceptance routes; the public published
snapshot and public booking availability were not enabled by these routes.
Only the authenticated owner's Email, one test-named room and the exact
owner-approved configuration can prepare the private snapshot. Reservations
reuse the production adapter and are marked as private acceptance orders.

The guest release is source `3d8533abd354a0c0bf479d105d2e1c21125d4c2a`,
deployment `appgdep_6ac7003b37bc8191b6958919b76ce457`, environment revision 2.
The owner-only builder release is source
`5d506056736f7ebd79cbb57c7d59ad9b6fba3915`, deployment
`appgdep_6ac7005cd8748191b8bdeb53963fbe99`, environment revision 1.
Both native deployment results succeeded; neither audience nor credentials
changed. Eight new private-boundary checks and the existing lifecycle,
calendar-connection and publication checks passed.

The authenticated live private flow loaded the approved fixture, obtained the
OS price for October 20–22 (two nights, TWD 2,000), and created one synthetic
hold. The owner calendar showed exactly those two occupied nights and no
occupancy on checkout day. The order detail read back the same website order,
two room-nights, total TWD 2,000 and zero receipts. Reloading the private page
recovered its original lookup reference and offered a query instead of another
submission. Two matching guest/owner emails were found in the approved
recipient's inbox. LINE booking-message delivery has not yet been verified.

During the morning checks, the browser's admin-policy verification became
unavailable for both the private Site and OS. Browser access was denied. No
alternative browser or API mutation was used to bypass that boundary. The
test order remained held at that checkpoint; release, restored availability and
the post-reload result were not yet verified. The afternoon evidence below
supersedes that temporary block and the held-state checkpoint. No real money
was recorded.

### Private hold/release acceptance completed — 2026-10-08 afternoon

The human released the same synthetic hold through the normal owner UI and
provided a LINE screenshot showing both the original hold message and its
release message, with matching booking reference and stay dates. The release
message arrived at 15:09 Asia/Taipei. Browser access subsequently worked through
the normal interface; no access-policy workaround was used.

The authenticated OS order detail now reads **保留已釋出** and explicitly says
the order no longer occupies the room. It retains the original two-night stay,
TWD 2,000 historical amount and zero receipts. Two matching release emails were
found in the approved recipient's inbox, completing guest/owner Email delivery
evidence alongside the human-confirmed LINE receipt.

The original private page retained its original lookup reference across reload.
Its **查詢最新結果** action now reads **這次申請已結束**, with no retained room,
the same booking reference and original stay details. A separate private page
queried October 20–22 for the same room and two adults and successfully reached
the contact-details stage with the original TWD 2,000 quote. This verifies that
the released room is available again. No second reservation was submitted.

This completes the real private create-hold → calendar occupancy → Email/LINE
delivery → owner release → guest status lookup → restored-availability flow.
It does not claim real same-order amendment, payment/refund or overdue-reminder
acceptance, nor legacy Sheet/OwlNest integration or public launch. The public
guest site's test settings remain unpublished, and the synthetic hold is now
released.

### Private amendment, conversion, refund and cancellation — 2026-10-08

After the owner requested continued acceptance, one additional synthetic order
was created through the private entry using the same approved room, recipient
and October 20–22 fixture. The guest name and order notes explicitly identify
the test and state that all payment entries are simulations with no real funds
or accommodation. The entire lifecycle retained the same order identifier.

The initial automation date fill did not persist through the controlled form;
readback caught a price-only update. A subsequent native date-control update,
checked before submission, changed checkout to October 21. The canonical order
and guest lookup both showed one night and TWD 1,000, while the original hold
deadline remained unchanged. This was an input-automation correction, not
evidence of a backend amendment failure.

A simulated TWD 500 deposit using the `other` method converted the hold into a
formal order. Owner readback showed one deposit, TWD 500 received and TWD 500
remaining; the guest lookup showed **預訂已確認**. A second amendment restored
October 22 checkout and TWD 2,000 while preserving formal status, the original
order identifier and the single TWD 500 deposit. A TWD 500 simulated refund,
explicitly labelled as test-only in its note, reduced the net received amount
to zero. The owner UI then cancelled the formal order and released its rooms.

Reloading the order verified **已取消**, both offsetting TWD 500 ledger entries
and zero net received. The original guest lookup reported **這次申請已結束** with
the current October 20–22 details and original reference. The authenticated
October calendar reported zero occupied room-nights on October 20 and 21.
Both synthetic acceptance orders are now inactive; no active test hold remains.

Read-only receipt inspection, restricted to the exact test order's deterministic
notification jobs, confirmed `sent` and provider acknowledgement for all three
channels (`guestEmail`, `ownerEmail`, `ownerLine`) on the amendment,
hold-conversion and formal-cancellation events. The new order's original
hold-created jobs were safely superseded by its rapid amendment before delivery;
that is not a second hold-delivery acceptance claim. Matching amendment emails
were found in the approved inbox. Gmail subsequently rate-limited lookup, so
conversion/cancellation inbox arrival and human reading of the new LINE messages
are not claimed beyond the recorded provider acknowledgements.

At this checkpoint real expiry/reminder acceptance was still pending. The
subsequent owner-authorized accelerated test below replaces the proposed
cross-day approach. No overnight hold or automation was created. Public launch
and legacy Sheet/OwlNest scope remain separate.

### Accelerated expiry-reminder acceptance — 2026-10-08

The owner explicitly requested changing the test time rather than waiting
overnight. A third synthetic order was created through the same private entry,
using the approved room and dates, with its guest name and note identifying the
accelerated expiry test. Its original 24-hour hold and all three creation
notification receipts were verified first.

A temporary, narrowly scoped acceptance helper changed only that order's
`hold.expiresAt` to 90 seconds ahead. It checked the exact connection, test
workspace, property, room, booking identifier, test name/note, approved owner
identity, zero payment records and absence of other active orders. The write
used the existing compare-and-swap store, incremented booking/workspace versions,
preserved the rest of the workspace, and saved an audit and idempotent receipt.
No production endpoint, normal 24-hour configuration, system clock, other
booking or public snapshot was changed. This helper was local acceptance tooling,
not a feature added to the application.

The normal owner and guest UIs read back the shortened deadline as 15:35:20
Asia/Taipei on October 8. After it elapsed, the owner page displayed
**保留到期・待業主決定**, and the guest page displayed **保留到期，等待民宿確認**.
The calendar still showed one occupied room-night on each of October 20 and 21,
with no occupancy on checkout day. No cancellation, automatic release,
conversion or payment entry occurred at expiry.

Without manually enqueueing the first reminder or running a mail sender, the
existing scheduled process created `hold_expired` jobs at 15:36:16. The owner
Email job obtained a provider acknowledgement at 15:36:17 and the owner LINE job
at 15:37:04. Both durable jobs read back as `sent`; no guest expiry-email job
was created. Gmail inbox queries remained rate-limited, so this specifically
proves provider acknowledgement rather than independently observed inbox arrival
or human reading of this new LINE message.

After both acknowledgements, an explicit second execution of the existing
expiry-enqueue function returned `queued: 0`. The complete workspace and
notification projections were unchanged, verifying the repeat guard. The
normal owner UI then released the test hold. Canonical/UI readback showed
**保留已釋出**, and the calendar returned to zero occupied room-nights on both
test dates. All three synthetic orders are now inactive; no overnight task,
unsettled test money or active test hold remains.

This verifies the real expiry/reminder mechanism using an accelerated test
deadline. It is not a claim that 24 hours elapsed during acceptance. The normal
24-hour hold setting remains unchanged.

### Final private acceptance and code review — 2026-10-08

This section supersedes the three-order cleanup count and pending native LINE
acceptance above. The owner requested completion of the remaining tests,
followed by code review and correction of critical issues.

Live acceptance completed through the existing private Sites page, authenticated
OS UI and the owner's already-paired LINE desktop conversation:

- On the released expiry-test order, a simulated late receipt of TWD 500 left
  inventory released; the same room remained quotable. A TWD 500 refund returned
  its net receipts to zero without reviving the booking.
- Two browser tabs obtained quotes for the same final room and submitted
  separately. Exactly one hold succeeded; the other received the changed
  availability message. Only the winning booking appeared in LINE.
- Native LINE `OS 查看`, `OS 延期 12` and confirmation extended that same booking
  by exactly 12 hours. OS and the guest's original lookup showed the new deadline.
  `OS 釋出` and confirmation released it; the original guest lookup then showed
  the application had ended.
- A final private one-night booking was opened in LINE and converted through
  `OS 收訂金` and confirmation with a simulated TWD 500 cash receipt. LINE and
  OS showed the same booking, TWD 1,000 total, TWD 500 received and TWD 500 due;
  the guest page showed confirmed. The normal OS UI recorded a TWD 500 refund
  and cancelled the order.
- The guest result was visually checked at a 390 × 844 viewport, including its
  long reference, deadline and accepted terms; no horizontal overflow was
  observed. The override was reset. This is browser responsive verification,
  not physical iPhone/Android or LINE in-app-browser acceptance.

At **16:14:29 Asia/Taipei**, a scoped read-only canonical check confirmed all
**five** synthetic bookings were cancelled, each had zero net receipts, and
the test property's active-order count was **zero**. Each booking's latest
guest Email, owner Email and owner LINE notification had `sent` state and a
provider acknowledgement. Actual LINE created/extended/released/converted
messages were also visually observed. The earlier expiry reminder was visible
in that conversation. No real payment, public test publication, external stock
write or overnight automation occurred. Payment entries remain as an audit trail.

Regression verification: **259 checks passed**: OS booking/hold/amendment/LINE/
notification/email/login suites 96, native LINE suites 104, actual-handler
cross-system checks 14, private access checks 8, booking lifecycle checks 8,
calendar integration checks 8 and publishing checks 21. Cross-system fault
tests cover a committed operation whose response is lost and recovery of the
same request, plus both identical-request and different-guest concurrency.
These are isolated fault injections; no production network outage was induced.
Frontend lint completed with zero errors and six existing warnings. Production
Webpack build passed, including TypeScript and 74 prerendered pages. Default
Turbopack could not bind a local helper port in this execution environment,
including the elevated attempt; no source change was made to mask that error.

Review covered server-owned binding/actor authority, owner revocation fences,
private proxy identity and credential boundaries, shared inventory CAS,
idempotent request/operation receipts, late-payment/refund accounting,
amendment capacity/price guards, immutable accepted terms and notification
claim/delivery/reconciliation boundaries. **No new P0/P1 issue was found** in
this reviewed scope; therefore no critical runtime patch or deployment was
needed in this final pass.

One **P2 usability finding remains** in the native LINE adapter: a later push
notification replaces the quick-reply confirmation buttons while the pending
confirmation remains valid. This was reproduced when the created notification
arrived after a deposit preview. Resending the same unconfirmed instruction
generated a fresh preview and completed normally, with exactly one receipt.
The token appears only in quick replies in
`int02-native-line-20261007/src/website_booking/owner_actions.py`; a future fix
should also include the actor-bound confirmation command in the preview text
and verify that old/expired confirmations still cannot write. This is not a
duplicate-charge or authorization failure and was not silently marked fixed.

Private native-calendar acceptance is complete within those stated limits.
Public sales still require real sale configuration and explicit publication
authorization. Legacy Google Sheet/OwlNest synchronization remains INT-03's
separate integration boundary; these platform-only tests do not certify it.
