# Calendar onboarding — implementation and review, 2026-10-04

The owner's follow-up requested implementation of Google Calendar, iOS and Android onboarding and backend, followed by review and repair of critical issues. This note supersedes the original planning-only status. Code lives in draft PR #26 on `codex/customer-onboarding`; public activation remains separate.

## Implemented behavior

- `/join` accepts Google Calendar, iPhone/iPad Calendar and Android Calendar in addition to the existing Sheet path. Calendar applications need no Sheet URL or sharing check. Verified email activation creates a calendar workspace and routes to its import wizard. Existing Sheet validation is preserved.
- The calendar wizard identifies the backing account. All three choices can use a readable Google account or upload ICS/ZIP. Non-Google calendars need an exported file. Instructions distinguish Mac iCloud export from iPhone-only usage and do not assume every Android app has an export command.
- Owners and scoped administrators select calendars, a period and property timezone; map calendars or explicit title room labels to rooms; choose full-stay versus arrival-reminder semantics; and review grouped bookings, blocks and exceptions. Individual corrections can supply dates, room sets, guest labels, group IDs, totals or exclusions with reasons. Names alone never merge orders.
- Whole-day event ends remain exclusive. In-progress stays are included. Recurrent instance identity, exceptions, UTC/floating/IANA/custom timezone behavior and malformed dates are checked before availability can become complete. Complex local recurrence is held for correction or Google expansion.
- A batch atomically saves orders/blocks, source references, coverage and audit data, followed by authoritative readback. The same preview and command can be retried after a lost response without duplicate records. Source changes after a Google preview and concurrent workspace edits require a fresh preview.
- Revised uploads and API reads match stable source/UID/instance references. File-to-Google relinking is supported for one calendar at a time, with reviewed matching and persisted replacement references. Ambiguous grouping or other-binding copies remain unresolved.
- Missing financial values remain unknown. One multi-room order has one total and one source-paid summary. A source-paid summary is not an actual dated receipt. Source changes preserve accepted financial terms and recorded payments; cancellations retain occupancy until explicit review and settlement checks.
- Blocks participate in calendar rendering, availability and every booking conflict check. Coverage has an exclusive end. Pending exceptions, lost authorization and connected sources older than ten minutes prevent confirmed availability. Connected-mode occupancy is edited in Google; receipts stay in the application.
- Guarded undo cancels only unchanged new records from that batch. It preserves edited/paid records, audit and source identity, and restores incomplete readiness. A still-present source cannot silently recreate an undone order.
- Standard workbook schema v2 adds calendar provenance and inventory-block tabs to the original six. Verified v1 destinations upgrade atomically on the next sync. Missing v2 tabs are conflicts, not permission to recreate erased data. These extensions do not manufacture Sheet row provenance or payment transactions.

## Google backend and scheduled work

The connector requests only `calendar.calendarlist.readonly` and `calendar.events.readonly`. It uses one-use OAuth state, a same-site HTTP-only nonce cookie and PKCE; the signed-in actor, workspace and property are checked both before and after consent. The source Google account can differ from the customer login email. Refresh credentials are encrypted with AES-256-GCM and bound to their storage context. Raw tokens never enter client responses or audit messages.

Selected-calendar reads enforce pagination, event/response/time limits and complete reads. Commit rechecks a Google preview against a new source snapshot. Property-scoped disconnect removes stored grants atomically, stops its sync and marks coverage unverified while preserving orders and receipts. It does not revoke the provider-wide Google grant for unrelated properties.

Connected bindings and their durable job registration are written in one transaction. The protected five-minute cron uses persisted due times, leases and three workers with a request deadline; interruption is recoverable after lease expiry. Successful polling can add new bookings and update unambiguous occupancy when financial evidence is unchanged. Cancellations, financial differences and changed activities with manual overrides remain pending. No two-way calendar writes, refunds or guest messages are sent.

## Configuration and activation

File import uses the existing enabled customer workspace, authentication and durable store. Google direct connection additionally requires server-only settings:

| Setting | Purpose |
| --- | --- |
| `CUSTOMER_CALENDAR_CLIENT_ID` | Web OAuth client with Calendar API enabled |
| `CUSTOMER_CALENDAR_CLIENT_SECRET` | Protected OAuth secret |
| `CUSTOMER_CALENDAR_REDIRECT_URI` | Exact `https://<customer-origin>/api/customer-calendar/callback`, also registered in Google |
| `CUSTOMER_CALENDAR_TOKEN_KEY` | Independently generated 32-byte base64 AES key; retain it to read stored grants |
| `CUSTOMER_CALENDAR_SYNC_ENABLED=true` | Opt-in to continuous mode, after deployment acceptance |
| `CRON_SECRET` | Existing protected cron authentication; required for continuous mode |

