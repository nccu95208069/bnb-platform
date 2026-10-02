# Host service page and assisted onboarding

Owner decision: create a service page for inn owners to choose to join, answer the established property/room questions, then indicate whether current records are in Google Sheet. Sheet owners supply a link and share access; specialist consultation stays available. Non-Sheet owners receive assisted onboarding. Submitted consultation must email `linlab.ai2024@gmail.com`.

Implementation: `/join` presents the service, a three-step questionnaire (property/type → room names → current data), and a dedicated `/join/contact` page available from the landing page and every step. Consultation needs no registration or completed questionnaire. It preserves the answers already entered; a malformed/partial Sheet link does not prevent consultation. Sheet joining requires completed setup answers, a valid Google document link and an explicit sharing declaration. Links and declarations are not treated as verified access or a completed import.

Current onboarding instructions: share the Sheet with `linlab.ai2024@gmail.com`; submit an application for review before account activation. The sharing address reflects the latest owner instruction. The UI asks for named-user Viewer access with general access Restricted, includes copy-account assistance, and never requests public sharing or Editor permission.

The latest sharing/application decision supersedes the earlier default customer-owned OAuth flow **for this service intake page**. The existing customer OAuth import remains available in the gated workspace importer. This intake does not fetch a supplied link, create a workspace, infer Google access, import bookings, modify a Sheet, or enable unrestricted customer registration.

## Persistence and notification

- `POST /api/customer-intake` is an anonymous, same-origin, bounded-input endpoint with server-side validation, a honeypot, and IP/email/global request limits. It uses isolated `intake:<unguessable UUID>` keys in the customer namespace, not legacy customer data.
- Intent, inn/type/rooms, current source, supplied/normalized Sheet link, sharing declaration, contact person/email/phone or LINE ID, question text and consent are saved before mail. Public responses contain only the request ID and processing/notification status, not contact or Sheet details.
- A content hash and CAS protect each request. The server claims the notification before sending; duplicate/concurrent/replayed requests cannot trigger a second send. A provider timeout is retained as `needs_attention`, never automatically retried as though known unsent. Client errors retain a frozen submission and same request ID; same-tab reload can recover the pending submission from session storage. Success clears it.
- Both joining applications and consultations notify the operator so reviewable applications are not hidden in storage. The fixed recipient is `linlab.ai2024@gmail.com`; the public request cannot set a recipient, subject or sender. The existing platform Gmail mailer is used only for operator notifications, not to authorize or read customer Sheets. Existing invitation behavior and mail configuration are preserved.
- The mail includes contact details, every supplied questionnaire answer, link/sharing state, question and request ID. Provider acceptance is labelled as handed to the mail service, not proof of inbox delivery. Saved requests with unconfirmed notification have an explicit fallback contact message and ID.
- Intake records expire after 90 days. Email copies are retained separately by the operator; the form says so. There is no public listing/read API. Operator triage, deletion and recovery UI remain future work; do not claim automated follow-up or failed-email recovery exists.

## Runtime switches and rollout

`CUSTOMER_INTAKE_ENABLED=true` enables online submissions independently of the default-off customer-account feature. Without it the service page remains readable and offers email contact, while the API rejects intake.

`CUSTOMER_INTAKE_PREVIEW=true` is a local/synthetic preview switch: the page marks itself as a test, the API suppresses notification sending regardless of configured mail credentials, and the response identifies preview mode. Use a synthetic/local store and a dedicated customer namespace for that preview.

Actual notification sending requires the existing configured platform Gmail record, its `CALENDAR_OWNER_SESSION_SECRET`, and Redis credentials in the deployed runtime. No credentials or PII are included in code/tests. This change does not alter production environment flags, domains or existing deployment aliases.

## Verification and limits

