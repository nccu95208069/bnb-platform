# BnB SaaS / Sweetfun OS — Authoritative Work Context

> **Status:** current project handoff baseline  
> **Updated:** 2026-09-05  
> **Primary track:** Agent-First booking, occupancy, payment, reconciliation, and hospitality operations  
> **Repository:** `nccu95208069/bnb-platform`

This document is the top-level context for ongoing work. It supersedes older top-level positioning when there is a conflict, while preserving the earlier LINE Reply Copilot work as a separate subsystem.

## 1. Product definition

Build an operations system for approximately 3–30-room guesthouses, small hotels, and a small number of properties. The owner should be able to use natural language and visual month/week/day interfaces to:

- inspect occupancy and multi-night stays
- find authoritative availability and prices
- create, modify, and cancel bookings
- record deposits, balances, additions, and refunds
- reconcile actual receipts against orders
- synchronize non-OTA bookings with the channel manager
- see scheduled work, incidents, and blocked work through persistent Missions

This is not merely a traditional PMS with a chat widget. The intended architecture is:

```text
Owner intent / scheduled event
  -> persistent Mission
  -> Agent loads current context + Playbook
  -> deterministic business Tool calls
  -> connectors to SSOT / Owlnest / payment sources
  -> verification
  -> concise owner-facing result
```

Visual interfaces provide observability and manual control. The Agent is the high-frequency operating entry point.

## 2. Current product tracks

### Active primary track

Agent-First booking and finance operations:

- booking/occupancy calendar
- payment and reconciliation
- availability and pricing
- workspace permissions
- structured stay requirements
- Mission Manager, Scheduler, Playbooks, Tools, audit, and recovery

### Preserved subsystem

The earlier LINE Reply Copilot remains useful for a future or parallel messaging subsystem:

- conversation ingestion
- identity/reservation resolution
- structured knowledge
- reply routing
- human-approved suggested replies

Its documents remain under `AI_CONTEXT.md` and `docs/ai-context/`. They are not the current top-level implementation priority.

## 3. Source precedence

When documents or code disagree:

1. latest explicit owner decision
2. this file
3. `docs/work-handoff/PRODUCT_DECISIONS_V0_2.md`
4. `docs/work-handoff/IMPLEMENTATION_STATUS_2026-09-05.md` for shipped reality
5. current code, migrations, tests, and merged PRs
6. older Reply Copilot context
7. legacy README/code comments

Product intent and shipped state must not be conflated. A feature can be approved but not implemented, or prototyped without being production-ready.

## 4. Confirmed product decisions

### Market and scope

- First version targets small hospitality operators with about 3–30 rooms.
- Support a single property or a small number of properties.
- Full accounting and tax are not first-version goals.
- Initial finance scope is order revenue, payments, refunds, fees/payouts, receivables, and reconciliation.

### Current systems of record

- Google Sheet is currently the internal final operational source of truth.
- Owlnest is an important OTA/channel-management source and inventory execution endpoint.
- OTA bookings typically flow through Owlnest into the internal operating records.
- Phone, LINE, Instagram, website, and other direct bookings must be written to the internal final record and must close the corresponding channel-manager inventory.
- The timing and method for moving the final SSOT to the product database remain an explicit future decision.

### Price semantics

The system must distinguish:

1. standard/base price
2. channel-specific selling price
3. recommended direct-booking price

When the owner asks for a price without naming a channel, the Agent should primarily answer with the recommended direct-booking price.

### Calendar and booking interaction

- Provide month, week, and day views.
- Show property, room, guest, check-in/check-out, channel, payment state, and warnings.
- Clicking a booking opens complete details and permitted actions.
- A multi-night stay must visibly read as one continuing stay rather than unrelated nightly rows.

### Workspace access

The system now distinguishes a non-assignable Owner role and four assignable roles:

- **Owner:** full control, including member management and property scope assignment
- **Admin:** booking/payment/cancellation operations, but no member management
- **Housekeeper:** operational booking/stay-requirement updates and permitted payment recording; no cancellation or member management
- **Viewer:** read-only with prices
- **Viewer without price:** read-only, with monetary and payment values excluded

