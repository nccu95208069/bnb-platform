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

## Release status

- Implementation, Node syntax, TypeScript, targeted ESLint and production Next.js
  build completed. The first sandboxed build could not download existing Google
  Fonts; the authorized network-enabled build succeeded.
- No automated tests or live guest send were requested/run.
- Credential provisioning, backend/frontend deployment, activation and live owner
  delivery remain pending. Do not claim the existing emulator pipeline has been
  switched until this document records production activation.
- Automatic approval review rejected reading/exporting the whole Cloud Run
  environment because it may contain secrets. A question asks the owner to
  authorize only the existing DB credential, dedicated integration User and
  encrypted production Vercel token. Do not bypass that pending decision.

### Candidate publication

Vercel candidate `dpl_3KNY5b3fzXgrb6cAmnTckUeFqYFF` is READY at
https://sweetfun-pkf54zkoh-sweetfuns-projects.vercel.app . Main alias inspection
still resolves to `dpl_FGRwmbmWkQgHRWhULRA5XEQju7n6` (old production).
Daili candidate `bnb-reply-copilot-manager-4146b26` is ready at 0% traffic;
its health endpoint returns HTTP 200 and database=ok. Cloud Build
`2fec0254-fa0e-4ddd-8271-7f2915411b0b` succeeded. Neither integration credential
nor DAILI_MANAGER_CONNECTION has been provisioned. A new frontend deployment is
required after adding that production environment value. Credential approval
question remains unanswered; do not promote or claim activation.