- Service/route/mail tests cover partial consultation, Sheet join validation, current answers in mail, fixed recipient, CSRF/feature gating, honeypot, same-key changed-content rejection, concurrent submission, failed provider retention, lost-write-response recovery and Gmail sender/header checks.
- React DOM test covers the complete questionnaire, required Sheet sharing acknowledgement, switching to non-Sheet assisted entry, contact/consent, an interrupted response, same-tab reload and identical safe retry.
- Browser checks cover the real desktop and 390×844 service page, questionnaire branches, sharing guidance and consultation form. The local API returned 201 for a synthetic inquiry. No page overflow or framework error overlay was found.
- An attempted live synthetic notification on 2026-10-02 stopped before Google token exchange: Vercel's local environment runner omitted the protected owner/session secret. Read-only diagnostics confirmed that secret was absent locally, rather than establishing a revoked Google grant. No successful real email send or inbox delivery has been verified. No production mail configuration was changed. Verification must be completed in a reviewed deployed runtime where the protected secret is available; do not export or rotate that secret just to run the local test.
- Service page is not live on the production alias. Public deployment and real notification verification remain pending. Current customer-account lifecycle and import release gates still apply; submitting this form does not claim immediate self-service activation.
- Final local checks: 34 service/API/mail/legacy tests and 5 reported DOM tests pass; lint has no errors and two pre-existing warnings; TypeScript and webpack production build pass.

## Visual design follow-up

The public page and intake UI were redesigned around「把時間，留給款待」with an original hospitality image, self-hosted Chinese serif typography, interactive illustrated bookings, native FAQ and responsive editorial layout. Review rounds, asset provenance, generation prompt, accessibility and production-browser evidence are recorded in [SERVICE_JOIN_DESIGN_2026-10-02.md](SERVICE_JOIN_DESIGN_2026-10-02.md). Release gates above remain unchanged.

## Contact page follow-up — owner screenshot request

The owner requested a page instead of the consultation modal. Both consultation and the final joining contact form now use `/join/contact`; success is rendered there too. A shared `/join` layout preserves client state across Next route navigation and browser Back/Forward. The page has a normal document header, introductory column, form column and footer, with document scrolling instead of a fixed-height dialog or backdrop. Mobile stacks the columns. The top action returns to the questionnaire when applicable.

Unsent answers/contact fields are kept in this tab’s `bnb-intake-draft-v1` session storage, discarded when reopened after 24 hours or after success; that behavior is disclosed under the form. The existing immutable pending submission takes precedence on reload and redirects to the contact page for safe retry. Browser Back during an uncertain send freezes the questionnaire; reopening contact still uses the original request key/payload. No personal fields are placed in the URL. Mail/API behavior and fixed recipient are unchanged.

Validation: 6 DOM/SSR tests pass, including page entry without a dialog, returning with answers, refreshing an unsent draft, navigating back during an uncertain send, reloading and retrying the identical payload, and clearing drafts on success. TypeScript/webpack production build passes; lint has zero errors and the same two existing warnings. This follow-up has **not** received a fresh browser visual/end-to-end check: in-app browser access was denied because the admin-enforced browser security check was unavailable. Earlier screenshot/accessibility/performance evidence describes the prior modal design, not this new contact route. The local production preview is updated for owner review; no production deployment occurred.

## Production release — 2026-10-02

The owner explicitly requested 上線 after approving the service-page copy. This section supersedes the historical statements above that service deployment and live mail verification were pending.

