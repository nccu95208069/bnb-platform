# LINE OA customer workflows — 2026-09-28

## Owner direction

Continue the paired customer agent to a simple mobile workflow: select a guest,
read the conversation, generate a bounded draft, review, explicitly confirm,
and verify the result. LINE replies/tag/name operations are separate from the
booking/finance live-data read-only boundary. No booking or payment writes were enabled.

## Implementation

- Owner-only `/bots` customer contact, using existing authenticated host relay.
- Named host jobs: `oa_list_conversations`, `oa_read_conversation`, `oa_reply`,
  `oa_set_tag`, `oa_set_name`. No generic coordinates or arbitrary UI actions
  are exposed by the owner API.
- Heartbeat `workflow_actions` advertises the host's enabled operations.
- Reads return visible conversation data, not a claim of complete history.
- Every write draft is created server-side from a recent successful read,
  binding exact host generation, recipient, conversation reference and content.
  Confirm takes only the immutable draft id. Host rechecks target and content
  before acting and reads the visible effect back afterward.
- Thirty-day metadata idempotency survives the bounded job-list pruning.
  Host has durable SQLite mutation receipts; uncertain actions must not replay.
- Job payloads, read results and confirmation drafts are AES-256-GCM encrypted
  using a purpose-derived key from the existing server session secret, scoped
  to the owner/property and stored in separate Redis keys with 5-minute TTL.
  Status/history metadata contains no raw guest names/messages/screenshots.
- Only the owner-selected incoming message plus the small reviewed FAQ catalogue
  is sent to Gemini for topic classification. The final FAQ answer is assembled
  from server-owned text, not model-authored facts. Unknown topics require owner
  follow-up. No full LINE history, display name or reference is sent to Gemini.
- Optional polishing sends only the owner's entered draft, preserves numbers,
  URLs and email addresses, and never sends automatically.
- Mobile UI shows incoming/outgoing bubbles, source link, edit/preview/confirm.
  Pending job id can survive a page reload in sessionStorage; PII is not persisted
  in browser storage. Draft results are discarded if the user switches conversation.

FAQ source reviewed on 2026-09-28: https://www.sweetfuntw.com/zh/faq .
The bounded catalogue covers check-in/out, baggage, breakfast, pets, smoking,
toothbrush supplies, stayover cleaning and station walking distance. It does
not provide availability, prices, refunds, payment accounts or access codes.

## Current boundaries

- Single owner, Sweetfun property, one paired Android host, LINE OA account
  already confirmed by owner. Keep computer/runtime/emulator running.
- Only currently visible messages are read. Duplicate names and unrecognized
  controls fail closed. Current guest selection requires a reliable exact match.
- Replies max 1,000 characters, names max 20 characters.
- Tags must already exist in LINE OA chat settings. Missing tags return a clear
  prerequisite instead of silently creating account-wide configuration.
- Real reply/tag/name mutations were not performed in this task's acceptance
  tests. An earlier separately authorized single test reply is not reused as
  authorization for new sends. Synthetic mutation tests cover these branches.
- Re-login is owner-controlled. No OTP or password is collected by the app.

## Verification

- 63 Bot/relay/API tests and 168 existing regression tests passed.
- Lint: no errors; two existing calendar unused-variable warnings.
- Local production build and staged Vercel cloud build passed.
- Isolated browser fixture verified list/read, reply preview/confirm, tag
  preview/confirm, rename preview/confirm and FAQ draft rendering. Phone viewport
  checked; no console errors. Fixture sends no real LINE messages.
- Candidate unauthenticated host owner/status returns 401.
- Host task reports 45 passing workflow tests + Ruff, with real read-only
  list/read verified. Host source and commit are maintained in the separate
  `line-oa-host-runtime` worktree/task.

Production final deployment and signed-in read/draft acceptance are recorded
below after completion.

## Signed-in production acceptance

On deployment `dpl_6U4PZpaRz3rbvPBhV33ivRJXV6mU`, the signed-in owner UI
successfully read the real host's visible conversation list and the designated
test conversation. Selecting its check-in question produced a real Gemini-backed,
FAQ-bounded draft; the preview showed the intended recipient and exact draft.
The preview was dismissed without sending. Browser error log was empty.

A list row with a nontext name exposed a parser issue (message preview promoted
to display name). Automatic deployment review blocked promoting the final input
validation patch until the host parser is repaired and rechecked. This is a host
parsing issue, not an authorization to override review or send a test message.

## Final release and resolved parser issue

The host parser was corrected in `e537caa`, tested (45 tests + Ruff), and
restarted. Production read-only verification returned 8 visible rows without
promoting message previews into names; the designated conversation read and
real Gemini check-in draft succeeded again. The earlier automatic-review
blocker is resolved, and release approval subsequently passed.

Frontend code `e612861` was promoted successfully to
https://sweetfun-os.vercel.app/bots as deployment
`dpl_6bpfpXUHiDtTGRGhH5RmmTfSaq6b` on 2026-09-28. Vercel reports Ready.
The final release includes aligned host input limits, explicit uncertain-write
outcome messaging, and visible draft/polish progress. Reloading the production
page showed the customer workspace and connected host with no browser errors.

PRs: frontend #24 and host #25 in nccu95208069/bnb-platform.
No new live reply, tag, or rename was issued during final acceptance. The owner
must preview and confirm those actions. Leave the paired computer/runtime and
Android emulator running for phone access.
