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
no Cookie/Origin, customer workspaces enabled, and
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
the route remains disabled unless its explicit delivery flag is enabled.
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
assignment was not considered sufficient isolation. No deployment, environment
update, credential handoff, real booking or provider send occurred.

The concrete activation scope is one native pilot website, preserving deployed
pricing commit `bde9b4a`; separate editor and LINE credentials; exact site grants;
owner email verification and explicit room/policy approval; gated scheduled
email delivery; and the existing LINE service adapter. Existing Sheet/OwlNest
properties and automatic pricing remain out of scope. Await direct owner
approval before production candidate creation, persistent configuration or
cross-service credential handoff. Do not retry through another tool or chat.

GitHub CI for PR #31 head `9a522e7` did not start. All three job annotations
(Backend, Frontend, Customer workspace isolation) report the account is locked
due to a billing issue. Do not describe these as executed failing tests or as
passing CI. Local verification above remains valid; the billing block needs
account-owner resolution before CI can run.

### Approved-activation runbook (do not execute before approval)

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
   `WEBSITE_BOOKING_EMAIL_DELIVERY_ENABLED`. Do not overwrite an existing registry
   without merging its verified prior entries. Initial candidate email delivery
   stays false; no real bookings or guest contacts are used for a smoke test.
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
