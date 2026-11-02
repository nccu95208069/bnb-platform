# Google Calendar live-acceptance setup — 2026-10-04

## Current verified state

Real Google configuration and desktop end-to-end acceptance are now complete within the owner-approved test scope. See [live acceptance and remaining rollout boundaries](CALENDAR_LIVE_ACCEPTANCE_2026-10-04.md) for provider, email, storage, refresh/reconnect and worker evidence. The dedicated OAuth client and encryption key are applied to the protected fixed alias through deployment overrides. The Google app remains in Testing, continuous sync is disabled after testing, and the primary domain is unchanged.

The procedure below remains the setup/runbook reference. Its configuration-presence checker is not a substitute for the recorded live tests.

## 1. Select the acceptance environment

Record the owner-confirmed Google Cloud **Project ID**, a Web application OAuth client, a test Google account, and a protected Vercel acceptance origin. Do not reuse the existing Sheet service-account credential as an OAuth web client, or grant this app an operator's existing Calendar refresh token.

Use a dedicated acceptance store, or obtain explicit approval for writes against the shared production store. A different key namespace on shared storage is not proof of isolation or permission to run mutation/cleanup tests. The current deployment inherits shared storage; configuring OAuth alone does not authorize such tests. Select test mail recipients separately before sending messages.

Use one fixed HTTPS Vercel alias owned by the same project/team for the entire browser flow. Check its ownership and authentication protection before assigning it; never repoint the primary `sweetfun-os.vercel.app` domain as part of acceptance. A changing deployment URL cannot be embedded in a new deployment's fixed callback without coordinating the URL again. Do not assume an alias is available merely because its name looks suitable.

All of these must share one origin:

- The `/join` or `/start` page opened by the tester.
- The Google callback at `/api/customer-calendar/callback`.
- Email sign-in at `/signin`, and activation/recovery/invitation links.

Host-only browser cookies do not transfer between an alias and its underlying deployment URL. This is why testing from the deployment URL while returning to a different alias fails even in the same browser.

## 2. Configure Google Auth platform

In the selected project, enable Google Calendar API. Configure the app's branding and support contact, choose the intended audience, and add only the approved testers when using External / Testing. These steps follow [Google's consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent).

Create or select a **Web application** OAuth client. Register the exact callback:

```text
https://<owned-protected-alias>.vercel.app/api/customer-calendar/callback
```

Do not add a trailing slash, query or fragment. Google's [web-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server) requires the requested redirect URI to match the registered URI. This server flow does not require client-side Google JavaScript origins.

The onboarding request uses exactly:

```text
openid
email
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events.readonly
```