An account may use email or phone identity. Access may cover all properties or a selected property subset. Price hiding must be enforced server-side, not only by visual masking.

### Structured stay requirements

These are first-class fields, not only free-text notes:

- extra guest count
- extra bed count
- pet count
- baby-supply selections
- service note for residual details

Structured fields are required so the system can later search, generate housekeeping tasks, and produce morning reports.

## 5. Agent, Tool, and Mission boundaries

### Agent responsibilities

The Agent:

- understands the owner’s actual goal
- creates or updates a Mission
- chooses Tools and order using the relevant Playbook
- converts natural language into Tool input
- checks Tool input and output against the original instruction
- decides whether to continue, retry, ask, create a child Mission, or stop
- performs final verification
- explains the result to the owner

The Agent must not directly manipulate database columns, Sheet cells, or arbitrary browser UI primitives. It must not calculate authoritative availability, prices, or finance from memory. It must not choose one active booking from ambiguous matches.

### Tool responsibilities

Tools:

- query authoritative data
- perform unique matching and integrity checks
- apply deterministic hospitality rules
- calculate formal balances, availability, and state
- write data and synchronize external systems
- prevent duplicate effects through idempotency
- enforce expected versions
- return stable structured statuses/errors
- preserve audit evidence

### Mission Manager responsibilities

Mission state must be persisted outside model memory. The Mission Manager:

- stores the Mission list, status, dependencies, and completed steps
- selects the next executable Mission
- pauses, resumes, blocks, cancels, and completes work
- avoids concurrent conflicting writes
- restores work after interruption

### Scheduler responsibilities

The Scheduler creates Missions at specified times. A 09:00 morning report is a soft schedule: it enters the queue at 09:00 but does not forcibly interrupt a running Tool.

## 6. Execution invariants

### Golden write pattern

```text
check authoritative state
  -> perform controlled update
  -> re-check authoritative state
```

A write Tool returning `success` does not complete the Mission. Completion requires the final query to match the original owner instruction.

### Ambiguity and integrity incidents

- `unique_match` may proceed.
- `not_found` or `needs_more_criteria` requires the smallest necessary clarification.
- overlapping active orders for the same room/stay period are a `data_integrity_conflict`, not a normal multi-result choice.
- The Agent must pause the original Mission and create a blocking investigation Mission.
- After the incident is resolved, the original Mission must re-query and replan before continuing.

### Concurrency and priority

First version:

- one actual Tool execution stream per property
- switch Missions only after the current Tool completes
- priority order: safety/blocking > owner real-time > routine scheduled
- FIFO within a class unless the owner explicitly promotes independent work
- a Mission waiting for owner input blocks only its dependents

### Reliability controls

Every important write should support:

- `idempotency_key`
- expected version / version conflict
- before/after state or equivalent audit evidence
- partial-success representation
- explicit external-sync result
- final verification result

## 7. Golden workflows

### Record a payment

```text
check_order
  -> validate unique match and amount context
  -> confirm when required by risk/toggle
  -> update_order(record_payment)
  -> check_order(order_id)
```

### Check availability and price

```text
check_availability
  -> get_price
  -> verify date/price mapping
  -> summarize continuous available periods
```

The Agent must not infer authoritative availability by subtracting raw bookings or apply price formulas independently.

### Create a direct booking and close OTA inventory

```text
check_availability
  -> create_order
  -> update_order(record_payment), when applicable
  -> update_inventory in Owlnest
  -> check_order
  -> check_sync_status and/or check_availability
```

If the internal booking succeeds but external inventory closure fails, return partial success and create a repair Mission. Do not claim the workflow is complete.

### Investigate an overlapping-order incident

```text
pause original Mission
  -> create blocking child Mission
  -> inspect order details/history/source/external state/mapping
  -> fix or obtain owner decision
  -> complete investigation
  -> revalidate original Mission
  -> continue or stop
```

### Scheduled morning report

- Scheduler enqueues the Mission at 09:00.
- Owner real-time work remains ahead of the routine report.
- A running report yields only at a Tool boundary.
- On resume, potentially stale data is re-fetched.
- Unresolved incidents are shown as exceptions and excluded from confirmed totals where necessary.

## 8. Current implementation snapshot

