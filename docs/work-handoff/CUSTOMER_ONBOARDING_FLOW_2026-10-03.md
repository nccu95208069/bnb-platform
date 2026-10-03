# Customer onboarding: shared Sheet to verified calendar

October 4 implemented extension: [Calendar onboarding, backend and review](CALENDAR_ONBOARDING_2026-10-04.md). The shared entry now includes Google Calendar, iPhone/iPad Calendar and Android Calendar. Calendar applications bypass the Sheet URL/sharing gate and route to Google read-only authorization or ICS/ZIP import. The Sheet-specific flow and historical acceptance evidence below remain applicable to Sheet customers. Actual Google OAuth and mobile acceptance are pending configuration and device testing.

Latest October 3 decision and implementation: [standard workbook and conversion rules](STANDARD_SHEET_2026-10-03.md). Source owner/editor identity matching is removed; grouped order, nightly and grid conversion is implemented. Historical deployment/test evidence below belongs to the earlier candidate unless explicitly updated.

For the October 3 follow-up, see [customer operations](CUSTOMER_OPERATIONS_2026-10-03.md): multiple properties, independent source readiness/coverage, format suggestions, collaborator invitations, availability pricing and receipts. The deployment evidence below describes the preceding onboarding candidate; it is not verification of the new operations.

Status: implemented and running in a protected acceptance deployment from `658e1d9`; **the primary production domain is unchanged**. Dedicated Google reader credentials are configured, real Sheet access checks pass, and an authorized applicant receipt has been verified in the recipient’s Gmail INBOX. Customer activation, import acceptance and explicit permission to switch the primary domain are still pending.

## Accepted flow

1. Customer provides property type, room names and a Google Sheet link on `/join`.
2. Customer shares the file as Viewer with the **system reader email displayed on the page**. `linlab.ai2024@gmail.com` remains the service contact and operator-notification recipient. It is not automatically an authenticated website reader.
3. Customer presses “檢查分享權限”. A green check means Google allowed metadata access; a red cross means invalid/unavailable sharing. A separate unavailable state represents server/Google failures. Changing the URL clears the result; stale responses cannot restore an old check. The public response never reveals file titles, rows or owner addresses.
4. The server rechecks access at submission, saves the application, and independently records delivery to the operator and applicant. The applicant receipt contains a 24-hour email verification/password-setup link. A lost response can be retried with the same request key; uncertain delivery is never automatically resent.
5. `/account-setup` verifies the email link, sets the customer's own password, and creates one isolated workspace. The readable source file is bound at workspace creation. Per the latest owner decision, no owner/editor email evidence or operator identity approval is required. Customer membership, property scope and the server-bound file still govern operational reads.
6. Customer selects a tab, maps columns and room labels, specifies what each row and amount mean, then checks a grouped-order preview. Only explicitly selected complete valid groups are imported after confirmation. If the source changes after preview, the server refuses the write and requires a fresh preview.
7. Bookings and completeness are saved atomically. An independent email reports the imported count and any unresolved rows. Until the source is complete, new bookings are blocked and the calendar says that missing records do not mean availability. Retrying after preview expiry or retrying an older batch cannot reset completeness. Guarded undo also restores the incomplete state.

The implementation remains a one-time migration, without writeback, ongoing Sheet synchronization, OTA inventory changes or guest notifications.

## Timing and format policy

After account email verification and format confirmation, the system starts processing immediately and shows the persisted result. Source-owner identity is not a gate. There is no deliberate waiting queue or invented delivery SLA. Requests needing format assistance show their reason; no completion time is promised before seeing the data.

Supported sources: whole orders, room/date segments, nightly rows and explicitly grouped calendar grids, with full-year dates, at most 501 rows including headers and 52 columns per read, TWD. Multi-room/villa orders retain one order total and one cumulative source-paid summary. Blank amounts stay unknown; source summaries do not fabricate dated payment transactions. Duplicate occupied nights, contradictory grouped values, unavailable rooms and invalid dates are blocked. Unclear merged-cell/visual-only layouts still require explicit mapping; the original source does not need a new normalized tab.

The customer can request help on the import page. `/onboarding-admin` lists the latest 50 applications with applicant delivery state, verified/partial/ready status, counts and help messages. Only the legacy platform owner/god can access it; property administrators and customers cannot. The operator can recheck source readability, send concrete correction instructions, and explicitly resend a receipt. Source identity confirmation is removed.

## Configuration and rollout

Do not enable the flow until all of these exist in the **new deployment**:

- `CUSTOMER_INTAKE_ENABLED=true`
- `CUSTOMER_ONBOARDING_ENABLED=true`
- `CUSTOMER_WORKSPACES_ENABLED=true`
- `CUSTOMER_INTAKE_PREVIEW=false` for real use; `true` suppresses both operator and applicant mail
- `CUSTOMER_SESSION_SECRET`: independently generated server secret, at least 32 characters
- `CUSTOMER_SHEET_READER_CREDENTIALS`: dedicated Google service-account JSON containing `client_email` and `private_key`, configured as a protected server environment variable; Google Sheets and Drive APIs enabled
- Existing Redis and verified operator Gmail transport remain available
- `CUSTOMER_SELF_SIGNUP_PREVIEW` absent/false: public registration is closed, email link activation is required

