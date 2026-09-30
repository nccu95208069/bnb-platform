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