As of 2026-09-05, the repository contains a deployed anonymized prototype with:

- month/week/day booking calendar
- multi-night stay coalescing and progress display
- desktop week spanning bars
- booking details/edit UI
- role-aware UI actions
- email/password activation flow
- phone OTP UI flow
- workspace-member schema and RPCs
- per-property access scope
- price-hidden role with backend/API redaction logic
- structured extra-guest, extra-bed, pet, baby-supply, and service-note fields
- RLS and workspace-access hardening
- passing frontend and backend CI

The public deployment is deliberately demo/anonymized. Its interactive edits are not proof of production persistence. Real booking data must not be exposed until the complete production authorization, tenant/property filtering, write APIs, and legacy-table RLS review are finished.

See `docs/work-handoff/IMPLEMENTATION_STATUS_2026-09-05.md` for exact status and gaps.

## 9. Important gaps

Approved architecture is ahead of implementation. The following are not yet complete production capabilities:

- persistent Mission Manager and Scheduler
- formal Tool contracts and Tool execution store
- production `check_order`, `update_order`, `create_order`, `check_availability`, `get_price`, `update_inventory`, and finance workflows
- Owlnest connector and verified inventory close/open flow
- production write-through to the current SSOT
- robust payments ledger and reconciliation model
- complete booking/property/tenant server-side filtering across legacy tables
- configured and tested SMS provider
- end-to-end invitation delivery/activation UX
- final owner-approved high-risk confirmation matrix
- final migration plan from Sheet SSOT to product database

Do not treat the current calendar prototype as completion of the Agent-First system.

## 10. Immediate work order

On 2026-09-05 the owner authorized an isolated payment implementation while the
production Sheet payment table and stable order IDs remain unconfirmed. The
resulting backend slice is documented in `docs/work-handoff/PAYMENT_WORKFLOW.md`.
It does not satisfy the production source-verification gate or change the SSOT;
the ordered work below still governs production integration.

1. Verify and document current data sources, Sheet schema, formulas, sync directions, and manual recovery procedures.
2. Freeze the first Tool contracts: `check_order` and controlled `update_order(record_payment)`.
3. Implement the payment Golden Workflow with Mission persistence, idempotency, versioning, audit, and final verification.
4. Implement authoritative availability and recommended-direct-price workflow.
5. Implement direct booking plus Owlnest inventory closure with partial-success repair.
6. Implement the minimum Mission Manager and 09:00 soft-scheduled morning report.
7. Connect UI surfaces to real production-persisted operations only after authorization and isolation tests pass.

Detailed acceptance criteria are in `docs/work-handoff/NEXT_WORK.md`.

## 11. Privacy and repository boundary

The public repository may contain public-safe specs and anonymized sample data only. Keep outside the public repository:

- real guest names, phones, emails, chat exports, and identifiable booking rows
- OTA screenshots with guest/order data
- entrance, room, keybox, Wi-Fi, bank, or payment credentials
- service-account JSON, API keys, JWT secrets, tokens, passwords
- raw bank or platform payout exports

Private evidence may be used inside an approved private Project/Work task, but should be minimized and never copied into public commits, logs, examples, or test fixtures.


## 12. Isolated calendar/payment integration (2026-09-05)

At the owner's request, the local calendar now reads the isolated payment orders and
ledger, opens persistent payment Missions in the existing order detail panel, and
links to a shared human/Agent Mission center. The API exposes original structured
intent and parent/child links; humans can confirm, resume, clarify, or withdraw an
unwritten intent. Recorded receipts require verification and cannot be withdrawn.
The local proxy is disabled in production execution mode. This is an integrated
synthetic preview, not approval of a database SSOT migration or production writes.
See `docs/work-handoff/AGENT_PAYMENT_PLAYBOOK.md`.

## 13. Unsold calendar and versioned synthetic rates (2026-09-05)

The owner requested unsold month/week/day views next to the existing sold calendar,
with human and Agent access to the same contracts. Latest owner steering explicitly
uses fake data without live pricing integration. Rates should be modeled as changing
in cycles roughly every 3–5 days over at least 90 future days, separately for each
room/date/channel. Two synthetic cycles demonstrate this; they are not T-39 forecasts.
The shared availability, nightly quote, pricing preview, and persistent handoff
contracts are documented in `docs/work-handoff/UNSOLD_CALENDAR_DESIGN.md`.
There is no rate publishing, pricing Agent connection, or production source change.

