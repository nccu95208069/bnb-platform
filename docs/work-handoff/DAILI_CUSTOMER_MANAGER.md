# Daili → LINE 客服經理 — 2026-09-28

Owner explicitly requested using the project's existing Daili/bnb-reply-copilot,
not the unrelated diali.ai product. Daili owns guest OA webhook ingestion,
knowledge, interpretation, current drafts and API sending. This adapter owns
private owner cards, edits, versioned approval and notification delivery.

## Runtime

- Existing manager OA, secret vault, LINE signature validation and owner binding
  remain the communication entry point.
- `DAILI_MANAGER_CONNECTION` is a **sensitive production-only** JSON environment
  variable: `{channel, token, starts_at, properties:[{id,daili_property_id}]}`.
  `channel` is the manager route hash (not a LINE channel secret). Every property
  must already be registered to that manager owner. Do not use demo IDs/fallbacks.
- Fixed upstream is the existing Daili Cloud Run API; requests cannot choose URLs.
- A new `/api/cron/daili-manager` uses the existing CRON_SECRET. Every minute it
  checks current drafts, delivers cards, executes explicit approvals and reports
  outcomes. Per-property encrypted state, CAS, cron leases, immutable send IDs,
  notification UUID retry keys and uncertain-state fences survive restarts.
- Existing manager webhook dispatches to Daili for configured properties; old host
  draft buttons cannot approve a Daili draft. The host relay disables automatic
  scanning for those mappings and rejects old automation send permits.
- `/customer-manager` displays Daili cloud mode, queue, edit/approve/pause controls.
  Owner need not keep the host computer/emulator running for these API workflows.

## Guarantees and limitations

No guest message before explicit owner approval of exact version/text. Editing
creates a new version and requires a fresh approval. Daili atomically rechecks
conversation and source before its existing sender runs. Duplicate guest sends
are blocked by Daili's durable claim. Uncertain transmissions block that guest's
manager automation; inspect Daili before any manual resend. A transmission already
started cannot be recalled by pause/unbind.

Normal cards carry one current suggestion and its source question; Daili retains
other unanswered obligations. Text limit is 1000 characters; sensitive placeholders
and attachments require Daili. New-message scan begins at activation and uses a
rolling 7-day window, bounded pages; drafts expire in 24 hours. Multi-property
polling rotates order to avoid starving a later property. LINE push quotas apply.

## Production activation — 2026-09-28

Owner explicitly authorized credential provisioning and deployment with
「同意，完成串接與上線」. Provisioning completed: dedicated MANAGER_BRIDGE
User, hashed token in Daili DB, sensitive production DAILI_MANAGER_CONNECTION
in Vercel. Existing user credentials were unchanged; no plaintext secrets saved.
Only Sweetfun 水芳 is mapped (OS `sweetfun`, Daili
`fa33f0a8-a09b-48d0-adb2-f69b89c1d22b`). Other properties require explicit mapping.

Daili production traffic is 100% `bnb-reply-copilot-manager-4146b26`.
Health returns `status=ok,database=ok`. Dedicated credential returned 200 for
properties and queue, and 403 for unrelated inbox API. Rollback revision is
`bnb-reply-copilot-local-quote-72c9c09`.

OS deployment `dpl_BiGdA82AL2tXPXCJNEHphR9R1ykt` was promoted to the main
https://sweetfun-os.vercel.app alias with the new production connection.
Final OS release `dpl_2mUqwosWSR2wpNgfMmW2bihiDaGB` (UI commit `787958c`)
is READY and aliased to the main site. Owner UI confirms LINE bound, Daili cloud
mode, successful last sync at **2026-09-28 14:45:36 Asia/Taipei**, and zero pending
drafts. Visible last-sync time is now available to the owner.

Node syntax, TypeScript, targeted ESLint, Ruff and production builds passed.
No automated tests or live guest send were requested/run. No guest draft was
approved by the agent. Actual owner LINE delivery/approval/guest receipt through
this new adapter still requires a real owner-approved interaction.

## 15:06 owner test follow-up

Owner reported no guest receipt after approval. Actual LINE reply/push returned
200 for the correct @sweetfuntw OA (@383muqfn is its basic ID). Guest phone receipt
is still unverified; a screenshot of the guest-facing chat was requested.

Daili had regenerated pre-activation unanswered questions, creating repeated cards.
Backend 797155c filters source message timestamps and rejects old source approvals.
OS 9e3f1cd consumes retired IDs and marks those cards stale; the completion message
now explains LINE acceptance vs phone display and directs the owner to the original
OA chat. Production OS dpl_2riV6Ef7ZEBv2udNd1BMBxpFSqqC is READY/main alias active.
No guest messages were sent or approved by the agent during this investigation.

## Complete image / sticker relay

Owner explicitly requested guest media in their bound manager LINE chat. A separate
FIFO feed starts 2026-09-28 09:04:05 UTC (or the integration activation time if later),
forwards each image/sticker independently of the current draft, and records a stable
LINE retry UUID before any owner push. Muted conversations, pause and unbinding are
honored. After 24 hours an ambiguous media notification is replaced with an explicit
notice to inspect the original conversation; the image is not blindly retransmitted.

Photos are native LINE image messages with complete original bytes and a thumbnail.
Oversized photos use a 24-hour full-image link. URLs are single-image signed capabilities;
credentials never enter LINE URLs or the browser. Native supported stickers preserve
package/sticker ID. Other ordinary stickers may show the exact public LINE STORE
static artwork with a clear label. Custom text, arranged stickers, animation/audio
outside LINE's sendable packages are not guaranteed; limitations are shown explicitly.

No automated tests or live sends were requested/run. Static checks and release health
are recorded separately; user-visible original media receipt needs a real new upload.

Media release: OS dpl_ozQfYRXdAfSP7ReijJT8QK4uSPDc is promoted to the main domain.
Daili revision manager-media-50488a1 serves 100%, health/database OK. Build
3c285801-c67b-456b-abb6-9456c237d259 succeeded. UI shows media notifications enabled.


## Dual stay labels — 2026-09-29

Booking proposals now show evidence, current reservation, full dates and M/D room
label in both the LINE approval card and workbench. Approval includes the backend
proposal digest. A separately persisted native-tag job starts only after the
confirmed binding and accepted guest transmission. One tag job per property is
advanced at a time. It checks the canonical link before each pre-write stage,
uses a unique exact name (or exact approved-label prefix), checks the visible
outgoing confirmation, and requires a verified native result.

Host outage, changed booking, missing visible evidence or uncertain effects are
reported separately from Daili binding and guest transmission. No message resend
is used as a tag repair. New date/room tags are staged and saved by the local host
contact editor; arbitrary new account tags remain unsupported.

Validation: syntax checks and production build/lint. No synthetic tests or guest
transmissions were run for this change. Native creation awaits the next owner-
approved live job; UI readback must confirm it before reporting success.