The source reader requests only the Sheets read-only scope and never queries Drive owner/editor metadata. Share the synthetic source as Viewer with its displayed service-account address. Do not reuse the existing live-property monitor credentials or broaden the original customers' permissions. Credentials must be installed through secure environment settings, never committed or pasted into the application form. The user completed the service-account setup and enabled both APIs. Connecting the contact Gmail address would be a different OAuth implementation and is not implied by changing the contact address.

The existing generic Google OAuth importer remains available to older non-onboarding workspaces. New applications always use the file bound on the server; arbitrary client-supplied file identifiers are ignored.

Release in a candidate deployment first. Verify sharing denied → allowed, actual applicant email receipt, account link activation, source preview, selected import, authoritative persisted calendar, retry, and unrelated-account denial. Only then enable the public release. Provider acceptance alone does not prove inbox delivery. An authorized applicant receipt was sent from the protected acceptance deployment and verified in Gmail INBOX; the primary production domain has not been switched.

## Verification

- 43 service/API/auth regression tests pass, including a complete HTTP route flow against synthetic Google responses and an isolated Redis mock; email recipients are verified independently.
- Live Redis verification using three unique synthetic keys passed: mixed persistent/expiring atomic write, TTL, all-or-nothing conflict, and exactly one winning concurrent claim. All three test keys were deleted and absence read back; no customer records were read or changed.
- 9 DOM tests pass, including sharing cross/check, changed-link invalidation, stale-response rejection, activation failures, password recovery, existing calendar conflict handling and import retries.
- Production webpack build including TypeScript passes. ESLint has zero errors and two unchanged calendar warnings.
- Six service scenarios include 5 source rows → 3 valid imports + 2 blocked → correct the 2 rows → 5 total orders, without duplicating the original 3. A villa total stays 12,000 across 2 rooms and its received source total stays 4,000. Empty financial fields remain null.
- Recovery invalidates old sessions and previously issued links. Activation cannot be replayed with only the token after it is consumed; lost responses require the chosen password.
- Previous real Sheet and live intake tests on 2026-10-02 demonstrated native Sheet contents and operator notification; they did not validate this new reader, applicant receipt, activation or website import end-to-end.
- Browser visual verification is pending because the computer-use browser service was unavailable. DOM assertions and builds are not a substitute for that check.

Remaining: customer-controlled activation and import acceptance, browser verification, explicit production-switch authorization, and final production release. Do not report the entire customer journey as shipped until these pass.

## Reader setup follow-up

The user supplied a dedicated service-account key through a local file and enabled the Sheets and Drive APIs. `CUSTOMER_SHEET_READER_CREDENTIALS` and a newly generated `CUSTOMER_SESSION_SECRET` are saved as sensitive production environment variables. The workspace/onboarding flags are prepared for the next deployment; existing production deployments are unchanged. The synthetic Sheet is shared as Viewer with the dedicated reader, verified through Drive permission readback. No key content is stored in this repository.

An actual `SERVICE_DISABLED` response revealed that a Google API configuration failure could be confused with missing sharing permissions. The reader now reports this as a system setup problem; an added regression test passes (8 onboarding/API tests in the focused suite). Live deployment and email checks are still pending.

A production-environment candidate was built and passed real Google checks: shared file readable, unavailable file refused, cross-origin calls refused, anonymous operational data denied, self-registration closed and new pages HTTP 200. The primary production domain was not changed: automatic approval review rejected promotion because this rollout still needs explicit owner approval and actual applicant email validation.

For email acceptance testing before promotion, a deployment-only `CUSTOMER_DEPLOYMENT_LINKS=true` override now directs lifecycle links to Vercel's own `VERCEL_URL`. This is validated server-side and never uses request headers or applicant-supplied URLs. The default remains the fixed public domain. A release intended for the public domain must omit this override. The added origin tests cover safe defaults and malformed hosts.


## Live acceptance evidence

- Dedicated reader successfully calls both Google Sheets and Drive APIs; the synthetic source is readable and ownership metadata matches the authorized applicant.
- Protected deployment `dpl_9rM84fZScH5BuRd4qTj9yjgbutNx` is READY at https://sweetfun-9mkskbj30-sweetfuns-projects.vercel.app . Its links target that deployment, and its existing Vercel authentication protection remains enabled.
- One clearly named synthetic application returned HTTP 201, persisted successfully, reported verified Sheet access, and recorded independent operator/applicant provider acceptance. Retrying the identical request returned the same result without a new send.
- A targeted Gmail lookup of the authorized applicant’s specific test application found exactly one confirmation email. Metadata confirms INBOX delivery (not SPAM), the correct subject/recipient and the test deployment link. The password has not been set by the agent.
- Scoped authoritative storage readback confirms the saved source/application and applicant delivery record. Latest observed state is waiting for email verification; there are no imported orders yet.
- Primary `sweetfun-os.vercel.app` independently remains READY on `dpl_2jLsmZFuqA9hv4uxpzE2CcU4M9uC`. No promote/alias change was executed after the automatic approval rejection.
- Final cloud build including TypeScript passed (17 seconds build); 43 service/API/auth and 9 DOM tests pass; lint has zero errors and the same two pre-existing warnings.
- The computer-use browser service still fails initialization. No automated browser walkthrough is claimed; the customer is being asked to perform the password step themselves.
