# BnB LINE OA Host Companion (prototype)

This local companion is for the owner-controlled persistent browser session
behind `bnb-customer-service` (`民宿客服`). It does not change the `/bots` UI
and is not yet reachable from Vercel. It has no LINE OA action executor today.

## What works

- Loopback-only FastAPI status endpoint with bearer authentication.
- Opens a visible persistent Chrome profile at `https://manager.line.biz/` so
  the owner can sign in and complete any MFA/CAPTCHA personally.
- Login verification requires both a manager-domain page without recognized
  login prompts and explicit owner confirmation.
- Reports `login_required`, `ready`, `needs_reauth`, or `error` locally.
- Reports whether LINE Messaging API credentials are configured and exposes an
  authenticated signed-webhook probe that verifies LINE signatures without
  storing or processing the event body.
- Returns `unavailable` for every action because reply, internal tag/name, and
  OA Manager tag/name actions are not implemented in this host runtime.
- Stores profile files under a private (`0700`) local directory, creates files
  under a restrictive umask, and never receives/stores passwords or MFA data.

`offline` is determined by the remote BFF from host reachability/heartbeat; a
local service cannot report itself offline. The BFF relay and owner pairing are
not implemented yet. Until then the `/bots` UI should keep showing offline.

## Local run

Requirements: macOS with Google Chrome installed (or set a compatible browser
channel), and Python 3.11+ managed by `uv`.

```sh
cd host-runtime
uv sync --extra test
cp .env.example .env
```

Generate a token locally and write it to `.env` without committing or sharing
it:

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

Set the generated value as `HOST_RUNTIME_BEARER_TOKEN` in `.env`, then run:

```sh
uv run --env-file .env python run.py
```

The service refuses non-loopback bind addresses. Its API is:

- `GET http://127.0.0.1:8765/health` — liveness only.
- `GET /api/v1/host-agents/bnb-customer-service/status` — authenticated status.
- `POST /api/v1/host-agents/bnb-customer-service/login-session` — opens the
  owner-visible browser at LINE OA Manager.
- `POST /api/v1/host-agents/bnb-customer-service/login-session/verify` — JSON
  `{"owner_confirmed_account": true}` after the owner sees the intended OA in
  the browser. The endpoint never receives login credentials.
- `POST /api/v1/host-agents/bnb-customer-service/line/webhook-check` — verifies
  `X-Line-Signature` using `LINE_CHANNEL_SECRET`; requires the Messaging API
  access token to be present, but does not retain the body or send a reply.
- `POST /api/v1/host-agents/bnb-customer-service/actions` — returns
  `unavailable` for all actions until specific actions are implemented.

Send `Authorization: Bearer <HOST_RUNTIME_BEARER_TOKEN>` to all routes other
than `/health`. Do not expose this bearer token to a browser client or internet
route. Remote access must be added through owner-authenticated BFF pairing and
an outbound-only host heartbeat/poll protocol, not by exposing this API or
opening the host to inbound connections.

## Status meanings

The status endpoint separately reports:

- host login status (`login_required` until owner login is attested;
  `needs_reauth` after a formerly verified session returns to a login page)
- LINE Messaging API credential status (`not_configured` or `configured`; the
  latter confirms presence only, not an end-to-end send test)
- each capability's implementation, configuration, and verification state

No capability is ready unless it is implemented, configured, and verified.
Existing `bnb-platform` source has a LINE webhook/reply adapter, but it is not
connected to this Agent/runtime. This runtime therefore reports
`reply_to_guest: not_implemented / unknown / unverified`. OA tags, OA names,
and internal tags/aliases are also `not_implemented` here.

## Tests

```sh
uv run python -m unittest discover -s tests -v
```

The synthetic contract suite covers login-required, ready only after owner
attestation, needs-reauth, offline transport mapping, bearer auth, and fail-closed
unsupported actions. It does not sign into or send messages to a real LINE OA.

## Still required before remote dogfood

1. Select and implement BFF pairing-code issuance/redeem, scoped host token,
   revocation, heartbeat, and allowlisted task polling.
2. Add owner-authorized BFF routes and a heartbeat store. Until then this local
   API cannot feed the remotely hosted `/bots` UI.
3. Configure the host companion on the owner's computer and verify its disk
   encryption policy.
4. Configure the LINE Messaging API channel in the BnB backend and run an
   owner-approved end-to-end send check. No LINE channel credentials have been
   supplied to this runtime.
5. Implement separate human-reviewed browser workflows only if OA Manager-native
   tags/name changes remain necessary after internal metadata is available.
6. Connect the same BnB customer-service brain/conversation stream. This
   prototype currently does not connect to guest conversations or send replies.