Owner follow-up: unsold overflow must expand inline like sold; Back/Forward must
restore meaningful calendar views and detail overlays. This is now handled by
calendar URL/history synchronization. The owner also requested testing from a
phone on a different network. An authenticated temporary HTTPS preview forwards
only the existing synthetic local app; production deployment and GitHub push
remain separate. See the unsold design document for the exact boundary and tests.

2026-09-06 owner simplification: hide the demo price-cycle selector, stay quote,
and pricing review/handoff UI until requested again. Display flags live in
`frontend/src/lib/availability-features.ts`; preserve backend contracts and stored
Missions. Availability, rates, inline expansion and browser navigation stay active.


## Owner clarification — 2026-09-06, Sheet source pilot

- J is the stable row identity for every row, regardless of AI/manual/LINE origin. L is an optional OwlNest parent order ID; N is the OTA confirmation ID scoped by platform. Missing L is allowed and does not invalidate the row. Never infer a cross-row stay from J or guest name.
- `done` means the guest paid in full. OTA collection and property bank settlement have no explicit records yet; separate fields/ledger are a future task.
- Even allocation of order prices across room-nights is confirmed current upstream behavior; original nightly price preservation is a TODO.
- Telephone/LINE orders, cancellations, date changes and room changes are fully updated in the Sweetfun operational Sheet.
- Owner prefers event-driven synchronization of Sheet additions, deletions and corrections. Feasible design is Drive change notification plus authenticated re-read, atomic validated snapshot publication, subscription renewal and periodic reconciliation; this is not yet enabled.
- LINE AI Agent rows follow the same J/L/N rules; no further AI-specific identity question is pending.


## Historical exceptions and synchronization reliability — owner follow-up

The owner explicitly defers the already-listed source problems. The current known conflict fingerprints are acknowledged as historical exceptions; stop prompting for cleanup and do not let that cleanup block further integration. New or materially changed conflicts remain detectable. Acknowledgement follows exact records, not mutable row numbers, and ends once an issue disappears from an imported snapshot. It never proves disputed room allocation or money correct.

The owner questioned relying on Google notifications. Google Drive watch is real but opt-in, expiring, and carries no sheet contents. Proposed first implementation: periodic authenticated source reconciliation (for example every minute) as the reliability baseline, with upstream batch-complete notification as an accelerator; Drive push is optional. This periodic baseline is now enabled as documented below; Google push remains optional and no latency SLA is approved.

## Rolling synchronization scope — 2026-09-06

The owner requests comparing check-ins from 30 calendar days before today onward, with no future upper bound, using Asia/Taipei dates. On 2026-09-06 the inclusive cutoff is 2026-08-07. Also include earlier check-ins that have not checked out. This is the implemented synchronization scope, not a calendar browsing limit or permission to delete historical data. Preserve out-of-scope records and their unresolved historical acknowledgements. A tracked row missing from the filtered result must be checked by source-scoped J identity before interpreting it as deletion: it may have moved outside the window. Retire issue acknowledgements only after verified resolution, not merely aging out. See the source pilot document for reconciliation safeguards. Automatic reconciliation is now enabled for both registered properties; see below.

## Sheet monitor production activation — 2026-09-06

Owner explicitly authorized the existing ingestion service-account credential for OFFLAND, approved Vercel, and accepted the Upstash integration terms. Both Sweetfun and OFFLAND are now deployed at https://sweetfun-os.vercel.app/calendar with separate one-minute Vercel schedules and source-scoped private Redis state. Cloud write/read verification and actual scheduled checks after the final manual bootstrap passed for both properties. The public projection remains anonymous/read-only; no Google writes, live pricing, payment ledger, or full Mission Manager integration is implied.

The deterministic connector provides scoped reconciliation, two-observation confirmation, compressed Redis state, expiring fenced locks, verified atomic publication, protected operator/cron/status routes, bounded audit and per-property sync health/browser refresh. Upstash free storage is production-only with automatic upgrades and eviction disabled. Details, source mappings, limitations and rollback are in `docs/work-handoff/SHEET_MONITOR.md`.

