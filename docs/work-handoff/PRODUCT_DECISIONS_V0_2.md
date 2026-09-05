# Agent-First Hospitality Operations — Product Decisions v0.2 Digest

> **Source:** owner-approved product exploration and decision record dated 2026-09-04, version v0.2, plus explicitly approved additions from the following implementation discussion on 2026-09-05.  
> **Purpose:** preserve decisions and terminology in an AI-readable form; this is not a substitute for the full 44-page source document.

## Executive baseline

The product is for 3–30-room guesthouses and small hotels. It uses month/week/day booking and finance interfaces for human inspection, while an AI Agent is the principal operating entry point for availability, pricing, booking changes, payments, reconciliation, and cross-system work.

The system is intentionally Agent-First:

- Agent understands intent and owns Mission planning and Tool order.
- Deterministic Tools own authoritative data access, matching, validation, calculation, writes, and external synchronization.
- Persistent Mission state is required for scheduling, incidents, interruption, owner questions, and recovery.
- Important writes use `check -> update -> check`.
- A final authoritative query, not the update response alone, determines success.

## Problem definition

### Fragmented order and inventory sources

OTA orders are commonly managed through Owlnest, while phone, LINE, Instagram, website, and other direct bookings require manual entry and manual inventory closure. Google Sheet currently serves as the internal final operating record.

### Stay date is not receipt date

A day’s bank receipts may contain:

- today’s balance payments
- future deposits
- OTA payouts for earlier stays
- additions such as late checkout, breakfast, or pets
- refunds
- unidentified transfers

Therefore, the system must distinguish stay dates from receipt dates and must represent multiple payment transactions rather than a single paid/unpaid flag.

### Existing tools require repetitive cross-checking

Operators currently inspect and update spreadsheets, channel-manager screens, booking platforms, and messaging systems. The product should turn an owner’s goal into a traceable Mission that reliably coordinates those systems.

## Product scope

### First version includes

- month/week/day occupancy and booking views
- complete booking detail and modification surfaces
- order totals, multiple payments, refunds, additions, receivables, and actual receipts
- availability and pricing queries
- direct-booking creation and channel-manager inventory closure
- scheduled morning reports and actionable exceptions
- persistent Mission list and audit
- AI direct-modification toggle with risk rules

### First version deliberately excludes

- complete accounting, tax, and statutory reporting
- large-hotel inventory pools and complex group contracts
- unlimited parallel write execution
- hundreds of field-level Tools
- a separate Preview Tool chain
- arbitrary Agent writes to cells/database fields
- authoritative availability or finance calculated by the language model
- immediate replacement of the current Google Sheet before validation

## Price semantics

A room/date can have multiple valid prices. The system must distinguish:

1. standard/base selling price
2. channel selling price
3. recommended direct-booking price

When the owner does not specify a channel, the Agent answers primarily with the recommended direct-booking price and may add channel context when useful.

## Agent-Tool responsibility boundary

### Agent responsibilities

- understand the owner’s real goal
- create/update/select a Mission
- load the relevant Playbook and current context
- choose Tools and sequence
- construct Tool inputs from the owner’s language
- compare Tool output with the original instruction and prior state
- continue, retry, replan, ask, block, or create a child Mission
- perform final re-query verification
- summarize the result for the owner

### Agent prohibitions

- no direct database-field or Sheet-cell manipulation
- no arbitrary browser primitives as the business abstraction
- no choosing one official booking from multiple active candidates
- no authoritative availability, pricing, or financial calculation from memory
- no bypassing Tool validation
- no declaring success solely because a write call returned success
- no relying on model memory as persistent Mission state

### Tool responsibilities

- query real data
- perform unique matching
- distinguish zero/one/many/integrity-conflict outcomes
- apply deterministic hospitality rules
- calculate balances, statuses, and availability
- execute writes and external synchronization
- prevent duplicate side effects
- enforce expected versions
- return stable statuses and errors
- preserve Tool execution and change audit

## Context and Playbooks

A Tool description alone is insufficient because a Tool can be correct but called at the wrong time. Each Agent run should load at least:

- current property and timezone
- current user identity and permissions
- AI direct-modification setting
- current Mission and original goal
- completed Steps and latest Tool output
- Tool catalog and schemas
- relevant Workflow Playbook
- dependencies, waiting state, and scheduled work summary
- data version/freshness
- confirmation and risk rules

The Agent should receive a structured working context, not the complete historical chat log.

## Initial business Tools

### `check_order`

Purpose: return an authoritative order snapshot and perform matching/integrity checks.

Expected statuses:

- `unique_match`
- `not_found`
- `needs_more_criteria`
- `data_integrity_conflict`
- `source_unavailable`

