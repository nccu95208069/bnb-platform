# Native LINE manager inbox — 2026-09-30

## Owner decision
Keep routine work inside the manager LINE chat, operated by buttons. Combine a
guest's consecutive messages and outstanding questions into one review item.
The owner accepted this implementation with 好. Existing explicit permission to
build in the cloud and deploy remains applicable. Booking confirmation and
message transmission stay separate; native OA tagging/emulator work is deferred.

## Interaction
- Owner-specific bottom rich menu and quick replies open a category overview.
- Categories: drafts ready, owner decision, suggested no reply, snoozed.
- Swipe groups of five guest cards, with stable next/previous paging.
- Approve, edit, no reply for this turn, snooze one hour, resume, read conversation.
- Batch approval/no reply is offered only for a homogeneous displayed group;
  a separate confirmation binds the exact displayed draft versions.
- Read two conversation messages at a time, with older-message navigation.
- A single changed-work digest is throttled to ten minutes. Existing media and
  send/binding status delivery remain separate.

## Contract and evidence
Backend queue contract 3 returns one current snapshot per conversation, retaining
all pending obligations from the bridge activation boundary. A 30-second quiet
period collects guest fragments. Published suggestions are revalidated and joined
verbatim; older proven replies are shown as evidence rather than repeated drafts.
Only current validated ACTIVE understanding with no outstanding question or
identity work can suggest no reply. Owner no-reply decisions name exact targets,
are audited, and do not mute future guest messages. Unknown runtime attention is
not silently resolved.

Sends recheck conversation, whole snapshot, all suggestion components, and any
separately confirmed booking. The existing immutable send claim still prevents
blind retry after an unknown transport outcome. Edited text is kept on a refreshed
item, with explicit review indication and a new approval version.

The authenticated on-demand card read records only complete source messages within
the visible 650 UTF-16-unit excerpt. Background queue/digest reads never create
owner-read evidence. The resulting immutable context is passed to the existing
send receipt and coverage mechanism. A clipped or historical unproven answer is
not automatically claimed as complete; owner review remains available.

Pending items do not expire after a day or disappear at a rolling seven-day
boundary. Rich menu installation is idempotent and linked only to the bound owner.
No schema, RLS, credential or guest channel configuration changes.

## Validation and rollout
Ruff, JavaScript syntax, scoped ESLint, TypeScript and whitespace checks passed.
No test suite, synthetic guest send, real booking confirmation or guest approval
was performed. Cloud build and production rollout evidence will be recorded after
completion. Previous production: backend manager-review-f5c06e0 and frontend
Vercel dpl_CyNRetghqvFwYik4RuBsR9sfCYf4 (source 30150e3).

## Production rollout — 2026-09-30

- Backend source: fa0c19fab6ff2b5d1ea1c2858417290479f71c44.
- Cloud Build: a09bce4e-d758-4749-b7d2-1791b3d1f4df, asia-east1, SUCCESS.
- Image: sha256:803ee3e123b8561f3bf66fdc6249bdb87dfc516fcbae81262589c380a073092f.
- Cloud Run: bnb-reply-copilot-manager-inbox-fa0c19f, Ready=True, 100% traffic.
- Candidate and production health: HTTP 200, status=ok, database=ok.
- Candidate runtime spec matched previous production except image.
- Frontend source: 610759dd9acf71654e5edd3bcf36dcb3f0f38cef (native inbox
  implementation 9f572cb5c97a909d7e9b12c60c526675ac9ad614 plus menu readiness,
  legacy binding normalization, and durable installation diagnostics).
- Vercel: dpl_MeyCpx1su6dzxR677Ce6wqpncep2, READY, assigned to
  https://sweetfun-os.vercel.app. Earlier same-inbox deployment
  dpl_97Dr2cnZ3Kikz8Li3MepuG6bgu9Q was superseded for menu setup/status updates.
- Ordinary production contract-3 queue at 02:08:36 UTC: HTTP 200, 19.85 seconds.
  Production manager cron at 10:08:36 Asia/Taipei: HTTP 200. No backend ERROR
  entries observed after startup/promotion at the time of this check.
- Removed only the superseded manager-review-f5c06e0 zero-traffic tag; retained
  its revision for rollback, with unrelated service tags unchanged.

Rollback: restore Cloud Run traffic to bnb-reply-copilot-manager-review-f5c06e0
and promote frontend dpl_CyNRetghqvFwYik4RuBsR9sfCYf4 together. That restores the
previous separate booking/message workflow. No migration or secret rollback.