## OFFLAND source — 2026-09-06

Verified spreadsheet `1jBJq1xWmM7xKpUxFjsLYQc7EbLAWmcMjQK0SBbaORuc`, tab `工作表1`, gid `475170922`, Asia/Taipei. Both OFFLAND room labels map to one physical villa. J is row identity; O is the optional OwlNest parent order ID despite its misleading live header `刷卡狀態`, as verified against the upstream writer. L is total guest count, not an order ID or extra guest count. Missing payment state remains unknown.

Initial OFFLAND import: 239 room-night rows, 235 accepted, four quarantined across three blocked dates. Rows 223/224 repeat a J identity; rows 183/236 overlap the villa on 2026-12-25. These are new source issues, not automatically acknowledged historical Sweetfun exceptions. Names, original IDs, notes and contacts are excluded from the public calendar. Source identities, locks, failures and acknowledgement scopes are isolated across properties; the UI supports both property filters and independent failure notices.

## Calendar follow-up — continuous month stays and guest names

Owner requests continuous month-view bars and guest names. The month layout now places one stay across its occupied dates within a week, with continuation markers across week boundaries and whole-lane overflow expansion. Guest labels remain in booking details using the existing anonymous projection; the compact month overview now prioritizes room and channel. Real names remain pending authenticated audience/login setup: the public calendar API currently needs no login, and production auth provider settings are placeholders. A question about owner-only versus authorized-colleague access is pending. Preserve this unfinished request; do not treat the visual fix as completion of real name support. See the Sheet monitor follow-up for the implementation boundary.

## Compact month overview — 2026-09-06

Owner compared the mobile calendar with Google Calendar and requested more visible information without crowding. Sold month view now uses compact single-line channel-colored bars (room + short channel), showing at least six lanes by default (up to eight when more rooms are selected). Continuous stays and whole-week overflow expansion remain. Repeated property dots are removed from month bars; full property/channel/anonymous guest/stay data stays in accessible labels and details. Sync information is collapsed into a one-line disclosure, with failure state and new issue warnings still visible. Responsive lane height uses CSS so hydration does not change month geometry; the visible month follows the largest visible month area. This is a presentation change, not authorization to expose real names or change source/booking semantics.

## Platform-first labels — 2026-09-06

Latest owner request: prioritize booking platform, then the real guest name rather than an order-derived alias. Month labels now order platform → explicitly real guest name (when available from an authorized projection) → room → night count. Anonymous order-derived names are omitted from month text and accessible labels. `guest_name_kind` explicitly distinguishes real/anonymous/missing names; the existing public Sheet adapter marks its generated names anonymous. The private-source monitor currently discards names before storage, so the real-name request is still unfinished pending production access scope/login and a protected source projection. Do not flip this marker on anonymous aliases or expose source names through the public endpoint.

2026-09-06 follow-up: the same platform → real name (only explicitly authorized projection) → room order now applies to mobile week cards, desktop week stay bars, day arrivals/staying/departures cards and day room-status summaries. Shared booking identity rendering prevents views diverging; anonymous aliases are excluded from these overview labels. Existing multi-night spans, payment indicators and click-through behavior remain.

## Owner-private guest names and consistent colors — 2026-09-06

The owner reiterated that real names and identical platform colors must work across month/week/day. All three views and their legend now use `PLATFORM_STYLES` (the saturated month palette); stay badges use translucent white with inherited text. Authenticated month bars use two compact lines, platform/room then the source name, to keep names readable on phones.

A minimal owner-only, read-only private view is implemented at `/calendar-access`, separate from unfinished Supabase/team access. A generated 192-bit private entry code is checked against a server-only SHA-256 digest; successful same-origin login receives a 12-hour HttpOnly/SameSite Strict signed cookie (Secure on HTTPS). Session signatures bind the configured code digest so code or signing-key rotation revokes prior sessions. No team invitations, shared-role management, SMS, payment writes or full production authorization rollout is implied. The private entry code is delivered only to the owner and is not committed.

