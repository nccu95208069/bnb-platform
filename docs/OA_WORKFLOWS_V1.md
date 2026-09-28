# Named LINE OA host workflows

Protocol 1.0 retains its owner approval hash, property/agent scope, exclusive lease,
nonce and result receipt. The host additionally advertises `workflow_actions` in
heartbeat status. The BFF must enable only actions present in this list and retain
its owner-only authentication, CSRF and immutable draft confirmation boundary.

| Action | Exact payload fields |
| --- | --- |
| `oa_list_conversations` | none |
| `oa_read_conversation` | `display_name` |
| `oa_reply` | `conversation_ref`, `display_name`, `text` |
| `oa_set_tag` | `conversation_ref`, `display_name`, `tag` |
| `oa_set_name` | `conversation_ref`, `display_name`, `new_name` |

Additional fields are rejected. Replies are limited to 1,000 characters; tag and
replacement display names to 20 characters. Listing and reading require `ui:read`;
writes require `ui:operate`. Every job requires an exact, unexpired approval hash.

List output: `{conversations:[{display_name,preview}],observed_at,limitations}`.
Only visible rows are returned, at most 20.
Names come from the inspected avatar/name/preview row structure, accepting both
View and TextView name slots. Empty, image-only or unsupported name slots are
omitted; later message/timestamp text is never promoted into a missing name.
Reading uses LINE OA exact-name search
and compares loaded contact rows with the UI-reported total result count. An
incomplete result set or multiple exact matches is blocked. Known ambiguity
cannot be bypassed merely because a same-named chat is currently open. The
workflow never searches guest message contents to select a recipient.

Read output:
`{conversation_ref,display_name,messages:[{direction,text}],observed_at,expires_at,limitations}`.
References are opaque, single-use for writes, expire after 10 minutes, and bind
the current chat title and normalized visible message content. They are kept only
in host memory; restart invalidates them. No reference is a global LINE user ID.
Only the latest 12 visible parsed bubbles are included. Media without accessible
text and unsupported layouts are not invented or transcribed.

Write output:
`{operation,verified,conversation_ref,completed_at,conversation?}`.
`conversation`, when available, has the full read shape with a fresh reference.
Only `verified:true` yields `succeeded`. Unconfirmed read-back yields
`partial_success`. A failed or interrupted commit is not automatically repeated.

## Execution safeguards

- Validate scope/approval before dispatch. Check lease time and foreground package
  before every UI interaction. Select controls from fresh native-resolution
  accessibility nodes, not compressed screenshot coordinates.
- Check target title and message fingerprint before consuming the reference.
  Recheck incoming message context before pressing the reply send button.
- Clipboard input must match the approved string in the editor before committing.
  The authenticated emulator clipboard is restored in a `finally` block. Node.js
  is required (`HOST_NODE_PATH` may select its executable).
- Record a SQLite `started` receipt before starting a write workflow. A repeated
  request with another payload is rejected; an incomplete receipt is uncertain,
  never replayed. A used reference cannot authorize another action ID.
- Durable receipts contain only operation/verification metadata, hashes and opaque
  references. They do not retain the conversation or reply text.
- A successful reply requires a newly observed outgoing bubble and empty composer.
  Temporary manual-chat mode is restored after normal completion. On failure,
  recovery only exits editors without saving or clears this workflow's exact draft.
- Renaming requires the prefilled old name to match and both profile and chat title
  to show the new name after save.
- Tagging preserves existing tags, selects one existing tag and requires profile
  read-back. Account-level tag creation is not included. `tag_not_available` means
  the owner must first create that tag in LINE OA chat settings.

## Acceptance boundary

Real list/read and native Chinese/emoji clipboard input have been inspected on the
owner's Android 15 OA installation. A prior individually approved test reply was
confirmed by the owner. Current named write workflows are covered by synthetic UI
state machines; real name/tag mutation and an additional named-flow message have
not been authorized as acceptance tests. `workflow_verification` records only
successful operations observed in the current host process, and starts unverified.

The BFF separately encrypts short-lived customer workflow payloads/results and
exposes them only to the owner. Generic probe snapshots remain redacted/discarded.
This does not implement unattended guest messaging, a full inbox sync or a new
knowledge source. Draft generation and owner confirmation belong to `/bots`.
