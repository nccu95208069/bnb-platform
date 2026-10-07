# Order finder — implementation and verification, 2026-10-05

The owner-approved interface is implemented in the existing customer workspace on `codex/customer-onboarding`, for draft PR #26. This is a persisted customer feature, separate from the earlier synthetic HTML proposal. The later [owner-authorized release](#owner-authorized-production-release) below supersedes the initial pre-deployment and browser-blocked state.

## Operator flow

- `/w/[slug]/orders` searches normalized guest names, internal/source order IDs and permitted notes. Property, room, platform, status, missing booking date and four explicit date types are supported. Results sort by arrival ascending, 30 complete orders per page. Native GET forms preserve filters in the URL and avoid competing search requests. Errors, loading and empty results have distinct states.
- The calendar defaults to the current month, retains the existing week/create controls, and shows continuous room stays on desktop. Mobile date cells summarize room-night records and tags; a selected date lists rooms in room-number order. Month changes use a scoped six-week API window, cancel superseded reads and show a retryable error on failure. The existing week/create component still receives the authorized workspace snapshot for compatibility.
- Calendar/list links open `/w/[slug]/orders/[bookingId]`. This standalone detail has no adjacent monthly order list or search sidebar. It retains all stay segments, highlights the date/room of entry and returns to the original URL/anchor. Two rooms over two nights show one order, two accommodation nights and four room-nights. Checkout is exclusive. Known nightly source prices are expandable; missing prices remain unknown, without fabricated allocations.
- `＋已收款` opens the existing controlled receipt workflow. Payment categories, transfer/cash/card/platform methods, explicit Taipei time, optional property receipt account and payment notes are preserved. Cash needs no account. Owner/admin can create account labels with last four digits; receipts snapshot that identity and display it masked. This is the same customer ledger used by customer finance, not a second ledger or a write into the unrelated legacy property namespace.
- Notes support save/cancel. Tags use stable property-scoped IDs, shared names, one visible grapheme and six colors. Create/edit, assign/remove and calendar badges share those definitions. Existing receipt/travel/pet/baby/late defaults need no data migration. Duplicate abbreviations are rejected.

## Data and safety

`Booking.platform` and date-only `bookedAt` are distinct from `entry` and `createdAt`. Sheet mapping and the manual form accept them explicitly; missing dates remain null/absent. Booking-date provenance and Taipei timezone are recorded. Editing an unchanged date preserves its provenance. Explicit `姓名（需求：…）` / `姓名（備註：…）` suffixes move to notes during new Sheet normalization, with the full original label preserved. Ambiguous unlabelled names are not guessed or rewritten.

All new writes enforce role/property scope, expected workspace/order versions, request-key deduplication, atomic persistence, audit receipts and authoritative readback. Lost-response forms lock related actions and retry the exact command. Google source refresh preserves accepted notes, platform, booking date, tag assignments and financial records. Server redaction removes money, payment/account details, notes, contact, source financial evidence and nightly prices for the no-price role.

New `other` receipts use `allocation=extra`: they appear in cash transaction history and a separate extra-fee balance, without reducing room charges. Extra-fee refunds are separately bounded; cancellation requires settlement of both balances. Legacy payments without an allocation retain their original room-charge meaning. Unknown imported opening receipts still yield unknown room receipts/balance after a new payment. Platform/source cumulative payments never fabricate dated cash transactions.

Unresolved rows from newly confirmed Sheet/calendar imports persist as scoped `reviewRecords`, even after a temporary preview expires. The finder distinguishes these from saved orders and excludes them from order/money counts. Known saved-order missing names and room-night overlaps have separate warnings. Older imports that stored only an unresolved count keep their source-review entry point; detailed older rows require reading that source again. Pending-source rows deliberately do not apply date/platform filters whose values remain unresolved.

## Standard workbook v3

Append-only order columns add platform, booking date, notes, tag names and extra-fee net receipts. Payment columns add allocation, account label and masked account identifier. Existing column positions are retained. The reader recognizes intact v1/v2 headers, verifies their stored content hash, then upgrades atomically through the normal exporter. Missing extension tabs, unexpected values or manual edits still block overwrites. No existing live workbook or master template was changed during this implementation.

