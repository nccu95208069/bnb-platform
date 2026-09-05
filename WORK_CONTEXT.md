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
