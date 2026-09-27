# LINE OA Android Host Companion

This host runtime is for the owner's fixed Android emulator running the LINE
Official Account app (`com.linecorp.lineoa`). It is the host half of the
`bnb-customer-service` agent used by the formal Sweetfun OS `/bots` interface.
It does not connect to `bot-workspace` or the old unauthenticated
`bnb-platform` conversation endpoints.

## Current status

Implemented locally:

- Reads one explicitly selected local ADB emulator's boot/app/foreground state.
- Reads screenshots plus Android accessibility hierarchy. Temporary UI XML is
  removed after each read.
- Owner attestation is required before `ready`; known login/2FA prompts return
  `needs_reauth`. The owner performs sign-in and all 2FA in the emulator.
- Bounded UI actions only: tap, long press, swipe, allowlisted key presses and
  text input. Every mutation requires owner approval tied to the exact action,
  a current screen snapshot, and coordinate bounds.
- Chinese/Unicode text entry uses optional ADBKeyBoard IME when the owner has
  installed and enabled it. Runtime temporarily selects that IME and restores
  the previous keyboard. Password/OTP/2FA/recovery-code fields are blocked.
- Durable SQLite action idempotency; uncertain effects after a crash are not
  blindly replayed.
- Outbound HTTPS pairing, Keychain token storage, 15-second heartbeat,
  long-poll job claim, 90-second lease checks, result acknowledgement and
  remote revocation client.
- Only `ui_snapshot` and `ui_action` BFF jobs are accepted. Both require a
  short-lived owner approval matching the job payload hash.

Not connected/verified yet:

- The BFF endpoints described in [Protocol 1.0](../docs/ANDROID_HOST_RELAY_PROTOCOL_V1.md)
  do not exist yet; pairing/remote jobs are therefore unconfigured.
- This Mac has no Android SDK, ADB, or emulator installed. No AVD or real LINE OA
  account was used. LINE OA App compatibility and login persistence across
  emulator reboot/update remain unverified.
- Guest replies, contact-name changes, OA tags and the check-in messaging
  workflow are not available capabilities yet.

## Android setup

Use Android Studio to create one Google Play-enabled Android phone AVD and keep
that same AVD/data directory for this property. Do not delete/recreate the AVD
or select **Wipe Data**. Install `LINE Official Account` from Google Play inside
the emulator, then the owner signs in and completes any verification there. Start
the same AVD each time with `ANDROID_AVD_NAME=<your-avd-name> ./start-emulator.sh`;
the launcher deliberately does not pass `-wipe-data` or create a new AVD.
Confirm the intended property/account visually before owner attestation.

The Android user-data image stores installed apps and session-specific app
data. A cold start or invalid quick-boot snapshot does not itself wipe the AVD;
`-wipe-data` explicitly resets user data. See the [Android Emulator data
directory documentation](https://developer.android.com/studio/run/emulator-commandline#avd-data-directory).
The LINE OA app is listed by [LINE (LY Corporation) on Google Play](https://play.google.com/store/apps/details?id=com.linecorp.lineoa).
That listing does not prove emulator support or guarantee that LINE keeps a
logged-in session after app/version/device changes. Confirm those in the
dogfood AVD first.

For Chinese input, the runtime supports the open-source
[ADBKeyBoard IME](https://github.com/senzhk/ADBKeyBoard), which documents the
`ADB_INPUT_B64` broadcast for Unicode. The owner must review/install/enable it
manually on the emulator. Without it, non-ASCII input is rejected. No keyboard
APK is bundled or installed by this runtime.

## Quick start

Start the companion; it creates a private `.env`, generates a local API token,
and launches the loopback-only server:

```sh
./start-host.sh
```

Open `http://127.0.0.1:8765/` for local host status. Once the owner BFF is
deployed, generate a one-time code from **/bots → 民宿客服 → 連接主機**. In a
second terminal, run the pairing helper and paste the code at its hidden prompt;
the code is not echoed, added to shell history, or printed by the helper:

```sh
./pair-host.sh
```

The helper reads the local bearer token from `.env`, posts only to loopback,
and never displays the long-lived host token. The paired credential is stored
in macOS Keychain. The default property ID is `sweetfun`.

## Manual configuration

Example environment values (never commit `.env`):

```sh
cd host-runtime
uv sync --extra test
umask 077
cp .env.example .env
chmod 600 .env
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

Set `HOST_RUNTIME_BEARER_TOKEN`, the full path in `ANDROID_ADB_PATH`, the
selected `ANDROID_SERIAL`, a stable `HOST_ID`, and `BFF_BASE_URL`. Keep the API
bound to loopback. Run:

```sh
uv run --env-file .env python run.py
```

Local authenticated routes:

- `GET /api/v1/host-agents/bnb-customer-service/status`
- `GET /api/v1/host-agents/bnb-customer-service/ui`
- `POST /api/v1/host-agents/bnb-customer-service/session/attest` with
  `{"owner_confirmed":true}` after the owner confirms the account in app.
- `POST /api/v1/host-agents/bnb-customer-service/pair` with the one-time code,
  host id and property id, once the BFF is deployed.
- `DELETE /api/v1/host-agents/bnb-customer-service/pair` revokes the remote
  token, then removes it from Keychain.
- `POST /api/v1/host-agents/bnb-customer-service/ui-actions` for a local,
  approved action against a fresh snapshot.

Remote screenshot/UI hierarchy can contain real guest conversations. The BFF
protocol requires owner approval and prohibits persisting/logging snapshots.
No real customer screenshots/messages have been transmitted or sent by this
work.

## Synthetic verification

```sh
uv run ruff check app tests run.py
uv run python -m unittest discover -s tests -v
uv run python -m compileall -q app tests run.py
```

The tests exercise mock pairing/nonce/scope, heartbeat receipts, job approval
and lease validation, idempotency, retry-safe status, Unicode IME switching and
fail-closed action handling. They do not test Android hardware, LINE login,
MFA, emulator restart persistence, or real guest messages.
