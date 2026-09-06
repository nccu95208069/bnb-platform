# Workspace accounts and Gmail invitations — 2026-09-06

Owner explicitly requested:
- sender and initial admin email: sweetfuntw@gmail.com;
- retain the owner's already-set password;
- remove the three browser-only test members;
- make invitation/password/login usable for testing.

## Implemented scope

The Sheet-calendar build now uses real account authorization instead of the demo
Owner assigned to every visitor. /calendar-access (and /admin/login compatibility
entry) accepts Email + password. Initial admin is internally the non-assignable
Owner so they can manage members. Their existing Redis/scrypt credential is used
in place and never migrated, reset or copied by this change. Existing owner
cookies remain valid. /calendar-password works for owner and activated members.

New members are persisted in the existing Redis service. Only server-verified
Owner can list, invite, edit property/role scopes or suspend/re-enable members.
There is no open signup. Email invitations are 256-bit random, SHA256-hashed at
rest, expire after 24h, and are consumed via atomic compare-and-swap when setting
a scrypt password. Links carry tokens in a fragment, immediately removed from the
address bar; the activation API accepts them in a POST body. Reissuing a link
invalidates the previous link. Active members can receive a reset-password invite;
their existing session is revoked when the new password is set. Suspension revokes
existing sessions permanently, including after re-enabling. Role/property scopes
are re-read from server storage on every protected request. Writes use expected
versions and readback; the last 200 account-operation audit events are persisted.

Member sessions are signed, HttpOnly, Secure on HTTPS, SameSite=Strict, 12h, and
bound to that member's password revision. Owner and member cookies are mutually
cleared on login. Credentials and invitation hashes never appear in member-list
responses. Account-specific palette preferences use authenticated member ids.

Calendar projection limits authenticated members to allowed properties before
reading any private Sheet names. Hidden-price members and unauthenticated visitors
receive no real money values or financial notes/payments/nightly prices. Numeric
zero is a redacted transport placeholder with explicit price_hidden=true. Invalid
sessions receive the public anonymous projection; they cannot retrieve private
names/prices. All Sheet writes remain disabled for every role. Formal payment /
booking mutation workflows are still outside this slice.

## Three legacy test members

Those records lived only in the old sweetfun-os-access-control localStorage key.
The live build uses a new UI preference key and removes the old demo key when the
app initializes. The owner's phone must refresh/open the new version to execute
that local deletion. Old demo records are never imported to the server. This
change does not clear calendar navigation or palette preferences.

## Mail authorization and actual delivery boundary

/settings/email is Owner-only. Sender is fixed to sweetfuntw@gmail.com. The owner
must supply a dedicated Gmail app password there (not the Gmail login password).
The app verifies SMTP over TLS, sends a test email to the sender itself, encrypts
the app password with AES-256-GCM under a purpose-separated key derived from the
existing server signing secret, persists it, and reads it back. It never returns
the password to the browser. Until configured, invitations are disabled with an
explicit setup link. Gmail accepting a message is recorded as sent; actual inbox
receipt must be checked by the owner. Failed/uncertain delivery remains a visible,
recoverable member record and can be resent; it never claims successful delivery.

Automatic approval review rejected an attempt to extract/copy an existing Gmail
OAuth credential from the production Cloud Run order handler. That action was NOT
executed and must not be retried indirectly. No Cloud Run or Google credentials
were modified. The Gmail connector is signed into a different mailbox and was
NOT used to send anything. A new dedicated Gmail app-password authorization is the
safe alternative; the owner must complete it. No real invitations/test emails
have been sent during implementation; SMTP is mocked in automated tests.

## Storage and deployment

Existing Redis is reused; no paid service, Supabase migration or new environment
secret is needed. Keys under sweetfun-os:workspace-auth:v1 hold members/audit, rate
limits and encrypted mail settings. WORKSPACE_AUTH_NAMESPACE permits isolated
tests only. The existing owner-auth key is unchanged. The Gmail app password must
be re-entered if the server signing secret is rotated. Nodemailer and its types
are exact-version dependencies. No GitHub push was performed.

## Validation

