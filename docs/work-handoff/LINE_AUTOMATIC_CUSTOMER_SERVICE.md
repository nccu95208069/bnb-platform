# Automatic LINE customer service — 2026-09-28

The latest owner instruction supersedes the earlier per-message confirmation-only
rollout: implement automatic replies driven by the existing bnb-bot workspace.

## Implemented path

Owner enables the policy in `/bots` → the paired host polls its existing relay →
the relay queues a baseline visible list → subsequent changed previews trigger an
exact-name read → the selected active concierge Bot handles the guest context →
the relay queues a policy-bound reply → the host revalidates policy, recipient,
conversation and draft immediately before sending → native read-back confirms it.

The background loop is driven by the running host, independent of the browser.
No new scheduled cloud job or additional host is needed. Polling waits 30 seconds
between idle scans; reading/model/typing adds latency. The owner can pause and
take over. Manual navigation jobs require automatic mode to be paused first.

## bnb-bot integration

- Loads the existing Bot's active state, identity, mission and version from the
  shared Bot workspace. Bot or published knowledge changes invalidate queued sends.
- The guest execution mode uses the existing Gemini configuration and only the
  explicitly published guest knowledge. Owner-only documents, finance and booking
  tools do not become public guest tools.
- Owner-editable guest knowledge starts with the previously verified Sweetfun FAQ.
- The model selects knowledge identifiers or `guest.handoff`; final factual text
  comes from owner-published answers. It cannot invent a rate or mutate a booking.
- Six recent message turns are retained as bounded encrypted per-conversation
  context. This is guest context, separate from private owner-Bot conversations.
- `guest.handoffs` exposes real unresolved LINE handoffs to the existing concierge
  Bot. Resolving one in the customer UI updates the shared Bot workspace.

## Authorization and recovery

Automatic mode is off until an authenticated owner enables it. The standing policy
is limited to list/read/reply on the paired property. It does not authorize auto
renames, tag changes or business transactions. Each concrete job still carries an
exact payload hash, expiring approval, exclusive lease and idempotency key.

The host checks the current standing policy before execution and immediately before
the send. Disabling it blocks queued operations; an already transmitted action is
reported rather than reversed. Uncertain writes are never reissued with a new key.
Read/model/send failures stop that contact and create a visible attention item.

Login loss appears in the customer workbench and stops background execution. After
the owner signs into the same LINE OA installation and completes any second factor,
the recovery button queues an owner-confirmed session attestation. The host requires
a recognized logged-in page before resuming. No password or second-factor code is
stored by the Bot. This release has a workbench alert, not a phone push service.

## Privacy and bounded state

Conversation snapshots, private job context, memory and activity details are encrypted
with scoped authenticated encryption. Only the owner UI can decrypt them. The shared
Bot workspace keeps opaque handoff identifiers and statuses, not guest transcripts.
Host state expires with the 30-day pairing lifetime. Activity retains 50 records,
shared handoffs 200 records, and seen contacts are capped at 500. Generic screenshot
probe results remain discarded as before.

## Current limits and validation

This uses LINE's currently visible recent conversations and exact unique display
names, not a stable LINE user/message ID or complete inbox feed. Duplicate or
unsupported names are blocked. Initial visible messages establish a baseline and
are not answered retroactively. Relative timestamp changes do not count as new
messages. Identical or truncated preview changes can be missed; owner changes to
names/layouts can require renewed inspection. Media needs human handling.

The host must remain awake and LINE OA must stay available. Prices, availability,
payments and booking changes are handed off until authoritative guest-facing tools
exist. These limits are presented in the workbench.

For this change, JavaScript syntax, Python Ruff, frontend ESLint, TypeScript and
production compilation were checked. No new automated test suite or real guest
test message was run in this implementation turn. Live activation and receipt of
a new guest message must be reported separately from compilation success.
