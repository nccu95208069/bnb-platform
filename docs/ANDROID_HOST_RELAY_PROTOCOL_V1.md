# Android OA Host Relay Protocol 1.0

This is the integration contract for the authenticated owner BFF in `os-bots`.
The host opens outbound HTTPS connections only. The BFF must bind every record
and token to exactly one owner, `host_id`, `agent_id=bnb-customer-service`,
and `property_id`. A host token is never returned to a browser or model.

## Pairing and credentials

The owner BFF issues a cryptographically random, single-use pairing code valid
for 5 minutes. Its stored representation is a hash. The local companion sends
the code once, over TLS:

```http
POST /api/v1/host-agents/pairing/redeem
X-Protocol-Version: 1.0
X-Request-Nonce: <fresh 192-bit base64url nonce>
Content-Type: application/json
```

```json
{
  "protocol_version": "1.0",
  "pairing_code": "<owner-issued one-time code>",
  "host_id": "<stable owner host id>",
  "agent_id": "bnb-customer-service",
  "property_id": "<owner-selected property id>",
  "runtime_version": "1.0.0",
  "nonce": "<same request nonce>"
}
```

```json
{
  "protocol_version": "1.0",
  "nonce": "<echo request nonce>",
  "host_token": "<opaque random secret, shown once to host only>",
  "token_expires_at": "<RFC3339 UTC>",
  "host_id": "<same host id>",
  "agent_id": "bnb-customer-service",
  "property_id": "<same property id>",
  "scope": ["heartbeat", "jobs:claim", "jobs:result", "host:revoke", "ui:read", "ui:operate"]
}
```

The BFF atomically consumes the pairing code before creating the token. The
host checks the response nonce and all scope bindings before saving it. Store
the token and its bindings in macOS Keychain via the OS credential manager. On
keychain failure, pairing fails closed; never fall back to plaintext files.
The token is scoped to the host, agent and property, expires (recommended 30
days), and is individually revocable. Revocation invalidates it immediately.

The owner-authenticated local companion pairing route is
`POST /api/v1/host-agents/bnb-customer-service/pair`; it accepts the one-time
code only on loopback and returns the bound identifiers and expiry, never the
token. `DELETE` on the same local route calls the BFF revocation route, then
deletes the keychain item only after a nonce-bound revocation receipt.

## Request authentication and replay protection

All post-pairing requests use the host token:

```http
Authorization: Bearer <host token>
X-Host-Id: <bound host id>
X-Agent-Id: bnb-customer-service
X-Property-Id: <bound property id>
X-Protocol-Version: 1.0
X-Request-Nonce: <fresh random nonce per HTTP request>
```

The body repeats those scope fields where defined. The BFF rejects any header
or body mismatch. Keep a per-token nonce replay cache for at least 5 minutes;
reject a reused nonce. Use TLS certificate verification; redirects to a
different origin are not allowed. Never put bearer tokens or pairing codes in
URLs, analytics, access logs or exception text.

## Heartbeat

Every 15 seconds, independently of the queue long-poll, the host posts:

```http
POST /api/v1/host-agents/heartbeat
```

```json
{
  "protocol_version": "1.0",
  "host_id": "<bound host id>",
  "agent_id": "bnb-customer-service",
  "property_id": "<bound property id>",
  "sequence": 12,
  "nonce": "<request nonce>",
  "sent_at": "<RFC3339 UTC>",
  "status": {"protocol_version":"1.0","agent_id":"bnb-customer-service","host_status":"login_required","reason":"owner_login_not_attested","emulator":{"serial":"emulator-5554","boot_completed":true,"app_installed":true,"app_foreground":true},"capabilities":{}}
}
```

Success is `200` with `{ "protocol_version":"1.0", "nonce":"<echo>",
"host_id":"<same>", "sequence":12, "accepted":true,
"server_time":"<RFC3339 UTC>" }`. Sequence must increase; persist the last
accepted sequence in Keychain with the token. BFF labels a host `offline` after
60 seconds without a valid heartbeat. Browser/session status and emulator
reachability remain separate from LINE Messaging API (not used in this path).

## Claim and leases

The single worker claims at most one job at a time and long-polls for at most
20 seconds:

```http
POST /api/v1/host-agents/jobs/claim
```

```json
{
  "protocol_version":"1.0",
  "host_id":"<bound host id>",
  "agent_id":"bnb-customer-service",
  "property_id":"<bound property id>",
  "nonce":"<request nonce>",
  "wait_seconds":20,
  "capabilities":["ui:read","ui:operate"]
}
```

No work returns `204`. A lease must last 90 seconds and cover only one job:

```json
{
  "protocol_version":"1.0",
  "nonce":"<echo claim nonce>",
  "job_id":"<opaque id>",
  "lease_id":"<unguessable lease id>",
  "lease_expires_at":"<RFC3339 UTC>",
  "idempotency_key":"<unique immutable action key>",
  "agent_id":"bnb-customer-service",
  "property_id":"<same property>",
  "action":"ui_snapshot",
  "payload":{},
  "approval_id":"<owner approval id>",
  "approval_expires_at":"<short-lived RFC3339 UTC>",
  "approval_action_sha256":"<sha256 canonical approved operation>"
}
```

Only `ui_snapshot` and `ui_action` are accepted. Every job requires a current
owner approval tied to the exact canonical tuple
`{agent_id,property_id,action,payload}`; `approval_action_sha256` is its SHA256
over UTF-8 JSON with sorted keys, compact separators, and no ASCII escaping.
The BFF must verify the owner, approval expiry, property scope and digest before
claiming. The host independently checks all bindings, scope, lease and digest.
An absent, expired or mismatched approval is rejected without an ADB effect.

`ui_snapshot` has empty payload and authorizes one fresh screenshot and
accessibility-tree read. `ui_action` payload is exactly:

```json
{
  "snapshot_id":"<fresh host snapshot id>",
  "action":"tap|long_press|input_text|press_key|swipe",
  "x":312,
  "y":528,
  "x2":312,
  "y2":528,
  "text":"<owner-approved text, max 500 chars>",
  "key":"BACK|ENTER|DEL|TAB",
  "duration_ms":350,
  "expected_ui_signals":["已儲存"]
}
```

Only fields relevant to the selected action are present; extra fields are
rejected. Coordinates must fit the named fresh snapshot and expire locally
after 90 seconds. Text entry into password, OTP, 2FA, recovery-code and
verification-code fields is always rejected: the owner signs in manually.
Chinese input requires the owner to install and enable the pinned ADBKeyBoard
IME on the emulator; runtime switches to it for one input and restores the
previous IME. Without that IME, non-ASCII input fails closed.

## Results, retries and deduplication

Host posts one result before claiming another job:

```http
POST /api/v1/host-agents/jobs/{job_id}/result
```

```json
{
  "protocol_version":"1.0",
  "host_id":"<bound host id>",
  "agent_id":"bnb-customer-service",
  "property_id":"<bound property id>",
  "job_id":"<same job id>",
  "lease_id":"<same live lease>",
  "idempotency_key":"<same immutable key>",
  "nonce":"<fresh result nonce>",
  "status":"succeeded|owner_required|needs_reauth|blocked|failed|partial_success|unavailable",
  "output":null,
  "evidence":[{"snapshot_id":"<id>","screenshot_sha256":"<sha256>","visible_effect_confirmed":true,"details":{}}],
  "error_code":null,
  "completed_at":"<RFC3339 UTC>"
}
```

Receipt is `200` with protocol version, echoed `nonce`, `job_id`,
`idempotency_key`, `accepted:true`, and optional `duplicate:true`. Persist result
idempotency records at least 30 days and return the original receipt on an
identical retry; reject key reuse with a different job/payload. Validate the
lease and host/property scope on result submission. Requeue a job after its
lease expires using the same idempotency key; never issue a second concurrent
lease for that action.

The host retries network failures with exponential delays 2, 4, 8, 16, 32,
then 60 seconds maximum, while continuing heartbeats every 15 seconds. Results
may be retried with a new HTTP nonce but identical job, lease, idempotency key,
payload and status. The host's SQLite action ledger is durable: completed
actions return the saved result; an action left `started` by a crash is
`action_outcome_uncertain` and is never blindly replayed.

## Screenshot and privacy boundary

A `ui_snapshot` result may include `output.screenshot_mime_type=image/jpeg`,
`output.screenshot_jpeg_base64`, `output.screenshot_sha256`, dimensions, and
accessibility nodes (up to 300; text fields capped at 300 characters). The host
downscales to at most 1440px and caps compressed image bytes at 2.4 MB so the
whole JSON result stays below common serverless request limits. It can show real guest names, room labels and
chat content. It exists only for an owner-approved operation. The BFF must
process it in memory for the active task only: do not write screenshots, XML,
guest message text, extracted OCR or decoded UI nodes to Redis, databases,
conversation history, analytics, traces, request logs or exception reports.
Return only the task result and redacted evidence to the UI; discard snapshot
bytes/tree after response handling. Never send snapshots without an explicit
owner action approval. The emulator companion also deletes its temporary XML
hierarchy immediately after reading it.

## Capabilities and current status

Android ADB read/action transport, approval/scope validation, pairing client,
heartbeat, claim/result/revoke client, durable local idempotency, and mock-BFF
contract tests are implemented. BFF endpoints do not exist yet, so pairing,
tokens, heartbeats, remote UI jobs and revocation are **not configured or
verified**. LINE OA App login and emulator restart/session persistence are
unverified until an AVD is installed and owner-tested. Sending a guest reply,
editing OA display names/tags, and the end-to-end date-search/check-in message
workflow are not implemented or verified.