These are deployment/readiness and ordinary-traffic observations, not an
end-to-end guest-send test. No guest approval or synthetic message was performed.
Existing long/clipped messages and older receipts without read evidence remain
explicit owner-review cases.

Backend source is pushed to existing private PR 121. Frontend source is committed
locally; public GitHub push to existing PR 24 awaits explicit owner authorization
after automatic approval review rejected that separate publication step. The
production deployment itself is complete and does not depend on the GitHub push.

Final owner-page observation at approximately 10:23 Asia/Taipei: “LINE 待辦選單已就緒”
and latest successful sync at 10:22:47. This status is persisted only after LINE
GET confirms the menu linked to the bound owner. Production crons on the newer
menu setup deployment at 10:17:36, 10:18:36 and 10:19:36 returned HTTP 200.
The menu setup now reports a durable, sanitized stage/status note if installation
fails; successful linking clears it. No production environment was downloaded.

## Follow-up: immediate button feedback

The owner reported slow button responses and uncertainty about whether a tap
succeeded. LINE Messaging API cannot edit an already delivered Flex message in
place. The accepted implementation improves feedback inside the same LINE chat:

- Newly generated postback buttons use `displayText`, so the client immediately
  displays the selected operation. This text does not claim server acceptance.
- A signed webhook from the bound owner starts LINE's best-effort loading
  animation, with a 1.5-second request timeout. LINE only shows this animation in
  supported mobile clients while the one-to-one chat is open.
- Persisted actions receive a status card with a progress button. Accepted,
  sending, sent, closed, snoozed, binding and uncertain outcomes are distinct.
  Completion notifications also use status cards. No acceptance message claims
  the guest has received or read the reply.
- Repeated taps on the same action/version/snapshot return the saved current
  state. They do not create another send or booking operation. Changed cards
  return the current state and require a fresh review.
- Ordinary draft reads avoid unnecessary CAS writes; property reads run together.
  The initial category page reuses its fetched data and writes view membership
  and exact displayed versions together.
- Owner-read evidence is captured after LINE accepts the displayed cards, via
  Next.js `after`. Only exact versions and complete visible source messages are
  retained. A very fast approval may precede this background evidence capture;
  missing evidence remains unknown and is never fabricated.
- Saved approve/bind/no-reply actions trigger the existing worker after the
  response. This pass skips queue/media fetching, uses the same property lease
  and existing immutable backend claims, and retries a busy lease only within
  the request budget. The minute cron remains durable recovery. Completion
  notices are prioritized over media. An explicit no-reply decision can finish
  while general draft scanning is paused; paused send/bind gates stay enforced.
- Pausing invalidates any queued approval version before a future reapproval.
- Rich menu v4 adds immediate client tap text. Old delivered cards remain
  immutable; the owner should open the menu again to fetch new cards.

No schema, credentials, auto-approval, guest channel or booking/send separation
changes. Transient webhook failures retain LINE redelivery and persisted batch
progress. Public source publication remains separately awaiting authorization.

Validation: JavaScript syntax, scoped ESLint, TypeScript and whitespace checks.
No tests or synthetic guest sends were run. Production build/readiness will be
recorded below after rollout; actual phone tap timing is not yet observed.

### Feedback rollout

- Source: b4402af50178d6052e41c360f70a76b161ed651a.
- Vercel: dpl_14hPPebHk9ECcJ9z3QeodroTLkYY, READY; cloud production build
  completed successfully, including Next.js compilation and TypeScript.
- Promoted at approximately 11:23 Asia/Taipei to https://sweetfun-os.vercel.app.
- Production owner page and authenticated manager status/draft reads returned
  HTTP 200 on this deployment. No guest send or booking action was invoked.
- The normal manager cron at 11:24:36 Asia/Taipei returned HTTP 200. The owner
  page then reported latest sync 11:24:48 and “LINE 待辦選單已就緒”, which now
  requires the v4 menu plus a successful LINE GET of the owner-specific link.
- No errors appeared in the initial deployment log sample. These are operational
  observations; no real or simulated LINE approval/button test was performed.
- Backend remains manager-inbox-fa0c19f; there is no database migration.
- Rollback for this feedback-only change: promote the previous frontend
  dpl_MeyCpx1su6dzxR677Ce6wqpncep2. Keep the current backend revision.

## Follow-up: repeated question labels

The owner's screenshot showed repeated price/card/payment labels within one guest
card. Code inspection found that `manager_inbox.inbox_item` projects every pending
obligation's `request_summary`, while ACTIVE V2 obligations use the route's
`operator_name` as that summary. Several distinct tracking records can therefore
share an identical label. The LINE renderer previously numbered each label as a
separate question, overstating what the label itself establishes.

