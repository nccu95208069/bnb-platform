# Next Work — Ordered Milestones and Acceptance Criteria

The next phase should implement the Agent-First backend rather than expand the prototype UI.

## Milestone 0 — Verify the current truth

### Goal

Create a verified inventory of the real operating systems and data semantics before adding production writes.

### Work

- map every current Google Sheet column, formula, validation, and derived report
- document which system creates each field and which direction it syncs
- document Owlnest booking/inventory behavior and manual recovery steps
- distinguish production/private data from anonymized seed data
- identify one stable internal `property_id`, `room_id`, `order_id`, and row/version strategy
- confirm payment methods and how deposits, balances, additions, refunds, and OTA payouts are currently recorded
- record known bad-data patterns and actual operator recovery behavior

### Acceptance criteria

- one approved data dictionary
- one approved source-of-truth/sync diagram
- no unidentified write direction for the first payment workflow
- no production credential or PII committed to the public repository
- open questions are explicit, not hidden behind assumptions

## Milestone 1 — Freeze `check_order`

### Goal

Provide one authoritative order-resolution Tool that the Agent can trust.

### Contract requirements

Input may use:

- formal `order_id`, or
- bounded query criteria such as stay date, room, guest, external order number

Output statuses:

- `unique_match`
- `not_found`
- `needs_more_criteria`
- `data_integrity_conflict`
- `source_unavailable`

A unique order snapshot should include at least:

- internal/external IDs
- property/room
- guest display identity
- check-in/check-out
- source and order state
- total/expected deposit
- payment transaction summary
- received/balance/payment state
- version
- source freshness and synchronization warnings

### Acceptance criteria

- Agent cannot bypass unique matching
- overlapping active orders return an integrity conflict
- canceled/invalid records are handled deterministically
- same input produces a stable structured result
- tenant/property authorization is enforced server-side
- tests cover zero, one, many, overlap, canceled, stale source, and unauthorized access

## Milestone 2 — Payment ledger and controlled `update_order(record_payment)`

### Goal

Replace the prototype payment-state patch with a formal transaction model.

### Data work

Create a first-class Payment entity with:

- `payment_id`
- `tenant_id`
- `property_id`
- `order_id`
- amount/currency
- payment type
- method
- actual receipt timestamp/date
- reconciliation state
- source/operator/Mission/Step
- idempotency key
- timestamps
- reversal/refund relationship where needed

### Tool input

- official order ID
- expected version
- idempotency key
- amount/currency
- payment type/method
- received time
- optional note/source evidence

### Tool behavior

- validate role and property scope
- validate order state and amount
- detect duplicate operation
- enforce expected version
- write Payment transaction atomically
- recalculate received/balance/payment state
- append audit
- return new version and summary

### Acceptance criteria

- retry with the same idempotency key never creates a second payment
- stale expected version returns `version_conflict`
- unauthorized roles receive no mutation
- no-price role receives no monetary output
- payment/order summaries remain transactionally consistent
- audit links the owner instruction, Mission, Step, Tool, and final state

## Milestone 3 — Payment Golden Workflow and persistent Mission

### Goal

Complete one end-to-end Agent workflow: “the guest paid a deposit.”

### Work

- persist Mission and Step state
- load payment Playbook
- call `check_order`
- handle clarification/integrity statuses
- apply AI direct-modification/risk confirmation rule
- call controlled payment update
- call `check_order(order_id)` again
- compare final state with original instruction
- complete only after verification
- expose concise progress and outcome in UI

### Acceptance criteria

Test at least:

- normal unique order
- missing criteria
- not found
- unexpected amount
- duplicate payment retry
- concurrent version change
- permission denial
- Mission interruption at a Tool boundary
- overlap incident creates a blocking child Mission
- resumed Mission re-queries rather than using a stale snapshot
- final verification mismatch prevents completion

## Milestone 4 — Availability and recommended-direct pricing

### Goal

Answer authoritative availability/price questions without model calculation.

### Work

- define sellable inventory semantics
- account for orders, holds, manual blocks, maintenance, and external freshness
- implement `check_availability`
- define base/channel/recommended-direct rates
- implement `get_price`
- map conditions such as occupancy, minimum stay, and plan
- return continuous available periods and warnings

### Acceptance criteria

- checkout day is handled correctly
- model never calculates official availability from raw bookings
- price is bound to the correct room/date/conditions
- stale or uncertain external state is explicitly labeled
- no-price role cannot retrieve monetary values
- tests cover continuous periods, split availability, hold/block, maintenance, stale sync, and channel variation

## Milestone 5 — Direct booking plus Owlnest inventory closure

### Goal

Create a non-OTA booking safely and close external inventory.

### Work

- re-check availability at create time
- implement `create_order`
- optionally record supplied deposit
- implement Owlnest connector or approved browser-automation fallback
- implement `update_inventory`
- verify external state
- implement partial-success and repair Mission

### Acceptance criteria

- overlapping active order is rejected transactionally
- internal order and payment are idempotent
- external closure result is persisted
- internal success/external failure is `partial_success`, never full success
- repair retries do not duplicate the order/payment
- oversell risk is visible to the owner
- final verification includes both internal order and external inventory state

## Milestone 6 — Minimum Mission Manager and Scheduler

### Goal

Support real interruption, blocking, waiting, and scheduled work.

### Required state

- queued
- running
- paused
- blocked
- waiting_user
- waiting_external
- completed
- failed
- canceled

### Required behavior

- one Tool execution stream per property
- three priority classes
- switch only at Tool boundary
- dependency/blocking relationship
- revalidation flag on resume
- owner answer resolves only the related waiting Mission
- 09:00 morning-report Mission is enqueued as a soft schedule

### Acceptance criteria

- process restart does not lose Mission state
- waiting_user does not block unrelated work
- safety Mission preempts at the next Tool boundary
- scheduled report waits behind owner real-time work
- resumed report re-fetches stale inputs
- audit explains why every Mission changed state

## Milestone 7 — Morning report

### Goal

Produce a concise, actionable daily report based on verified Tools.

### Candidate content to validate with the owner

- today’s arrivals/departures/staying guests
- unpaid or partially paid near-term arrivals
- room/service preparation requirements
- payment receipts needing reconciliation
- external inventory sync failures
- active data-integrity incidents
- only the top actionable exceptions, not a dense dashboard export

### Acceptance criteria

- report data has an explicit cutoff/freshness time
- unresolved incidents are isolated from confirmed totals
- structured extra guest/bed/pet/baby-supply fields drive preparation items
- report can pause/resume under scheduler rules
- final report is stored and auditable

## Production-readiness gate before real guest data

Do not switch the public application from anonymized demo mode until all items below pass:

- every read is tenant/property scoped server-side
- every mutation has server-side role enforcement
- booking/payment/mission/audit tables have reviewed RLS/grants
- no-price responses are redacted before leaving the server
- production secrets are stored only in approved secret managers
- logs and errors are PII-safe
- invitation/auth flows are end-to-end tested
- SMS provider is configured only if phone login is actually launched
- backups and rollback paths are documented
- private spreadsheets/screenshots are excluded from public commits and fixtures

## Avoid during the next phase

- rebuilding the calendar from scratch
- adding more dashboard metrics before the payment workflow is real
- letting the Agent manipulate arbitrary fields
- combining search and update into one opaque Tool
- treating UI success toasts as authoritative completion
- implementing broad parallel Mission execution
- migrating SSOT before the first workflows are validated
- reviving the superseded PR #9 branch
