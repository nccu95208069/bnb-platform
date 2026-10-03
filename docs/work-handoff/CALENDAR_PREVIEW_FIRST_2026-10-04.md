# Calendar preview before signup — 2026-10-04

The latest owner decision replaces the account/password-first calendar flow: Google login and read-only consent → preview → explicit import; ICS/ZIP selection → preview → email login only when saving, with no new password. It supersedes the activation-first wording in `CALENDAR_ONBOARDING_2026-10-04.md`. Existing Sheet and consultation onboarding remain supported.

## Delivered flow

- All three calendar choices on `/join` open `/join/calendar` after property/room questions. No contact form, password or account creation is required to upload and preview a file.
- Preview records use a secret HttpOnly/SameSite browser cookie and isolated server-side keys with a fixed one-hour lifetime. Uploaded guest data is not placed in localStorage. Anonymous preview does not create a durable workspace or account, or send the legacy application/operator notifications.
- Google login requests `openid email` plus the two existing Calendar read-only scopes for onboarding. The ID token is verified against Google's signing keys, issuer, audience, recent lifetime, nonce, authorized party and verified email. Stable Google subjects identify linked accounts. Gmail/Workspace identity can verify the email; a previously unlinked third-party Google email requires a fresh email link before claiming an existing account. No Google password is collected. The email-authority distinction follows [Google's server-side token verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
- File users choose rows and confirm their interpretation before being asked for an email. A 15-minute login link is bound to the requesting browser and the exact active draft/request. The token is carried in the URL fragment, removed after hydration and consumed only after the user clicks; a mail scanner GET cannot log in or import.
- Returning from login restores source, mapping, preview, selection, coverage and import mode. The user confirms the displayed account before saving. A different browser account or a conflicting Google/email identity cannot silently claim the draft.
- Final save atomically creates the workspace, ownership reference, import batch, bookings/blocks, retained preview/source, Google connection and applicable job registration. Authoritative readback verifies ownership and batch identity. An exact retry after an uncertain result returns the same workspace and batch.
- Accounts created this way are passwordless. `/start` provides email-link and configured Google sign-in; existing password login and recovery remain usable. Passwordless members can accept invitations using the verified account session. Recovery can establish a password later without making it a prerequisite.
- New calendar joins enter the workspace directly. They do not fabricate contact names, application consent records or a legacy contact-review journey. Sheet/consultation applications retain their existing operator queue and mail workflow.

## Security and review cycles

| Cycle | Finding | Repair and evidence |
| --- | --- | --- |
| 1 | The preview-to-workspace transaction must retain the source/preview under the authenticated actor, and all callback paths must honor feature gates. | Source/preview ownership transfers in the same transaction; public Google callback respects workspace and onboarding gates. Scope/feature-off tests pass. |
| 1 | A pre-claimed unverified account could retain a password known to someone other than the verified email owner. | Successful verification replaces its credential revision with a passwordless credential. Old password/session and earlier recovery/login bindings fail; verified existing passwords are preserved. |
| 2 | Concurrent Google returns could update calendar credentials separately from the winning draft identity, risking account/calendar identity mismatch. | Grant and draft identity now use one compare-and-set transaction. A delayed first account's callback loses without overwriting the second account's grant; the regression test verifies the actual Authorization token used afterward. |
| 2 | Returning to edit could leave a previous email request usable; passwordless accounts could be trapped at an invitation password prompt. | Editing invalidates the active login request. Invitation acceptance accepts only a matching verified/current session or the existing password path. Wrong account/stale credential tests pass. |
| 3 | A different signed-in account could obscure the required email challenge, leaving the user at a save error. | The view and retry response expose a confirmable account only when it matches the draft identity; the mismatched account remains unable to save. |
| 4 | Re-reviewed authentication, draft expiry/isolation, concurrent ownership, provider revalidation, immutable retry, financial unknowns, feature gates, response data and UI recovery after repairs. | No unresolved critical finding remains in the reviewed change. Tests include RSA signature/audience/issuer/nonce failures, partial consent, third-party email takeover prevention, concurrent OAuth, account switching, CSRF, oversized uploads, stale links, exact retries and restored UI state. |

The dependency audit reports **0 critical, 5 high and 4 moderate** production findings. Existing editor/export/transitive findings are unchanged from the prior calendar delivery; zero critical does not mean zero vulnerabilities. `jose` 6.2.12 is pinned as the direct ID-token verifier. No legacy owner credential format or production secret was changed.

## Verification

The exact customer CI command set passes **129 service/API/auth tests and 20 DOM tests (149 total)**. It includes prior Sheet, calendar, payments, tenant isolation and legacy owner-session regressions. The new UI path exercises anonymous upload/preview, deferred login, explicit email-link consumption, restored preview and a lost-save-response retry against the real domain functions. The entry test covers all three calendar choices. Lint has zero errors and seven existing warnings. The production webpack build and TypeScript pass. Cloud acceptance status is recorded below.

All account, mail, Google and store fixtures are synthetic. No real applicant or guest email, real Google grant, production account login or production customer-data write was used as a test. Browser visual/mobile acceptance is not claimed.

## Configuration and remaining live acceptance

The existing four `CUSTOMER_CALENDAR_*` OAuth/encryption settings are still required. This implementation adds OpenID/email scopes to the same OAuth client and exact callback; Calendar API and consent configuration must permit them. The candidate currently lacks those Google settings, so real Google consent, refresh, revocation and mobile return remain unverified. The UI offers ICS/ZIP while Google is unavailable. Direct iCloud/CalDAV, Apple EventKit and Android phone-local readers remain outside this web implementation.

Magic-link delivery uses the existing configured operator mail transport and trusted deployment-specific origin. The link must be opened in the browser that requested it; a different mail-app browser must restart the request there. `CUSTOMER_INTAKE_PREVIEW=true` suppresses actual mail and the UI explicitly reports that the email is not verified. No password is silently generated or emailed. Continuous Calendar mode stays disabled in the protected candidate pending real provider acceptance.

## Delivery

The change remains in draft PR #26, stacked on `codex/sweetfun-bots`; the primary domain is not promoted. The prior GitHub run was blocked before all jobs by account billing. Local checks and the cloud build are tracked independently, not reported as a green GitHub CI run. Protected candidate URL and read-only deployment checks are appended after deployment.

Implementation commit `9ba7e29d3b2d2690cb5ac414de5c5e33198fe2dc` is READY at [the protected preview-first candidate](https://sweetfun-bzdbx1b5y-sweetfuns-projects.vercel.app/join), deployment `dpl_Br39QcQ8ZYQzKqWz2SHsCJ2PGEeK`. Cloud Turbopack/TypeScript completed successfully; build output took 22 seconds. Vercel authentication remains enabled. Six entry pages return 200, seven anonymous customer/cron requests return 401, and a public-preview read without its cookie returns 409. These checks made zero customer-data writes and sent zero mail. The primary domain is unchanged at `dpl_4RtToxbsPMUWt1bw25Mn2cvUvg82`.

[GitHub run 37146929183](https://github.com/nccu95208069/bnb-platform/actions/runs/37146929183) reports all three jobs unstarted because the account is locked for billing. The final local command set is 149/149 passing; TypeScript, webpack production build and cloud build pass; lint remains zero errors/seven warnings. No primary promotion or real-provider acceptance is implied.