An overlapping active-order condition is an integrity conflict, not an ordinary list of candidates.

### `update_order`

Purpose: perform a controlled business operation against a previously resolved order.

Suggested operations:

- `record_payment`
- `update_guest_info`
- `add_note`
- `change_stay_dates`
- `change_room`
- `change_total_amount`
- `cancel_order`
- `record_refund`

It should require the official order ID, expected version, idempotency key, and an operation-specific payload rather than an unrestricted patch.

Expected statuses include:

- `success`
- `validation_error`
- `version_conflict`
- `duplicate_operation`
- `permission_denied`
- `external_sync_failed`
- `partial_success`

### `create_order`

Purpose: create a direct/non-OTA order. It must re-check availability at write time and reject overlapping active orders even if an earlier availability query succeeded.

### `check_availability`

Purpose: return authoritative sellable dates and continuous availability ranges, accounting for active orders, holds, manual blocks, maintenance, out-of-sale periods, and external-sync state.

### `get_price`

Purpose: return standard, recommended-direct, and channel prices together with conditions such as occupancy, plan, or restrictions.

### `update_inventory`

Purpose: open/close/update channel-manager inventory using internal room/date semantics. Its external result must be verified.

### `check_finance`

Purpose: answer formal order-receivable and receipt-date questions, including deposits, balances, unpaid arrivals, and payout matching.

### Supporting Tools

Likely supporting capabilities include `check_sync_status` and `check_order_history`; names may change, but their responsibility boundaries should remain stable.

## Mission model

A Mission is an owner-understandable goal with a completion condition. A Step is one Tool call.

Examples of Missions:

- record a guest’s deposit
- investigate a duplicated active booking
- create a direct booking and close OTA inventory
- generate the morning report
- list available dates and direct prices

Suggested minimum fields:

- `mission_id`
- `property_id`
- `goal`
- `source`
- `priority_class`
- `status`
- `parent_mission_id`
- `blocked_by`
- `scheduled_at`
- `current_step`
- `completed_steps`
- `waiting_for`
- `revalidation_required`
- `created_at`
- `updated_at`

Suggested backend states:

- `queued`
- `running`
- `paused`
- `blocked`
- `waiting_user`
- `waiting_external`
- `completed`
- `failed`
- `canceled`

The UI may simplify these into working, waiting for you, next, completed, and needs attention.

## Mission creation and blocking

Create a child Mission when a new problem:

- differs from the original goal
- needs multiple Tools to investigate
- must be solved before safe continuation
- may require a new owner decision
- may wait for external data and later resume

A Tool retry or input-format correction is not a new Mission.

If an order check discovers overlapping active orders:

1. stop the original write
2. block the original Mission
3. create a safety/blocking investigation Mission
4. inspect complete order records, history, source status, mappings, and external state
5. resolve from evidence or ask the owner with the evidence already gathered
6. complete the investigation
7. re-query before resuming the original Mission

## Scheduling and priority

First version has three priority classes:

1. safety/blocking
2. owner real-time
3. routine scheduled

One property has one actual Tool execution stream. A higher-priority Mission may take over only when the running Tool returns.

A 09:00 report is a soft schedule: the Scheduler enqueues it at 09:00. It does not interrupt an owner’s running real-time Tool at 09:00:00.

When a Mission enters `waiting_user`, only dependent Missions remain blocked; independent work continues.

## Golden workflows

### Record a deposit/payment

```text
create payment Mission
  -> check_order
  -> require unique_match
  -> validate stay/room/guest/order/amount context
  -> apply toggle/risk confirmation rule
  -> update_order(record_payment)
  -> check_order(order_id)
  -> compare paid/balance/status with original instruction
  -> complete and report
```

### Availability and direct price

```text
create read Mission
  -> parse room/date/nights/occupancy/channel
  -> check_availability
  -> get_price when asked
  -> verify each price is attached to the correct available date
  -> summarize continuous periods
```

### Create a direct order

```text
check_availability
  -> create_order
  -> record deposit when supplied
  -> update_inventory in Owlnest
  -> check_order
  -> check_sync_status and/or check_availability
```

Internal success plus external closure failure is `partial_success`, with an explicit oversell risk and a repair Mission.

### Morning report

- enqueue at 09:00
- wait behind safety/blocking and owner real-time work
- yield at a Tool boundary if a higher-priority Mission arrives
- re-fetch stale inputs on resume
- identify unresolved incidents and avoid presenting affected values as confirmed totals

## Direct modification and risk

The AI direct-modification toggle changes whether confirmation is required; it never disables:

- unique matching
- conflict checking
- amount/status validation
- idempotency
- version checks
- final verification
- audit