The card now groups identical labels after Unicode/whitespace normalization and
calls the section “待確認主題”. It also explains when same-topic labels were
combined. This applies immediately to new cards generated from existing cached
drafts, without waiting for each conversation to be rescanned. Different labels
remain separate; there is no fuzzy merge of dates, rooms, payments or requests.

This is presentation grouping, not a database reconciliation: underlying pending
IDs, source references, approval snapshots and no-reply targets are preserved.
It does not mark old or uncertain questions as answered merely because labels
match. Previously delivered LINE cards are immutable and must be refreshed via
the existing menu.

Validation uses syntax, ESLint, TypeScript and production build checks. No tests,
guest messages or booking actions are used for this change.

Rollout: source e7f85959b15a10308f00dadec7008ec87d287ef3, Vercel
dpl_8UzWTvbLsiz8RgSDqE2364ZTw3p3 (READY), promoted to
https://sweetfun-os.vercel.app at approximately 11:36 Asia/Taipei. Cloud Next.js
build and TypeScript passed. No backend, database or rich menu change was needed.
The actual refreshed LINE card remains an owner-visible follow-up; no live LINE
action was invoked during rollout. Previous frontend
dpl_14hPPebHk9ECcJ9z3QeodroTLkYY remains the rollback point.

## Five-card pages and code review

The owner requested five guest cards per group across all categories, followed
by code review of the recent changes. New category views now use page size 5.
Payloads are packed by actual UTF-8 JSON size and can span multiple carousel
messages while retaining the five guests and complete approval text. Old views
retain their original page size until the owner opens a category again.

Review fixes bind batch controls to the exact rendered page token, preserve
completion receipt snapshots across subsequent draft versions, and keep paging
and batch controls consistent with category changes. LINE actions also retain
the sender-validated owner binding revision, and recently completed old drafts
remain available based on their latest action time. See
[the review report](MANAGER_REVIEW_2026-09-30.md) for findings, fixes and limits.
Backend scan batch size is independent of UI pagination and remains unchanged.

Rollout: final source e345ef593c699405e1aba0d076ba37282dae759b, Vercel
dpl_FjyWFnKrkhVceY8j9G6zBCjdneED (READY), promoted at approximately 12:00
Asia/Taipei on 2026-09-30. Inspection of https://sweetfun-os.vercel.app resolves
to this deployment. JavaScript syntax, scoped ESLint, TypeScript, whitespace
checks and the cloud Next.js production build passed. No automated tests, live
LINE actions, guest sends or booking actions were performed. Backend remains
manager-inbox-fa0c19f without database changes. Public source push is still
awaiting the existing explicit publication approval.

## Mark all current todos handled

Owner decision (2026-09-30): provide one operation to mark all reply todos handled,
across every category and page. This includes snoozed todos and sends no guest
message. It is separate from batch approval of suggested replies.

- “全部標為已處理” appears in the overview and each category's page controls.
  It opens a count by property/category, then “確認全部已處理”. Cancel removes an
  unconfirmed operation; canceling a previously confirmed card shows its progress.
- The confirmation captures all currently synchronized eligible draft IDs and
  versions, not just the current five-card page. New messages, new drafts and
  changed versions are not silently swept into the operation. In-progress or
  uncertain booking operations and legacy unsupported drafts remain excluded,
  with their count disclosed. Future guest input remains enabled.
- Manager state stores the immutable property groups and sender-validated owner
  binding revision. The confirmation expires after ten minutes; confirmed
  progress remains available for a day. Each property atomically enqueues its
  entire captured group with a stable bulk token. Repeated taps resume/report
  that same group. Partial admission offers “繼續清理” without claiming completion.
- Existing leased workers and the minute cron execute the established backend
  no-reply operation with a stable request ID and exact inbox snapshot. The
  backend records the owner's resolution against specific pending obligations.
  This does not mute conversations, delete chat history, confirm bookings or send
  suggestions. Backend snapshot conflicts retain the changed conversation.
- Durable per-item outcomes distinguish pending, closed and retained. Unknown
  failures retry the same backend request after a delay, with attempted items
  moved behind untouched items. Definite rejections restore the local pending
  draft. Bulk work rechecks the current owner binding before each backend call.
- Completion is one summary per affected property instead of one receipt per
  guest. Summary retries use immutable LINE push payloads and existing retry
  IDs. The overview and progress card show outstanding work. Rebinding cancels
  remaining old-revision decisions rather than applying them to the new binding.

This is a button implementation; no existing guest todo was cleared during
development or rollout. No automated tests or live guest/bulk actions were run.
Static checks and production deployment are recorded below after rollout.