- Production service: https://sweetfun-os.vercel.app/join ; contact: https://sweetfun-os.vercel.app/join/contact . Both return HTTP 200 with the new release content after alias verification.
- Release source `e3c83e3` integrates the service branch with production history through `4782d5b`, including the deployed `7fceb27` phone-member email fix and current customer-manager changes. It does not replace these with the older feature-branch baseline.
- Ready deployment `dpl_35JmiPZPbjHnSQb5dPtJMEx3FDw6`, https://sweetfun-b0h3kvd6o-sweetfuns-projects.vercel.app . Cloud Next/Turbopack build and TypeScript passed; build completed in 23 seconds. Promoted and explicitly assigned `sweetfun-os.vercel.app`; independent inspection verified the deployment ID and READY state.
- Production switches: `CUSTOMER_INTAKE_ENABLED=true`, `CUSTOMER_INTAKE_PREVIEW=false`. Existing account/import gates remain disabled. No customer workspace or booking import is activated by this release. Existing mail credentials, backend jobs, sources and owner access remain unchanged.
- One labelled synthetic consultation was submitted with request ID `72309e8b-6000-4df6-b46d-8a54ecf5ed42`. API returned 201, saved/awaiting_review and notification accepted. A scoped readback confirmed the exact synthetic record, a provider message ID, and approximately 90-day Redis TTL. The same request replay returned the identical result. Notification was addressed to the fixed operator email. Provider acceptance is verified; inbox receipt has not been observed. The marked TEST record remains subject to the normal TTL.
- Deployment checks: landing/contact routes and image/font assets return 200; anonymous workspace members return 403 and calendar data 401; cross-origin intake returns 403; customer workspace creation retains 503 FEATURE_UNAVAILABLE. These are HTTP/content/API checks, not fresh visual browser verification.
- Regression checks: 34 service/API/mail/legacy tests and 6 DOM/SSR checks pass. Frontend lint has zero errors/two pre-existing warnings. Backend Ruff lint/format pass, 166 tests pass and 45 environment-dependent tests skip.
- Runtime log inspection through the connected Vercel tool returned permission-denied 403, so no clean runtime-error scan is claimed. Prior in-app browser security-check unavailability still limits fresh visual verification.
- Rollback target: `dpl_55vs49AA5BJ5amwKQVduqSUJcv7i`, https://sweetfun-mg3zay3j2-sweetfuns-projects.vercel.app . Repoint the production aliases to that verified prior deployment if needed; intake records remain isolated in the customer namespace. No migration or legacy data replacement occurred.

### Dark appearance follow-up — 2026-10-02

The owner's follow-up requested switchable dark mode for nighttime phone use. Release `8e8c35c` adds system/light/dark appearance on the service, questionnaire, contact and completion surfaces. System is the default; a scoped cookie is read by the server so a saved manual choice is included in initial HTML. Dark photo brightness is 68%. No mail, account gate or operational data behavior changed.

Cloud build/TypeScript passed in 17 seconds. Six DOM/SSR regressions pass; lint has no errors and the same two existing warnings. The deployed landing and contact routes each returned 200 with correct initial markup for all three modes; invalid preference falls back to system. Served CSS includes system-dark media rules, dark surfaces and photo dimming. Main dark text token contrast pairs were calculated at 6.49–12.73. Native browser/real-phone visual verification was not possible because the Mac is locked and browser initialization failed.

Promoted deployment `dpl_2WT62HJWfv3i2oso2NTHGacbjYiX`, https://sweetfun-23znroa8m-sweetfuns-projects.vercel.app , explicitly assigned to https://sweetfun-os.vercel.app . Rollback for this appearance-only update is the prior service release `dpl_35JmiPZPbjHnSQb5dPtJMEx3FDw6`.


### Operator contact update

The owner changed the service email to `linlab.ai2024@gmail.com`. The public contact/mailto address, application/consultation notification recipient and named-user Google Sheet Viewer-sharing instructions now use that address. The notification mailer imports the central intake recipient instead of maintaining another literal. The existing sender authorization is unchanged. No existing submissions are resent and no previously shared Google Sheet permissions are changed automatically.

Validation: 14 intake/mail/legacy authorization tests and 2 intake DOM/SSR checks pass, including the new fixed To header; lint has zero errors/two existing warnings. This address update does not claim a new observed inbox delivery.

Address release `21d9f87`: cloud build/TypeScript passed in 18 seconds, and the local production build also passed. Landing/contact HTTP content checks confirmed the new mailto address and no old service address. Promoted deployment `dpl_2jLsmZFuqA9hv4uxpzE2CcU4M9uC` (https://sweetfun-b4zs68u4g-sweetfuns-projects.vercel.app) to the same production domain. Prior dark-mode deployment `dpl_2WT62HJWfv3i2oso2NTHGacbjYiX` is the rollback target. The earlier live notification smoke test predates this address change and went to the previous recipient; no new live test email was sent for this update.