Existing-account Google sign-in requests only OpenID/email. No Calendar write, Drive or Gmail permissions are requested. Confirm the scopes in Data Access against [Google's Calendar scope reference](https://developers.google.com/workspace/calendar/api/auth).

External apps in Testing receive Calendar refresh tokens that expire after seven days. This is a provider testing limit, so passing initial consent is not evidence of long-term refresh reliability. Public release must satisfy the relevant Google verification requirements; see [Google's OAuth token-expiration guidance](https://developers.google.com/identity/protocols/oauth2#expiration).

## 3. Configure the acceptance deployment

Use a dedicated acceptance environment or explicit per-deployment settings. Do not silently change shared Production settings used by future primary releases. Store the client secret and encryption key through the secure environment-variable input; do not put them in chat, command arguments, Git, screenshots or logs.

| Setting | Required value / source |
| --- | --- |
| `CUSTOMER_CALENDAR_CLIENT_ID` | Selected Web application client ID |
| `CUSTOMER_CALENDAR_CLIENT_SECRET` | That same client's secret, server only |
| `CUSTOMER_CALENDAR_TOKEN_KEY` | Independently generated random 32-byte key, standard base64; preserve it across deployments so retained grants remain decryptable |
| `CUSTOMER_CALENDAR_REDIRECT_URI` | Exact callback registered above |
| `CUSTOMER_DEPLOYMENT_LINKS` | `true` for candidate links |
| `CUSTOMER_DEPLOYMENT_ORIGIN` | Fixed HTTPS Vercel origin, with no path or trailing slash |
| `CUSTOMER_CALENDAR_SYNC_ENABLED` | `false` during initial acceptance |
| `CUSTOMER_WORKSPACES_ENABLED`, `CUSTOMER_INTAKE_ENABLED`, `CUSTOMER_ONBOARDING_ENABLED` | `true` in the selected acceptance environment |
| `CUSTOMER_SESSION_SECRET` | Existing durable secret of at least 32 characters for that isolated environment |
| Customer store URL/token | Approved acceptance store; setting presence does not verify connectivity or isolation |

When `CUSTOMER_DEPLOYMENT_LINKS` is absent/false, email links retain the existing primary origin. When it is true and the fixed origin is omitted, they retain the existing `VERCEL_URL` behavior. A provided but empty or malformed fixed origin fails closed; it does not fall back to another domain. The fixed-origin override accepts only `https://<name>.vercel.app`. Custom domains require an explicit later change.

`CUSTOMER_INTAKE_PREVIEW=true` suppresses email. It is suitable for synthetic mail tests but cannot verify real email-link delivery. Keep continuous sync disabled until the separate scheduler acceptance below is complete.

With Node 22+ and the selected environment already securely loaded, run from `frontend/`:

```sh
node --experimental-strip-types scripts/check-calendar-setup.mjs https://your-owned-pilot.vercel.app
```

The checker prints only named boolean results and unresolved acceptance categories. It reads configuration without calling Google, sending mail, accessing storage or writing data. Exit 0 means offline configuration checks pass, **not** live acceptance. It verifies the runtime configuration, feature gates, exact callback origin, email origin, storage-setting presence and disabled initial sync. It does not verify secret validity, API enablement, consent registration, alias ownership/protection, storage connectivity/isolation or mail delivery.

## 4. Record real acceptance separately

Run only after the selected account, storage and any mail recipients are authorized. Use calendars containing synthetic bookings. Do not read unrelated private calendars or guest data.

| Scenario | Evidence required |
| --- | --- |
| New Google customer | Select account and grant read-only consent; preview opens without setting a password; source/calendar identity matches the selected account |
| Cancel / partial consent | Clear recovery path; no account/workspace claimed from a failed or partial return |
| Preview then save | No durable workspace before confirmation; intended room/date mapping and unknown money preserved; explicit save creates one workspace/batch |
| Retry / reload | Same save after a lost response returns the same workspace and batch; no duplicates |
| Account switching | A second account cannot claim the first account's draft or source grant |
| Email fallback / ICS | Link lands on the exact requesting origin; a different browser cannot consume the proof; returning restores the draft and still requires save confirmation |
| Refresh | Read succeeds after access-token expiry with the retained refresh grant; no tokens appear in evidence |
| Revoke / reconnect | Google revocation produces a reconnect state; existing bookings are retained and not silently treated as fresh |
| Mobile | iOS Safari and Android Chrome each test real consent return and ICS/ZIP file selection; mail-app browser changes show the expected restart guidance |
| Continuous sync | Only after initial acceptance: enable in isolated acceptance, verify two scheduled cycles plus changed/cancelled events, then decide separately whether to enable production |

Record deployment ID, commit, fixed origin, browser/device, test time, pass/fail and synthetic workspace/batch identifiers. Keep account addresses, calendar IDs, raw tokens and provider payloads out of the public repository. Provider acceptance does not itself authorize primary promotion.

## Follow-up review

Review identified a configuration defect in stable-alias testing: email links used the generated deployment URL while Google returned to the fixed alias. The server-only fixed-origin setting repairs that mismatch without changing the default primary or generated-URL behavior. Regression coverage rejects URL credentials, path/query/fragment, HTTP, lookalike hosts, empty overrides and unexpected ports; a domain-service mail test with synthetic data checks the stable link and same-browser consumption. Offline diagnostics fail on callback/email origin drift, missing credentials, disabled gates and premature sync, emit no secrets and make no network calls. No unresolved critical issue was found in this follow-up's changed paths; this is not a claim of completed real-provider acceptance.

Validation for this follow-up: 130 service/API/auth and 20 DOM tests pass (150 total), including the new offline preflight regression. TypeScript and the production webpack build pass. No new real-provider, browser or production-store acceptance is claimed.