Frontend lint and production build pass. Automated tests cover complete route flow
(owner Email/password login preserving the credential -> configure mocked SMTP ->
invite -> inspect -> activate -> member login -> separate palette -> scope ->
suspend), owner-only APIs, CSRF, duplicate emails, privilege escalation, expected
versions, expiring/reused/replaced tokens, concurrent activation, failed delivery,
password encryption, session revocation and server-side monetary redaction. Existing
owner credential and appearance authorization tests continue passing. Local mobile browser QA passed for login and anonymous authorization gating.
Production owner UI could not be inspected because the Mac was locked. Production
HTTP checks passed: login/email-setup/activation pages 200, anonymous session
unauthenticated, members/mail APIs 403, and calendar 200 with all 144 returned
September booking rows monetarily redacted. All 15 targeted tests passed.

Deployed source commit 54419b0 to production:
https://sweetfun-88awpqmc5-sweetfuns-projects.vercel.app
Alias: https://sweetfun-os.vercel.app
Real Gmail delivery still awaits the owner's dedicated app-password setup.

Run:
node --experimental-strip-types --loader ./frontend/tests/helpers/next-route-loader.mjs --test frontend/tests/workspace-auth*.test.mjs frontend/tests/calendar-appearance-route.test.mjs frontend/tests/owner-password.test.mjs frontend/tests/calendar-owner-session.test.mjs

## Follow-up: owner cannot see booking prices

A persisted viewer_no_price preview could survive an owner login and hide prices
in the UI even when the server authorized full data. Live preview state is now
session-only: legacy persisted previews are ignored, reload/login restores the
owner's actual role, and the calendar displays an explicit preview notice with a
restore-admin button. Calendar data reloads on account/role changes, and detail
prices also honor the server's price_hidden flag rather than showing redacted zero
values. Mobile month cells still prioritize platform/room/name; room fees are in
the opened booking details.

Regression test access-preview.test.mjs exercises persisted preview hydration,
owner login, deliberate in-session preview, reload reset, and a real restricted
member. Test, frontend lint and production build pass. Current phone state was not
inspected because the Mac browser surface was locked; the persisted-preview defect
is code/test-confirmed, not a claim of having observed this user's current storage.

## Gmail authorization follow-up (explicit owner approval)

The owner subsequently explicitly approved copying/reusing the original order
handler's Gmail credential and asked the agent to complete setup. This supersedes
the earlier missing-authorization blocker. A read-only extraction of that exact
Cloud Run GMAIL_TOKEN_B64 was approved and executed. Google refresh/profile checks
confirmed sweetfuntw@gmail.com and gmail.send/modify/readonly scopes. The source
service was not changed. No credential values are stored in this repository.

The app now supports encrypted gmail_oauth mail settings alongside the existing
app-password SMTP path. Each send refreshes access and validates the Gmail profile
matches the fixed sender before sending through Gmail API. Only client id, client
secret and refresh token are encrypted into the existing private Redis mail key;
access tokens remain transient. OAuth setup has no public credential-import route.
Owner settings show the connected Google method without requesting another secret.

Tests cover encrypted persistence, invitation MIME/Chinese text, safe error handling,
wrong sender, missing send scope, refresh failure, header injection and the original
SMTP/member route flow. All 8 targeted tests, lint and production build passed.
Live configuration and test-message receipt are recorded after deployment below.

Primary API references:
https://developers.google.com/workspace/gmail/api/auth/scopes
https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send

Live completion: source commit 8865a7c deployed to
https://sweetfun-jmzulcoe5-sweetfuns-projects.vercel.app and aliased to
https://sweetfun-os.vercel.app. Production Redis mail settings were initialized
with gmail_oauth and read back successfully at 2026-09-06T12:38:10.173Z. The actual
test email "Sweetfun OS 寄信已啟用" was confirmed via its exact Gmail message id
with both SENT and INBOX labels. No messages to staff were sent during setup.
The authoritative owner credential was identical before/after. The temporary
plaintext Gmail credential copy and setup script were removed after verification.
The retained production credential is encrypted in the private Redis mail key.
