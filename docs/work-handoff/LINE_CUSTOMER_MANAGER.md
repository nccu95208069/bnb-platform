# LINE customer manager — owner approval rollout

## Latest owner decision

The owner requested one management LINE OA ("客服經理") that reports proposed
responses from multiple property OAs. Every guest reply must be edited/approved
by the owner first. This supersedes the 2026-09-28 direct automatic reply policy.
The prior live policy was explicitly paused before this implementation.

## Implemented surfaces

- `/customer-manager`: authenticated owner-only management account setup, binding,
  property registry, per-property host/monitor status, and review/edit/approve/takeover.
- Existing `/bots?customer_property=<id>`: dedicated host pairing, manual named
  operations and published knowledge for the selected registered property.
- `/api/v1/customer-manager/webhook/<channel_id>`: LINE-signed webhook, direct
  owner user binding, postback approvals and text draft edits. Group/room events
  cannot approve. Unbound users receive no guest information.
- Management account credentials are entered in an owner-only form and encrypted
  at rest using the existing AES-GCM vault with a separate scope. Never returned
  by status, committed, logged, or placed in browser storage.
- LINE `待辦` retrieves up to five current review cards. A card's Modify button
  selects a single draft for ten minutes; the next text updates only that draft.
  Saving an edit increments the version and requires a new explicit approval.

## Processing model

Host polling -> visible list changes -> exact contact read -> existing bnb Bot
and this property's published knowledge -> encrypted versioned draft -> durable
owner notification -> owner approval -> fresh exact contact read -> compare full
visible-message fingerprint -> queue one exact reply -> native before-send
policy/content checks -> readback -> report verified result to owner.

The standing policy authorizes list/read only without an exact draft approval.
The BFF validates the draft id/version/approved version/status/expiry in both job
claim and the host's before-send permit. A legacy auto-send policy is paused and
cannot pass that permit. All drafts expire after 24 hours. Changed conversations
invalidate approvals and generate new drafts. Unknown answers create an empty
owner-required draft; no automatic "handoff received" guest reply is sent.

The relay accepts host result and updates draft/send state in one CAS. Retrying a
write keeps its idempotency key; uncertain native writes remain blocked. Pausing
revokes queued permits; a transmission that already passed its final check cannot
be recalled. The UI shows partial/uncertain outcomes distinctly.

## Multiple properties

Up to ten owner-registered properties, each with an explicit guest OA id, isolated
host credential, job payload scope, drafts, memory and public knowledge. Existing
Sweetfun registration and host keys are preserved. New properties start with empty
knowledge, never with another property's FAQ. The shared bnb Bot identity/mission
is retained while guest-facing knowledge is scoped by property.

Each guest OA needs its own dedicated logged-in Android environment and companion
process. These can run on the same physical computer but must use different
`ANDROID_SERIAL`, `HOST_ID`, `HOST_RUNTIME_PORT` and `HOST_RUNTIME_DATA_DIR` values.
The owner must log each emulator into the indicated guest OA and pair its correct
property code. This release does not switch OA accounts inside one emulator or
provision additional emulators automatically. Do not switch its logged-in OA while
its monitor is enabled. The original host protocol already carries property scope.

## LINE management account setup

1. Choose/create the separate management OA and enable its Messaging API channel.
2. In `/customer-manager`, enter that channel's access token and channel secret.
   The token is checked against LINE bot info; channel name/basic id are read back.
3. Configure the displayed HTTPS webhook URL in LINE Developers and enable webhook.
   LINE signature verification confirms the channel secret and destination match.
4. Generate a short-lived binding command in the owner page, add the manager OA as
   a friend, and send the command in the owner's private LINE conversation.
5. Configure each property's public knowledge and dedicated paired host, then start
   its monitor. New guest messages become review cards, not direct replies.

Binding codes are random, hashed, single-use, expire in ten minutes and grant
control to their holder; do not forward them. Forwarding a review card does not
transfer approval authority. Rebinding/configuring a different management OA
invalidates the old owner's manager binding.

## Notification durability and limits

Encrypted per-host outbox, stable UUID `X-Line-Retry-Key`, bounded retries under
24 hours, raw-body HMAC-SHA256 webhook validation, destination checks, CAS editing,
version fencing and event deduplication. Notification API acceptance does not prove
phone display (e.g. the owner may block the OA). Management pushes use that OA's
Messaging API quota. LINE settings/credentials and actual receipt need live setup.

Existing visible-inbox limitations remain: unique display names required, visible
recent rows only, truncated/identical preview changes can be missed, no complete
history stream, no stable LINE message id. Host must remain awake and online.
Knowledge/booking/finance access is not expanded by this manager channel.

## Validation status

### Production publication — 2026-09-28

- Implementation commit `fe0c8cb` is pushed on `codex/sweetfun-bots` (draft PR #24).
- Deployment `dpl_FGRwmbmWkQgHRWhULRA5XEQju7n6` built successfully and was
  promoted to `https://sweetfun-os.vercel.app`.
- The authenticated `/customer-manager` page visibly renders the existing
  Sweetfun property, an empty review queue and the unconnected manager account.
- The existing paired local host was restarted; its relay is running. The
  runtime reports `owner_login_not_attested` after restart. Monitoring remains
  paused. Confirm the intended logged-in OA before attesting and enabling it.
- The owner has not yet specified the management OA. Channel configuration,
  webhook setup, owner binding and live approval-flow acceptance remain pending.

Implementation adds no speculative live guest sends. Static syntax, TypeScript,
ESLint and production build checks are recorded in the task. No new automated test
suite was run in this implementation turn. Real LINE management-card delivery,
owner editing/approval and guest delivery require the chosen management account
and owner binding; do not claim those live steps before they occur.

References:
- https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
- https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
- https://developers.line.biz/en/reference/messaging-api/nojs/
