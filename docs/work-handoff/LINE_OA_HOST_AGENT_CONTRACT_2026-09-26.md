# LINE OA Host Agent Contract — 2026-09-26

## Scope and ownership

The `/bots` UI is implemented and deployed by the parallel `bnb BOT` task. This
work defines the customer-service Agent and its private host/LINE OA capability
contract. Do not edit the `/bots` UI, `public/bots-assets`, or deploy it from
this worktree.

Use the existing BnB customer-service brain, property knowledge, booking
context, and conversation identity as the domain source. Do not create another
guest database or a parallel Bot frontend. First dogfood scope is the owner's
Sweetfun property only.

## Agent identity

| Field | Value |
| --- | --- |
| `agent_id` | `bnb-customer-service` |
| `display_name` | `民宿客服` |
| `property_id` | Owner-selected Sweetfun property id |
| `domain` | Guest service over LINE OA |

Agent ID is stable and does not depend on the editable display name. It refers
to the existing hospitality reply capabilities, not an independently trained
model or new source of truth.

## Independent connection states

The UI must show two separate statuses.

### Host / OA Manager browser session

`host_status` is one of:

- `offline` — host companion is unreachable or stopped.
- `login_required` — host is available, but the owner must sign in.
- `ready` — the persistent owner-visible browser session was recently verified
  as authenticated to LINE OA Manager.
- `needs_reauth` — the session expired or was rejected. Stop browser actions
  and ask the owner to sign in again.
- `error` — host/browser failed for a recoverable or unknown reason.
- `offline` is assigned by the remote BFF when the host has no recent
  heartbeat or cannot be reached. A local process cannot truthfully return
  `offline` about itself.

### LINE Messaging API

`messaging_api_status` is one of:

- `not_configured`
- `unknown`
- `ready`
- `degraded`
- `error`

Messaging API readiness is based on official channel configuration and a
successful health check. It does not assert that OA Manager is open or logged
in. Conversely, a valid Manager browser session does not assert webhook/API
health.

## Capabilities

Capabilities are individually reported as `available`, `owner_required`,
`unavailable`, or `error`:

- `reply_to_guest` — receive/send via the existing official LINE Messaging API
  adapter. Do not use browser clicks as the normal send path.
- `set_internal_tag` — set BnB Platform conversation tags, available without an
  OA Manager browser session.
- `set_internal_guest_name` — set an internal alias in BnB Platform; do not
  confuse it with the LINE user profile or OA Manager's own chat name.
- `set_oa_tag` — optional browser-only OA Manager operation; available only
  while `host_status=ready` and supported by a verified allowlisted workflow.
- `set_oa_guest_name` — optional browser-only OA Manager operation under the
  same conditions.

The public LINE Messaging API supports webhook ingestion, message replies, and
basic profile lookup. Its public reference documents chat-tag audiences as
created in OA Manager; it does not expose an edit-tag or OA Manager chat-name
endpoint. Do not report OA Manager-native tags/names as API-supported. Keep
internal metadata available independently.

## UI-facing API contract

The future host companion API is private and must not be exposed as an
unauthenticated Vercel route. Proposed requests:

### Read status

`GET /api/v1/host-agents/bnb-customer-service/status`

```json
{
  "agent_id": "bnb-customer-service",
  "display_name": "民宿客服",
  "property_id": "<configured-property-id>",
  "host_status": "login_required",
  "messaging_api_status": "not_configured",
  "capabilities": {
    "reply_to_guest": {"implementation": "not_implemented", "configuration": "unknown", "verification": "unverified"},
    "set_internal_tag": {"implementation": "not_implemented", "configuration": "not_applicable", "verification": "unverified"},
    "set_internal_guest_name": {"implementation": "not_implemented", "configuration": "not_applicable", "verification": "unverified"},
    "set_oa_tag": {"implementation": "not_implemented", "configuration": "not_applicable", "verification": "unverified"},
    "set_oa_guest_name": {"implementation": "not_implemented", "configuration": "not_applicable", "verification": "unverified"}
  },
  "last_verified_at": null,
  "reason": "owner_login_required"
}
```

Each capability uses `implementation` = `implemented|not_implemented`,
`configuration` = `configured|not_configured|unknown|not_applicable`, and
`verification` = `verified|unverified|failed`. A capability is ready only when
all applicable dimensions are positive and the specific health check passed.

### Future remote pairing and relay

Do not expose the host computer to inbound internet traffic. The intended
connection is an outbound HTTPS client from the owner host to the already
authenticated Sweetfun OS BFF:

1. The owner starts pairing from `/bots`; the authenticated BFF issues a
   single-use pairing code scoped to `bnb-customer-service` and the selected
   property. Code lifetime should be 5 minutes and it must be invalidated after
   one successful redemption or expiry.
2. The owner enters that code into the local host companion. The host redeems it
   over outbound HTTPS and receives a revocable, host-scoped token.
3. The token is stored in macOS Keychain (or an OS credential vault on other
   supported hosts), never in the model, browser profile, app database, or logs.
4. The host sends periodic outbound heartbeats and polls only an allowlisted
   job queue. The BFF never receives shell access, arbitrary browser commands,
   or generic remote-control capability.
