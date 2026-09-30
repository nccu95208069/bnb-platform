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
- Swipe groups of three guest cards, with stable next/previous paging.
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
