# Host service page and assisted onboarding

Owner decision: create a service page for inn owners to choose to join, answer the established property/room questions, then indicate whether current records are in Google Sheet. Sheet owners supply a link and share access; specialist consultation stays available. Non-Sheet owners receive assisted onboarding. Submitted consultation must email `nccu95208069@gmail.com`.

Implementation: `/join` presents the service, a three-step questionnaire (property/type → room names → current data), and a consultation dialog available from the landing page and every step. Consultation needs no registration or completed questionnaire. It preserves the answers already entered; a malformed/partial Sheet link does not prevent consultation. Sheet joining requires completed setup answers, a valid Google document link and an explicit sharing declaration. Links and declarations are not treated as verified access or a completed import.

Two working assumptions were presented to the owner while implementation continued: share the Sheet with `nccu95208069@gmail.com`; submit an application for review before account activation. The owner can change these choices. The UI asks for named-user Viewer access with general access Restricted, includes copy-account assistance, and never requests public sharing or Editor permission.

The latest sharing/application decision supersedes the earlier default customer-owned OAuth flow **for this service intake page**. The existing customer OAuth import remains available in the gated workspace importer. This intake does not fetch a supplied link, create a workspace, infer Google access, import bookings, modify a Sheet, or enable unrestricted customer registration.

## Persistence and notification

- `POST /api/customer-intake` is an anonymous, same-origin, bounded-input endpoint with server-side validation, a honeypot, and IP/email/global request limits. It uses isolated `intake:<unguessable UUID>` keys in the customer namespace, not legacy customer data.
- Intent, inn/type/rooms, current source, supplied/normalized Sheet link, sharing declaration, contact person/email/phone or LINE ID, question text and consent are saved before mail. Public responses contain only the request ID and processing/notification status, not contact or Sheet details.
- A content hash and CAS protect each request. The server claims the notification before sending; duplicate/concurrent/replayed requests cannot trigger a second send. A provider timeout is retained as `needs_attention`, never automatically retried as though known unsent. Client errors retain a frozen submission and same request ID; same-tab reload can recover the pending submission from session storage. Success clears it.
- Both joining applications and consultations notify the operator so reviewable applications are not hidden in storage. The fixed recipient is `nccu95208069@gmail.com`; the public request cannot set a recipient, subject or sender. The existing platform Gmail mailer is used only for operator notifications, not to authorize or read customer Sheets. Existing invitation behavior and mail configuration are preserved.
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