Without OAuth configuration the wizard states that direct connection is unavailable and offers the working file path. Without sync configuration it offers one-time import only. Do not reuse Sheet grants or broaden original source permissions. No new Google credential or real account consent was configured in this task.

Live acceptance must verify real consent/return, reading a selected shared calendar, token refresh, disconnect/reconnect and at least two scheduled cycles in an approved environment. Confirm original-source mutations are impossible, stale coverage is blocked, cancellations remain pending and accepted receipts stay unchanged. Real-device file selection and OAuth return remain unverified.

## Review findings and repairs

| Risk found in review | Repair and evidence |
| --- | --- |
| Existing Next.js dependency contained critical security advisories | Updated Next.js and its ESLint config to 16.3.8. Nodemailer was also patched to 10.0.14. Production audit now reports zero critical findings. |
| ICS libraries can normalize an invalid date or spend excessive work on unsupported recurrence | Validate original date values and recurrence limits, bound upload/expansion/depth, quarantine unsupported series even when the master begins outside the requested period. Tests include February 30, invalid UNTIL, unrelated recurrence exceptions, unsafe rules and ambiguous/nonexistent DST times. |
| A repeated import, changed grouping or file/API switch could duplicate an order | Bind snapshots/previews to actor/workspace/property, persist instance identities, reject ambiguous matches, update references during reviewed relinking and enforce atomic version checks/idempotency. |
| A source amount, cancellation or grouped event could corrupt accepted receipts | Separate source-paid evidence from receipts; preserve financial fields on source refresh; block cancellation without zero confirmed receipts; retain pending differences and occupancy. |
| Incomplete reads, omitted ongoing stays or stale background work could look like availability | Fail incomplete reads, include ongoing stays, require confirmed coverage, track unresolved bindings and disable availability after source failure or ten-minute staleness. |
| File rules and OAuth reconnection could lose corrections or reuse the wrong actor's grant | Preserve applicable mapping overrides; quarantine changed manually corrected events; bind Google credentials to the granting actor and property; test reconnect/disconnect and scope denial. |
| Old standard-workbook destinations lacked calendar provenance/block tabs | Verify old schema/hash before an atomic v1-to-v2 extension; allocate unused sheet IDs; reject missing v2 tabs. Tested with synthetic Google responses. |
| Lost commit responses could allow a changed retry payload | Lock the pending command in the UI and retry the same payload; verify real service state under a simulated lost response, then guarded undo. |

No unresolved critical finding remains in the reviewed change. This is a scoped self-review, not a claim that every dependency or external integration is risk-free. The production dependency audit retains 5 high and 4 moderate findings in existing transitive/editor/export packages (`@tiptap/core`, `brace-expansion`, `minimatch`, `linkify-it`, `ws`, `baseline-browser-mapping`, `markdown-it`, `uuid` and `exceljs`). Broad unrelated package upgrades and the suggested ExcelJS major downgrade were not applied.

## Verification and concrete limits

The CI command set now includes the calendar parser/import/Google/routes/UI and standard-workbook tests. The service/API/auth command set passes 111 tests and the DOM set passes 17 tests: 128 checks in total, including 119 customer-flow checks and 9 legacy authorization/session checks. These include the existing Sheet, tenant, payment, session and legacy authorization regressions. Test provider responses, accounts and stores are synthetic; no real applicant or guest email was sent in this implementation task.

The production webpack build and TypeScript pass. Lint has zero errors and seven warnings (existing unused props and navigation warnings from the newer Next.js rule set). Local default Turbopack hit a sandbox port-binding restriction; the webpack build completed. Browser visual acceptance is not claimed because the existing computer-use restriction remains unresolved.

Input bounds: 3 MiB upload, 8 MiB decompressed ZIP content, up to 30 selected calendars and 2,000 expanded events, at most 731 days per source snapshot. Uploaded/staged data and previews expire after one hour. Oversized or unsupported inputs fail or remain unresolved; they never produce a falsely complete calendar.

Implemented choices differ from some original design suggestions: the intake chooses one primary source; properties can then review additional calendar bindings. Coverage confirmation states that the complete period and relevant sources have been included. Preview is an order/block list with stay details; the workspace calendar shows the saved result. Color-based room rules and a pre-import month-grid preview are not included.

This is a web onboarding and import implementation. Direct iCloud/CalDAV access, Apple EventKit, Android Calendar Provider and reading phone-local data require native/provider adapters and are not implemented. iOS/Android backed by Google use the Google connector; other supported exports use the same verified ICS backend. The two previously created live native Google workbook examples were not changed by these tests.

Deployment and final commit evidence is recorded below after the protected candidate is ready. No primary-domain promotion is authorized by this implementation request.
