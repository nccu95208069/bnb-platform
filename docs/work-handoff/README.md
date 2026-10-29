# Work Handoff Index — 2026-09-05

2026-10-29 Offland LINE booking: [provider-free create, amendment and cancellation with dedicated proof routing, exact-grant activation and recovery](OFFLAND_LINE_BOOKING_2026-10-29.md). Isolated implementation candidate; no production credential or activation has been issued.

2026-10-29 Offland retained orders: [same-order retention, pending list, rescheduling, source protection and recovery](OFFLAND_RETAINED_ORDERS_2026-10-29.md). Implementation candidate under isolated verification; not deployed.

2026-10-28 Offland finance: [OS and same-LINE-OA property-scoped candidate, validation and independent rollout conditions](OFFLAND_FINANCE_PARITY_2026-10-28.md). General income and expenses share the ledger; imported booking receipt coverage remains a separate unresolved contract. Not deployed.

2026-10-28 finance SSOT W7: [offline integrated checkpoint and remaining Sweetfun cutover gates](FINANCE_SSOT_W7_OFFLINE_CHECKPOINT_2026-10-28.md). Native/Card, OS and separate LINE historical candidates are local and disabled; no real source import or cutover has occurred.

2026-10-28 W7 native/Card finance history: [source-specific, offline historical import candidate and per-record reconciliation](FINANCE_SSOT_W7_NATIVE_CARD_HISTORY_2026-10-28.md). Synthetic PostgreSQL checks pass; live W0 ownership and cross-source proof remain required before any cutover.

2026-10-28 Sweetfun OS finance SSOT candidate: [read-only preview, explicit confirmation, exact command recovery, and local build limits](FINANCE_SSOT_OS_PREVIEW_2026-10-28.md). This work has no production finance write or release claim.

2026-10-27 owner decision: [independent LINE provider room controls](LINE_INDEPENDENT_CHANNEL_2026-10-27.md) separate OwlNest commands from OS occupancy and booking synchronization. Implementation and synthetic wire acceptance are complete; not deployed. Existing uncertain provider claims remain protected.

- [LINE confirmation immediately executes its room action](LINE_IMMEDIATE_CHANNEL_2026-10-25.md) — paired GCO result-reply change; 304 tests pass, nine database tests skipped; not deployed.

- [LINE manual-closure registration and risk warning](LINE_CLOSED_ROOM_WARNING_2026-10-25.md) — implementation verified; rollout pending.

2026-10-25 水芳整筆訂單編輯：[原生 LINE、舊 LINE 匯入與 OS 訂單的完整欄位、多段住宿、每晚房價、收款對應與房況同步](SWEETFUN_FULL_BOOKING_EDIT_2026-10-25.md)。業主指定舊 LINE 訂單一併開放，現已正式發布。舊 LINE 表單及原生 LINE／OS 資料回讀、390／360 像素手機版與 CI 通過；正式訂單及收款紀錄未被驗收修改。

- [水芳新增訂單表單與自動確認（2026-10-25）](SWEETFUN_BOOKING_FORM_2026-10-25.md)

2026-10-25 水芳新直訂財務：[帳本核對、收退款單一來源、首頁淨額、同鍵恢復與正式發布回讀](SWEETFUN_DIRECT_FINANCE_2026-10-25.md)。業主授權發布已完成，兩項正式開關啟用；原 12 筆帳本不變，未新增測試款項，保留 Offland 更新。兩張新憑證至 11 月 22 日 08:37（台灣時間）。