Candidate high-risk actions that still require confirmation even when the toggle is on:

- cancellation
- payment deletion
- refunds
- date/room changes with material price or inventory effects
- changes to checked-in or closed-order amounts
- bulk inventory changes
- overriding manually locked prices

The exact risk matrix remains to be frozen.

## Data-model baseline

### Order

Internal/external IDs, source, status, guest, stay dates, room/room type, occupancy, total, expected deposit, received/balance summary, version, timestamps.

### Payment

Payment ID, Order ID, amount/currency, type, method, actual receipt date, reconciliation state, source, and audit. Multiple Payment records are first-class; totals are derived or transactionally maintained.

### Inventory / Room Assignment

Room, date range, status such as order/hold/maintenance/manual block, source, and external-sync state.

### Rate

Room/date, base price, recommended-direct price, channel prices, conditions, and freshness.

### Mission and Tool Execution

Goal/state/dependencies/progress plus Tool name/version, Step ID, input/output summaries, execution status, idempotency key, external result, and before/after versions.

## Original v0.2 decision register

| ID | Decision | Status |
|---|---|---|
| D-001 | First version serves approximately 3–30-room guesthouses/small hotels and a small number of properties. | Confirmed |
| D-002 | First-version finance is booking receipts and reconciliation; complete finance later uses existing Sheet work. | Confirmed |
| D-003 | Google Sheet is currently the final internal SSOT. | Confirmed |
| D-004 | Owlnest is an OTA booking/inventory source. | Confirmed |
| D-005 | Non-OTA orders enter the internal formal record and close Owlnest inventory. | Confirmed |
| D-006 | Product is Agent-First; reliable Tools precede chat appearance. | Confirmed |
| D-007 | Agent owns intent, Mission, Tool planning/order, I/O checking, and replanning. | Confirmed |
| D-008 | Tools own search, unique matching, integrity, validation, modification, and formal calculation. | Confirmed |
| D-009 | Agent continuously receives Workflow Playbook context, not only Tool descriptions. | Confirmed |
| D-010 | Important changes follow query, update, re-query verification. | Confirmed |
| D-011 | No separate Preview Tool in first version. | Confirmed |
| D-012 | AI direct-modification toggle exists but cannot disable business/final validation. | Confirmed |
| D-013 | Unspecified-channel price questions default to recommended direct price. | Confirmed |
| D-014 | A second overlapping active order should fail at creation time. | Confirmed |
| D-015 | If overlapping active orders exist, treat as integrity incident; Agent cannot choose. | Confirmed |
| D-016 | Persistent Mission List / Mission Manager is required. | Confirmed |
| D-017 | An investigation may create a blocking child Mission ahead of the original Mission. | Confirmed |
| D-018 | The original Mission re-queries before resuming after child resolution. | Current design conclusion |
| D-019 | One Tool/Mission execution flow per property in first version. | Current design conclusion |
| D-020 | Three priorities: safety/blocking, owner real-time, routine scheduled. | Current design conclusion |
| D-021 | 09:00 morning report is a soft schedule/enqueue time. | Current design conclusion |
| D-022 | Mission switching occurs only at Tool boundaries. | Current design conclusion |
| D-023 | Waiting for owner input blocks only related Missions. | Current design conclusion |
| D-024 | Schedule, state, and dependencies are stored by a deterministic Mission Manager. | Current design conclusion |
| D-025 | Successful payment changes update calendar, order, and financial views together. | Confirmed |

## Additions approved after v0.2

| ID | Decision | Status |
|---|---|---|
| D-026 | Use email or phone as account identity. | Confirmed |
| D-027 | Owner assigns Admin, Housekeeper, Viewer, or Viewer-without-price roles; Owner is separately protected. | Confirmed |
| D-028 | Access can be limited to selected properties. | Confirmed |
| D-029 | Multi-night stays must be visibly continuous in month/week/day views. | Confirmed |
| D-030 | Extra guest, extra bed, pet, and baby supplies are structured fields; a note stores residual detail. | Confirmed |
| D-031 | Price-hidden users must not receive monetary/payment values from the backend. | Current implementation/security conclusion |

## Unresolved decisions carried forward

- exact current Sheet schema, formulas, sync, and recovery procedures
- availability of an Owlnest API and browser-automation fallback
- timing/method for product database becoming SSOT
- first-version support for multi-room, room moves, and partial cancellation
- separation of guest payment from OTA payout
- supported real-world payment methods and imported bank/payout files
- recommended-direct pricing formula and manual override rules
- final month/week/day timeline UX
- mandatory-confirmation risk matrix
- morning-report content and freshness SLA
- retry/notification behavior for long external outages
- multi-operator version-conflict UX
- integration of later full-finance Sheets