The calendar API verifies the cookie before reading original names from each registered Sheet, and returns private/no-store responses. It joins only unambiguous source-scoped row identities whose published room/date/order/platform/amount still match the current source. Deleted, moved, disputed or mismatched rows receive no guessed name. Names remain excluded from anonymous monitor state, public snapshots and source control. The original source may itself contain masked names or booking notes in the name field; do not invent a legal name. Conflicting names across merged stay segments are withheld pending verification.

Unauthenticated responses remain anonymous; a visible login status and logout control explain why names are hidden. Local HTTP verification confirms both properties' names, wrong-code and cross-origin rejection, and anonymous responses after logout. Unit/source/layout checks: 44 passed. The earlier audience question is addressed conservatively with owner-only access; colleague access is still unimplemented.

**Production activation boundary:** local name/login/read/logout and cross-view color checks passed. Automatic approval review rejected adding `CALENDAR_OWNER_CODE_HASH` and `CALENDAR_OWNER_SESSION_SECRET` to Vercel production because exact settings, recipient and sensitive-data scope needed explicit owner authorization. A concrete approval question is pending. Do not retry setting production keys without that approval; do not claim production names work. Code is fail-closed when either setting is absent, so color/presentation fixes can ship independently while the public response remains anonymous.

## Owner approval of private production login — 2026-09-06

Owner explicitly confirmed the private-login authorization after the concrete scope was presented: configure `CALENDAR_OWNER_CODE_HASH` and `CALENDAR_OWNER_SESSION_SECRET` on the existing Sweetfun Vercel production project, deliver the private entry code only to the owner, and permit read-only guest-name access for Sweetfun and OFFLAND with 12-hour sessions. This resolves the prior production-key approval block. Activation and production verification follow under this authorization; it does not authorize publishing guest names without login or extending access to colleagues.

**Activated and verified:** both server-only production settings were accepted following the explicit owner approval. Deployment `sweetfun-1p3sac9ag-sweetfuns-projects.vercel.app` is aliased to `sweetfun-os.vercel.app`. Production HTTP checks passed for anonymous access, wrong-code rejection, cross-origin rejection, authenticated names for both properties (September check: Sweetfun 118 / OFFLAND 25 row records), and anonymous responses after logout. Production browser login through the fragment entry link passed; day names and 118 two-line month labels were verified at phone size. The private entry credential is delivered only in the owner's conversation, not in git or documentation. This supersedes the earlier activation-block status.

## Owner-selected private password — 2026-09-06

Owner asked to choose a private password. `/calendar-password`, linked from the private calendar banner, now supports initial setup from an authenticated owner session and subsequent changes requiring the current password. Minimum length is 12 characters (maximum 128), with confirmation; spaces/passphrases are preserved. Passwords use salted scrypt (N=32768,r=8,p=1), never plaintext or fast SHA hashes. Existing generated-code access is preserved until the owner chooses a password.

Owner credentials now live in the existing private Redis service at `sweetfun-os:owner-auth:v1:credential`. Deployment initialization uses SET NX with the existing generated-code hash, without choosing a password or changing access scope. Missing/corrupt/unavailable credential state fails closed; never automatically restore a bootstrap code after a password has been set. Password changes use atomic compare-and-set and authoritative re-read before returning a newly signed session. Sessions bind the credential revision; changes revoke old codes and other sessions while retaining the changing browser's new session. Existing bootstrap sessions retain their original binding during migration. Login/change attempts are limited to 20 per 15 minutes for this single owner.

The browser flow and HTTP checks passed in a separate temporary Redis namespace: setup, verified persistence, new password login, old code/session rejection, current-password requirement, and cross-origin rejection. The owner's production password is not set during verification. Historical deployment URLs require Vercel login. The temporary owner login remains separate from employee/Supabase accounts.

**Password setting shipped:** production deployment `sweetfun-ft1kwgdiy-sweetfuns-projects.vercel.app` is aliased to the existing calendar. Initial credential SET NX and authoritative re-read succeeded using the existing owner code hash; no chosen password was set. Production browser verification confirms the existing owner session still works, `/calendar-password` displays the initial new/confirm fields, and private calendar names and the change-password link still work. Temporary test credential/attempt keys were deleted.
