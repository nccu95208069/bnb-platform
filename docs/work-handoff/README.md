# Work Handoff Index — 2026-09-05

2026-10-08 calendar incident remediation: [phased snapshot fallback, per-property isolation, fault tests and health history](CALENDAR_RESILIENCE_2026-10-08.md). Phase 1 implementation and isolated verification are complete; staged deployment is pending. Full private snapshot history and independent backup remain the next phase. WEB-04 acceptance remains paused.

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