2026-10-24 已售月曆捲動修復：[正式資料的單月讀取、相鄰月份預載與手機跨月滑動](IRON_GATE_CALENDAR_LOAD_FIX_2026-10-22.md#follow-up-restore-continuous-sold-month-scrolling--2026-10-24)。

2026-10-24 Sean 每日訂單儀表板：[水芳首次新單通知日、14 筆補登、OFFLAND 回讀與正式對帳](SEAN_DAILY_DASHBOARD_2026-10-24.md)。業主已選定新單通知日，後端／前端／受控補登已發布；version 59 缺每日統計日期 0 筆，原 OTA 下訂日保留未知。包含比較期間、正式版本及憑證輪替交接。

2026-10-20 資料責任對齊：[Sean Sweetfun OS、BnB SaaS OS 與 Iron Gate 的三個角色、目前 Sheet 匯入落點與目標權威](SEAN_SAAS_IRON_GATE_DATA_BOUNDARY_2026-10-20.md)。目前客戶工作區測試仍在 Sweetfun OS 網站內，確認匯入寫入 OS 工作區；Iron Gate 尚未接管真實訂單。

2026-10-24 Sweetfun 手動訂單：[實作、正式發布、單房晚真實驗收與來源／財務限制](SWEETFUN_MANUAL_BOOKING_IMPLEMENTATION_2026-10-24.md)。水芳 Owner／Admin／God 直訂入口已上線；2027-03-20 水芳 101 的 OwlNest 關房、回讀、取消與原狀復原已完成受控驗收。

2026-10-16 onboarding and standard-workbook release: [3,000-row import, customer password and sharing-guide improvements](ONBOARDING_CLARITY_2026-10-16.md#production-release--2026-10-16) and [v5 booking last-updated time](STANDARD_SHEET_V5_UPDATED_AT_2026-10-16.md#發布與資料邊界) are live on `https://sweetfun-os.vercel.app` from `c4ac224` / Vercel `dpl_4EEqMUY4hPNm3oXN1yzU5zt6Ha6d`.

2026-10-15 website flow repair: [503 root cause, current Studio booking dependencies, isolated end-to-end verification, deployment evidence and pending authenticated live acceptance](WEBSITE_BOOKING_FLOW_2026-10-15.md).

2026-10-14 settings and calendar follow-up: [grouped Sweetfun OS settings, browser-persisted appearance, Auto and loose-to-compact month-week sizing, two-line booking cards when space allows, compact unsold availability controls, dark-mode contrast correction, validation, and production release evidence](SETTINGS_APPEARANCE_2026-10-14.md). The latest unsold contrast revision is live on the primary domain as `dpl_HBSeHvEVGsqo83x2A3RPZFzmmQ3c`, based on the existing production source without the separate OS beta integration branch.
2026-10-11 OS-04: owner-approved OS and LINE rollout is complete. Sweetfun and OFFLAND reminders are enabled for Taipei 09:00, with separately labeled unconfirmed room-night summaries. The new scheduler returned HTTP 200; one authorized synthetic LINE message has a persisted provider receipt and was visibly received in LINE desktop. First automatic arrival-note dispatch is due October 12 and has not yet been observed; physical-phone and external-customer acceptance remain open. See [release evidence](OS_READINESS_2026-10-10.md#正式-line-啟用--2026-10-11).

2026-10-10 OS readiness: [unified workspace entry, onboarding repairs, daily observation verification and scoped arrival reminders](OS_READINESS_2026-10-10.md). Engineering and isolated acceptance are complete; the owner requested continuation and the UI is now deployed, with production source verification and a partial-source repair recorded in the report. Daily production observation is verified for both properties on October 8–10. LINE dispatch, external-customer acceptance and physical-device checks remain separate.

2026-10-08 calendar incident remediation: [phased snapshot fallback, per-property isolation, fault tests and health history](CALENDAR_RESILIENCE_2026-10-08.md). Phase 1 runtime `7464b51` is live; cloud build, authenticated two-property browser readback and calendar request logs pass. Phase 2 runtime `4546190` is live: full private snapshot history, encrypted independent backup and background refresh pass cloud build, authenticated browser readback and two-store production verification (both replicas captured at 00:55 Asia/Taipei; anonymous access 403). WEB-04 acceptance has been resumed by its human owner in the website chat.

2026-10-07 WEB-04 follow-up: [same-order amendments, formal change/cancel notifications, current guest summaries and immutable accepted terms](WEBSITE_BOOKING_API_2026-10-07.md#web-04-lifecycle-completion-follow-up-2026-10-07). Engineering, isolated verification and the OS/guest-site/private-builder releases are complete. OS runtime `8b9a267` is live on the primary domain and its actual notification cron returned 200 at 21:47:16 Asia/Taipei. Owner approval/pairing and real recipient delivery still need human acceptance; WEB-04 remains in acceptance.

2026-10-07 native website integration: [owner-approved calendar/room binding, shared booking and notifications, scoped LINE commands, and release evidence](WEBSITE_BOOKING_API_2026-10-07.md). Code and isolated verification now implement INT-01 and the OS side of native INT-02. Production activation, real provider delivery, and legacy Sheet/OwlNest acceptance remain separate release gates. This supersedes the earlier statement that all website wiring is still unimplemented.

2026-10-07 OS-owned hold/pricing implementation: [native hold lifecycle, pricing decisions, review and integration boundaries](OS_HOLDS_PRICING_2026-10-07.md). OS-10/11 code and isolated verification are complete; this is not a production release. Native holds default off and all website/LINE/legacy-Sheet/OwlNest/pricing-producer wiring remains INT-01–04.

2026-10-05 legacy Sweetfun payment update: [one receipt entry point and verified main-Sheet writeback](OS_PAYMENT_MAIN_SHEET_2026-10-05.md) implements status-only paid confirmation, received amount/method/account, and resumable synchronization. The explicit owner writeback request supersedes the prior OS-only boundary for the Sweetfun H payment cell and its note. It preserves the already-live booking momentum source `6179335`; implementation and local verification are complete; GitHub push / production publication require the explicit authorization requested in this chat after automatic approval review rejected the push.

2026-10-05 order finder: [owner-authorized production release and verification](ORDER_FINDER_2026-10-05.md#owner-authorized-production-release) adds protected order search, monthly occupancy, complete details, receipt accounts, editable notes/shared tags, persistent source issues and workbook v3. The primary site now serves `9dc8978`, preserving already-live analytics; 194 local checks and the cloud build pass. Basic authenticated browser reads pass; the full owner walkthrough remains pending. PR #26 stays draft and unmerged.

2026-10-04 owner pilot release: [primary-domain promotion, persistent settings, delivered email/save/undo and two automatic cron deliveries](CALENDAR_LIVE_ACCEPTANCE_2026-10-04.md#primary-domain-owner-pilot). Ready for the authorized owner to import their own data at `https://sweetfun-os.vercel.app/join`. Google remains in Testing; real-phone and broader multi-account acceptance remain pending. This supersedes the earlier no-promotion/sync-off state below.

2026-10-04 Google acceptance preparation: [verified missing settings, fixed callback/email origin, offline checker and live test procedure](CALENDAR_GOOGLE_SETUP_2026-10-04.md). The setup-stage missing-settings report is historical; the live report records subsequent configuration and the later owner-authorized production pilot.

2026-10-04 live calendar acceptance: [real Google consent/refresh/reconnect, email-link return, ICS/ZIP, persisted synthetic data and worker verification](CALENDAR_LIVE_ACCEPTANCE_2026-10-04.md). The later pilot section records primary promotion and actual scheduled delivery; physical-device acceptance remains open.

2026-10-04 latest calendar flow: [preview before signup, Google identity and email-link login, repeated review and verification](CALENDAR_PREVIEW_FIRST_2026-10-04.md). Calendar import no longer requires setting a password or completing the contact form first.

2026-10-04 calendar implementation: [three onboarding options, backend, self-review and activation boundaries](CALENDAR_ONBOARDING_2026-10-04.md). Includes ICS/ZIP import for Google/iOS/Android, Google read-only OAuth, durable polling, freshness guards, source conflicts, unknown financials and standard-workbook v2 extensions. Google credentials and desktop OAuth acceptance are now verified in the linked live report; actual mobile acceptance remains pending. The [original plan](GOOGLE_CALENDAR_FAST_ONBOARD_2026-10-03.md) is retained as design history; [Next Work](NEXT_WORK.md#calendar-onboarding-implementation-and-acceptance) distinguishes implemented code from live acceptance.

2026-10-03 latest Sheet decision: [standard workbook and conversion rules](STANDARD_SHEET_2026-10-03.md). Source creator/user identity matching is removed. Grouped stays, nightly rows and explicit calendar-grid groups now produce one order ledger, with separate room-night details and source-paid summaries. A native blank template and synthetic example have been created and verified through the production Google gateway; public rollout remains separate.

2026-10-03 customer update: [multiple properties, collaborators, unsold lists, pricing and order receipts](CUSTOMER_OPERATIONS_2026-10-03.md). Includes the format-assistance decision, coverage safeguards, role matrix, 54 service/API/auth and 15 DOM checks, and remaining acceptance boundaries. The protected customer candidate is separate from the primary production site.

2026-09-14 production update: [OwlNest price refresh and calendar position repair](CALENDAR_PRICE_REFRESH_2026-09-14.md), deployed with verified live price snapshot refresh; signed-in owner acceptance remains.

2026-09-06 follow-up: [Sheet monitor implementation and activation status](SHEET_MONITOR.md). Sweetfun and OFFLAND now have verified one-minute production schedules; the public calendar remains anonymous and read-only.

This folder organizes the product decisions, shipped implementation, unresolved work, and transition instructions needed to continue in ChatGPT Work or a coding agent.

## Read in this order

1. [`../../AGENTS.md`](../../AGENTS.md) — operating rules for AI agents
2. [`../../WORK_CONTEXT.md`](../../WORK_CONTEXT.md) — current top-level product and architecture context
3. [`PRODUCT_DECISIONS_V0_2.md`](PRODUCT_DECISIONS_V0_2.md) — detailed digest of the 2026-09-04 Agent-First product document
4. [`IMPLEMENTATION_STATUS_2026-09-05.md`](IMPLEMENTATION_STATUS_2026-09-05.md) — what is actually merged, deployed, and still demo-only
5. [`NEXT_WORK.md`](NEXT_WORK.md) — ordered milestones and acceptance criteria
6. [`START_IN_WORK.md`](START_IN_WORK.md) — copy/paste prompt for a new Work thread

## Source map

Current isolated payment work: [takeover check](TAKEOVER_CHECK_2026-09-05.md),
[payment contract and Playbook](PAYMENT_WORKFLOW.md), and
[source mapping with production prerequisites](PAYMENT_SOURCE_MAPPING.md).
The owner authorized isolated tests while the production Sheet payment structure
remains unconfirmed. These additions do not change the operational SSOT.

| Source | Role | Current status |
|---|---|---|
| `WORK_CONTEXT.md` | top-level canonical handoff | current |
| Agent-First product decision document v0.2, dated 2026-09-04 | full discussion, decisions, Tool/Mission design | canonical product source; stored in the current Chat/Project evidence set |
| `IMPLEMENTATION_STATUS_2026-09-05.md` | actual repository/deployment state | current |
| merged PR #8 | roles, calendar, multi-night, stay requirements | shipped prototype |
| merged PR #10 | workspace-access security hardening | shipped |
| current code and tests | implementation truth | authoritative for runtime behavior |
| `AI_CONTEXT.md` and `docs/ai-context/` | earlier LINE Reply Copilot subsystem | preserved; not current top-level product contract |
| legacy root README/comments | historical implementation | lowest precedence when inconsistent |

## Repository areas

| Path | Purpose |
|---|---|
| `frontend/` | Next.js calendar, booking interaction, access UI, and demo deployment |
| `services/api/` | FastAPI services, auth dependency, booking model/query/sync code |
| `supabase/migrations/` | workspace roles, RLS/RPCs, stay fields, and security hardening |
| `docs/ai-context/` | earlier messaging/reply-copilot subsystem specifications |
| `docs/work-handoff/` | current transition and implementation documents |

## Private/local evidence inventory

The transition bundle prepared from the current conversation contains these categories:

- the 44-page Agent-First decision document in editable DOCX form
- one canonical anonymized September Agent Backend seed workbook; a byte-identical duplicate was removed from the bundle
- the original Sweetfun 2025 calendar workbook, marked private because it may contain operational/guest data
- Sweetfun OS month/calendar screenshots
- booking detail and edit-modal screenshots
- an OFFLAND calendar screenshot used as a UI reference
- this handoff documentation and Work start prompt

Do not place the private workbook or any identifiable booking evidence in the public repository.

## Key distinction

The product specification and current implementation are not at the same stage:

- The product contract calls for persistent Missions, deterministic business Tools, Playbooks, scheduling, audit, idempotency, version control, final verification, and external synchronization.
- The shipped web application is an anonymized interaction prototype plus a workspace-access foundation.

The next Work thread should continue from this distinction rather than rebuilding the calendar UI or assuming the Agent backend already exists.


## Integrated calendar and shared human/Agent Missions (2026-09-05)

The isolated payment slice now connects the existing calendar's order detail panel
to a shared payment workspace and `/missions` center. Both use persistent Missions
and the same database ledger; the sandbox calendar does not apply browser demo edits.
See [AGENT_PAYMENT_PLAYBOOK.md](AGENT_PAYMENT_PLAYBOOK.md) for local startup,
human/Agent takeover contracts, recovery, and the explicit production boundary.

Verified locally: manual calendar payment; Agent API intent → human confirmation;
refresh and cross-page persistence; oversized-payment withdrawal without a receipt;
overlap → blocking child → reject premature resolution → source repair → human
resolution → resume original Mission → exactly one verified receipt. Desktop/mobile
flows and production proxy rejection (404 even with the flag enabled) were checked.
Backend: 202 passing tests including real PostgreSQL. Frontend lint: no errors,
one pre-existing week-carousel unused-import warning; TypeScript and build pass.
Natural-language model integration, background scheduling, production Sheet writes,
and production calendar authorization remain separate work.

## Unsold calendar and periodic rate changes (2026-09-05)

See [UNSOLD_CALENDAR_DESIGN.md](UNSOLD_CALENDAR_DESIGN.md) for the sold/unsold switch,
month/week/day views, two synthetic price cycles, nightly quotes, and shared
human/Agent pricing review Missions. Uses the same isolated PostgreSQL preview and
payment calendar. No live T-39 reads/writes or prediction claims are involved.

## 財務拆分 M1（2026-09-08）

- [詳細架構、階段與驗收](FINANCE_ARCHITECTURE_M1.md)
- [Code review 與驗證](M1_VERIFICATION.md)


## 2026-10-06 — Main Sheet notes in sold-order details

The owner requested the complete main-Sheet notes in the legacy sold-calendar detail and explicitly authorized publication. See [implementation and verification](BOOKING_SOURCE_NOTES_2026-10-06.md).

- [Calendar change intake and daily observation](CALENDAR_CHANGE_ENDPOINT_2026-10-07.md): receiver and daily observation live 2026-10-07 after owner approval; booking-assistant hooks deferred.

- [Studio ordinary-email signup and automatic new-property notifications](STUDIO_EMAIL_ONBOARDING_2026-10-15.md) — implementation verified; production acceptance status is recorded in the report.
# Latest: email cross-device sign-in

See [EMAIL_CROSS_DEVICE_2026-10-16.md](EMAIL_CROSS_DEVICE_2026-10-16.md) for the released cross-device verification, original-device continuation, and email-input copy changes. OS, Guest v21 and Studio v66 are live. A real Gmail plus-address link was verified in Safari and the original Chrome page automatically resumed into the same account. This supersedes the same-browser restriction for newly issued links. PR #42 remains draft and unmerged; physical-phone and other-provider inbox acceptance are not claimed.

The separate [legacy two-property calendar email recovery](LEGACY_CALENDAR_EMAIL_RECOVERY_2026-10-19.md) adds a one-time email reset link for active calendar members and the initial owner credential while retaining administrator-assisted recovery. The combined release and a new member email delivery are verified; the recipient's password change and fresh login remain to be confirmed.

[Legacy calendar copy controls](LEGACY_CALENDAR_COPY_2026-10-20.md) are live on Sean version: the booking detail can copy visible guest names, provided formal order numbers and the separately labeled system-internal ID without using it as a source-order fallback. The separate batch-review workflow remains outside this release.
