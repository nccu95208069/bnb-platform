# Customer onboarding: shared Sheet to verified calendar

Status: implemented and locally verified on `codex/customer-onboarding`; **not enabled or deployed to production**. The production service page still runs the earlier assisted intake. Google reader credentials and real applicant email delivery must be configured and verified before this is called complete.

## Accepted flow

1. Customer provides property type, room names and a Google Sheet link on `/join`.
2. Customer shares the file as Viewer with the **system reader email displayed on the page**. `linlab.ai2024@gmail.com` remains the service contact and operator-notification recipient. It is not automatically an authenticated website reader.
3. Customer presses “檢查分享權限”. A green check means Google allowed metadata access; a red cross means invalid/unavailable sharing. A separate unavailable state represents server/Google failures. Changing the URL clears the result; stale responses cannot restore an old check. The public response never reveals file titles, rows or owner addresses.
4. The server rechecks access at submission, saves the application, and independently records delivery to the operator and applicant. The applicant receipt contains a 24-hour email verification/password-setup link. A lost response can be retried with the same request key; uncertain delivery is never automatically resent.
5. `/account-setup` verifies the email link, sets the customer's own password, and creates one isolated workspace. The source file is bound at workspace creation. File ownership/editor metadata must match the verified email; otherwise the applicant waits for operator review. Knowing a file URL is insufficient to read another customer's shared file.
6. Customer selects a tab, maps columns and room labels, specifies what each row and amount mean, then checks a preview. Only explicitly selected valid rows are imported after confirmation. If the source changes after preview, the server refuses the write and requires a fresh preview.
7. Bookings and completeness are saved atomically. An independent email reports the imported count and any unresolved rows. Until the source is complete, new bookings are blocked and the calendar says that missing records do not mean availability. Retrying after preview expiry or retrying an older batch cannot reset completeness. Guarded undo also restores the incomplete state.

The implementation remains a one-time migration, without writeback, ongoing Sheet synchronization, OTA inventory changes or guest notifications.

## Timing and format policy

After email, ownership and format confirmation, the system starts processing immediately and shows the persisted result. There is no deliberate waiting queue and no invented delivery SLA. Production processing latency remains unmeasured until the real integration test passes. Requests needing human review show their reason and require an operator response; no completion time is promised before seeing the data.

Supported source: one complete order per row, explicit year in dates, at most 501 rows including headers and 52 columns per read, TWD. Multi-room/villa orders retain one order total; blank amounts stay unknown; historical received totals are source values and do not fabricate payment transactions. Duplicate imports, unavailable rooms and reversed dates are blocked. Calendar grids, merged layouts, per-night rows and ambiguous amounts require assisted conversion into a separate normalized source tab before customer preview and confirmation.

The customer can request help on the import page. `/onboarding-admin` lists the latest 50 applications with applicant delivery state, verified/partial/ready status, counts and help messages. Only the legacy platform owner/god can access it; property administrators and customers cannot. The operator explicitly verifies identity before releasing a file, can send concrete correction instructions, and can explicitly resend a receipt.

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

The reader requests only Sheets read-only and Drive metadata read-only scopes. Share the synthetic source as Viewer with its displayed service-account address. Do not reuse the existing live-property monitor credentials or broaden the original customers' permissions. Credentials must be installed through secure environment settings, never committed or pasted into the application form. Service-account setup still needs the user's Google account/project access; connecting the contact Gmail address is a different OAuth implementation and is not implied by changing the contact address.

The existing generic Google OAuth importer remains available to older non-onboarding workspaces. New applications always use the file bound on the server; arbitrary client-supplied file identifiers are ignored.

Release in a candidate deployment first. Verify sharing denied → allowed, actual applicant email receipt, account link activation, source preview, selected import, authoritative persisted calendar, retry, and unrelated-account denial. Only then enable the public release. Provider acceptance alone does not prove inbox delivery. No production enablement or new real applicant email was performed in this implementation turn.

## Verification

- 41 service/API/auth regression tests pass, including a complete HTTP route flow against synthetic Google responses and an isolated Redis mock; email recipients are verified independently.
- Live Redis verification using three unique synthetic keys passed: mixed persistent/expiring atomic write, TTL, all-or-nothing conflict, and exactly one winning concurrent claim. All three test keys were deleted and absence read back; no customer records were read or changed.
- 9 DOM tests pass, including sharing cross/check, changed-link invalidation, stale-response rejection, activation failures, password recovery, existing calendar conflict handling and import retries.
- Production webpack build including TypeScript passes. ESLint has zero errors and two unchanged calendar warnings.
- Six service scenarios include 5 source rows → 3 valid imports + 2 blocked → correct the 2 rows → 5 total orders, without duplicating the original 3. A villa total stays 12,000 across 2 rooms and its received source total stays 4,000. Empty financial fields remain null.
- Recovery invalidates old sessions and previously issued links. Activation cannot be replayed with only the token after it is consumed; lost responses require the chosen password.
- Previous real Sheet and live intake tests on 2026-10-02 demonstrated native Sheet contents and operator notification; they did not validate this new reader, applicant receipt, activation or website import end-to-end.
- Browser visual verification is pending because the computer-use browser service was unavailable. DOM assertions and builds are not a substitute for that check.

Remaining: dedicated Google reader setup, candidate deployment, actual mail and Google integration test, browser verification, and final production release. Do not report the entire customer journey as shipped until these pass.
