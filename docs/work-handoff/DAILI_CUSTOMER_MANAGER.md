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
Owner UI confirms LINE bound and Daili cloud mode. A follow-up release adds
visible last-sync time; final deployment and synchronization evidence are recorded
in the local project handoff.

Node syntax, TypeScript, targeted ESLint, Ruff and production builds passed.
No automated tests or live guest send were requested/run. No guest draft was
approved by the agent. Actual owner LINE delivery/approval/guest receipt through
this new adapter still requires a real owner-approved interaction.