5. The BFF maps stale/missing heartbeat to `host_status=offline`. A new task is
   dispatched only for an enabled capability; unsupported actions remain
   `unavailable`.
6. Disconnect revokes the host token, stops polling, and asks the owner to
   sign out of OA Manager in the visible browser. The owner may also delete the
   dedicated browser profile to clear the persisted session.

Suggested relay endpoints (host -> BFF, HTTPS only):

- `POST /api/v1/host-agents/pairing/redeem` with `{pairing_code, host_id,
  runtime_version, public_key?}` -> one-time `{host_token, token_expires_at,
  agent_id, property_id}`. Prefer a public-key-bound token if the BFF can
  support it; never return it again after redemption.
- `POST /api/v1/host-agents/heartbeat` with host bearer and `{host_id,
  runtime_version, host_status, capabilities, observed_at}` every 15 seconds.
  BFF marks offline after 60 seconds without a heartbeat.
- `POST /api/v1/host-agents/jobs/claim` with host bearer and supported
  capability list; long-poll up to 20 seconds. Return only one schema-validated
  job at a time.
- `POST /api/v1/host-agents/jobs/{job_id}/result` with host bearer and
  `{status, evidence, error_code?, completed_at}`. BFF verifies host/job scope
  and idempotently stores the result.

Job names and payloads must be allowlisted (`reply_to_guest`, `set_oa_tag`,
`set_oa_guest_name`); no arbitrary URL, shell command, selector script, or
browser JavaScript is allowed. `reply_to_guest` should use the Messaging API
service on the BFF, not a host-browser task. Host jobs that need owner approval
must contain a BFF-issued `approval_id`; the host rejects expired or missing
approval. Pairing, heartbeat, job queue, revocation, and remote status are all
future work and currently unimplemented.

This relay is not implemented or configured yet. Until BFF pairing, token
revocation, heartbeat storage, and polling are complete, remote `/bots` should
continue to display `offline` even when the local loopback API is running.

### Start or take over owner login

`POST /api/v1/host-agents/bnb-customer-service/login-session`

The host opens the dedicated persistent browser and returns an interaction
handle/status. The owner enters credentials and completes MFA/CAPTCHA in that
browser. This endpoint must not accept passwords, OTPs, TOTP seeds, recovery
codes, or session cookies.

### Execute a bounded action

`POST /api/v1/host-agents/bnb-customer-service/actions`

```json
{
  "action_id": "<idempotency-key>",
  "conversation_id": "<conversation-id>",
  "action": "set_oa_tag",
  "payload": {"tag": "入住中"},
  "approval_id": null
}
```

Response:

```json
{
  "status": "unavailable",
  "requires_owner": false,
  "evidence": [],
  "error_code": "capability_not_implemented"
}
```

Action result statuses: `succeeded`, `owner_required`, `needs_reauth`,
`blocked`, `failed`, `partial_success`, `unavailable`. UI should show the
returned status and not optimistically claim an external effect succeeded.

## Security and owner controls

- First-time LINE sign-in and all MFA/CAPTCHA steps are completed by the owner
  in the visible host browser.
- Never read OTPs from SMS, email, or authenticator apps; never retain MFA
  secrets or recovery codes.
- Never send passwords, OTPs, browser cookies, or raw LINE channel secrets to
  the model, browser task prompt, ordinary application database, or logs.
- Browser profile/session storage is credential material: encrypt at rest,
  isolate by property/account, restrict host access, support revocation, and
  protect backups equivalently. The current prototype sets private filesystem
  permissions and a restrictive creation `umask`; it relies on host disk
  encryption for encryption at rest, which must be verified before production.
- Use official LINE Messaging API for guest replies. Require explicit
  application-level owner confirmation for high-risk content/actions and keep
  per-conversation takeover plus global pause.
- Record action intent, actor/approval, before/after evidence, status, and
  idempotency key. Never infer success from a click or tool response alone;
  read back the visible state before reporting success.
- If the browser session expires, stop browser actions and transition to
  `needs_reauth`; do not attempt alternate login flows or bypass anti-bot checks.

## Current implementation status

- Existing `bnb-platform` LINE adapter already receives signed webhooks and
  replies through LINE's official Messaging API.
- The deployed `/bots` workspace has its own Bot roster and chat UX, but does
  not yet connect its Concierge Bot to guest conversations or a persistent
  LINE OA Manager browser session.
- This host runtime exposes only local status and a visible owner login session
  at this stage. No real OA account has been connected; no credentials were
  collected; no guest-facing action has been performed.
- Existing `bnb-platform` source has a LINE webhook/reply adapter, but the
  existing `/bots` Agent is not yet connected to it; therefore this Agent's
  `reply_to_guest` capability is `not_implemented / unknown / unverified`.
  Tags and alias actions are also not implemented here.

## References

- LINE receive webhooks: https://developers.line.biz/en/docs/messaging-api/receiving-messages/
- LINE send messages: https://developers.line.biz/en/docs/messaging-api/sending-messages/
- LINE Messaging API reference: https://developers.line.biz/en/reference/messaging-api/
- LINE Login / verification behavior: https://developers.line.biz/en/docs/line-login/overview/