## Verification and remaining acceptance

- 142 service/API/auth/data checks pass, including a final fault-injection test that rejects a mismatched saved note on both initial response and retry.
- 26 DOM checks pass. These exercise save/cancel, shared tag edits/removal, exact retry after a committed-but-lost response, split receipts, account masking, cash, Taipei timestamps, month/day/room links, checkout exclusion, cancellation of superseded reads and retryable loading errors.
- Full frontend lint has zero errors. Changed components have no warnings; six warnings remain in unrelated pre-existing files.
- TypeScript and the local webpack production build pass. Default Turbopack compilation encountered a local `Operation not permitted` error when its CSS worker attempted to bind a port, including after an approved escalation. Webpack required approved network access to obtain the existing Google fonts.
- Browser acceptance is **not completed**: the browser tool refused the local synthetic page because the administrator-enforced security check was unavailable. No alternate browser/indirect workaround was used. Temporary local synthetic servers were stopped.
- No real guest data, bank details or credentials were added to fixtures or commits. No new production deployment or live customer-data mutation was performed.

The remaining full acceptance covers desktop and 360px mobile layouts, keyboard/return focus, calendar-to-detail navigation and the actual persistent receipt/note/tag workflow through an authorized browser. The earlier calendar pilot is recorded in `CALENDAR_LIVE_ACCEPTANCE_2026-10-04.md`; its prior acceptance does not constitute acceptance of this new interface.

## Owner-authorized production release

On October 5 (Taipei), the owner explicitly requested publication to the production website for their own walkthrough. This authorization supersedes the preceding pre-deployment boundary without claiming that the walkthrough is complete.

- Entry: `https://sweetfun-os.vercel.app/start`. Select a property, then **訂單查詢** or **房況日曆**. New applicants can still use `/join`.
- Runtime source: `9dc8978db0dec34955007feec13310a687f9a2c7`. Production deployment `dpl_GF1nYqzyYmxe8xUavTMs7zJEBQyj`, `https://sweetfun-ibvonnaxc-sweetfuns-projects.vercel.app`, is READY. The primary hostname was read back against this exact deployment. Cloud build completed in 18 seconds using Next.js 16.3.8, including TypeScript and the new order routes.
- Preflight found that production had moved to analytics source `9eea2f4` on `codex/order-health-page`. That already-live code was merged before deployment, preserving its analysis dashboard, assistant and background worker. The shared navigation keeps both order search and order health. A regression check found that “明年房晚會增加嗎” fell into historical trend handling; it now retains forecast intent and explicitly declines to predict final demand. The updated test verifies snapshot-only numbers and empty-period caveats, and the analytics suite is included in CI.
- Rollback target is the deployment that was live immediately before this release: `dpl_GbnEEnEXrEbgskSgFdXhA8z432hy`, `https://sweetfun-iq4650deb-sweetfuns-projects.vercel.app`. PR #26 remains draft; no PR merge was performed.
- All **194 local checks** pass: 142 customer service/API/auth/data, 26 customer DOM and 26 order-health checks. TypeScript and changed-file lint pass; full lint has zero errors and six existing warnings. Hosted GitHub CI remains separate from these checks and has been blocked by the account billing lock.
- All five existing schedules remain enabled and their project configuration points to the new deployment: customer calendars every five minutes; order health, manager, Sweetfun Sheet and OFFLAND Sheet every minute. This is schedule-binding readback, not a new claim of observed scheduled executions.
- Browser access recovered during this release. The existing authenticated, clearly labelled synthetic workspace showed the new month calendar and order search, retained search in the URL, rendered the empty result and cleared criteria successfully. A requested 360px override produced an actual 400px CSS viewport in this browser; measured document width was 383px with no horizontal overflow. The viewport override was reset. Exact 360px, nonempty complete-order navigation, persistent write flows and physical phones remain pending owner acceptance.
- Anonymous order-search, month-window, order-health and customer-calendar cron requests all returned 401. A bounded error-level log query for the new deployment returned no entries. No ongoing monitoring was created.
- Existing production settings were used without changing credentials, storage namespaces or source bindings. No guest records, notes, tags, payments or workbooks were written during these post-release checks.
