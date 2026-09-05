# Implementation Status — 2026-09-05

This document separates actual merged/deployed behavior from the larger Agent-First product specification.

## Isolated payment implementation update

The payment branch adds a persistent PostgreSQL ledger, Mission state, controlled
Tools and database-backed acceptance tests, gated off by default. This is an
isolated backend slice, not a production Sheet connector or calendar integration.
See [PAYMENT_WORKFLOW.md](PAYMENT_WORKFLOW.md). The original merged/deployed baseline
below remains historical; this update does not claim the new migration is deployed.

## Repository and deployment

- Repository: `nccu95208069/bnb-platform`
- Current public demo: `https://sweetfun-os.vercel.app`
- Calendar: `https://sweetfun-os.vercel.app/calendar`
- Access management: `https://sweetfun-os.vercel.app/access`
- Login: `https://sweetfun-os.vercel.app/admin/login`
- Public deployment mode: anonymized demo

The public deployment must remain disconnected from identifiable production guest data until the complete production authorization and isolation work is verified.

## Merged work

### PR #8 — workspace roles, multi-night stays, and guest requirements

Merged into `main` on 2026-09-05.

Delivered:

- email or phone account identity model
- protected Owner role
- Admin, Housekeeper, Viewer, and Viewer-without-price roles
- per-property scope assignment
- owner role preview
- role-aware edit/payment/cancellation/member-management UI
- backend/API price redaction for the no-price role
- consecutive nightly rows coalesced into one stay
- multi-night progress in month/day views
- one spanning reservation bar in desktop week view
- extra guest, extra bed, pet, baby supplies, and service note fields
- email/password activation and phone OTP UI flows
- Supabase workspace membership/RPC/RLS foundation

Validation completed at merge:

- frontend ESLint
- TypeScript and production build
- backend Ruff lint
- backend Ruff format check
- backend tests
- Vercel deployment

### PR #10 — workspace access hardening

Merged into `main` on 2026-09-05.

Delivered:

- pinned function `search_path`
- supporting foreign-key lookup indexes
- optimized RLS policies so `auth.uid()` is evaluated once per statement where applicable
- clean Supabase security-advisor result for the workspace-access changes

Validation completed:

- frontend CI passed
- backend CI passed
- Vercel deployment passed

### PR #9

Closed without merge because it was based on an older branch and duplicated/conflicted with the already-merged access foundation. Its useful follow-up ideas were superseded by the clean current-main work and should not be revived as a branch.

## Frontend state

### Calendar and booking views

Implemented:

- month, week, and day views
- property filtering
- booking search
- booking detail panel
- permitted booking edits
- permitted payment recording
- permitted cancellation
- overlap checks before date/room edits
- multi-night progress labels such as continuing-night position
- desktop week bars spanning the full stay
- separate arrival, staying, and departure views on a day

Important caveat:

- In the public demo, interactions persist only in the browser/local demo state.
- A successful visual edit in demo mode is not a production booking mutation.

### Access management

Implemented UI:

- add/edit a member
- email and/or phone identity input
- assign an allowed role
- all-property or selected-property access
- suspend/reactivate a member
- role preview for the Owner

Implemented role behavior:

| Role | Members | Booking edit | Payment record | Cancel | View price |
|---|---:|---:|---:|---:|---:|
| Owner | Yes | Yes | Yes | Yes | Yes |
| Admin | No | Yes | Yes | Yes | Yes |
| Housekeeper | No | Yes | Yes | No | Yes |
| Viewer | No | No | No | No | Yes |
| Viewer without price | No | No | No | No | No |

### Authentication

Implemented UI/client flow:

- email/password sign-in
- first-time email/password activation/sign-up
- phone OTP request and verification interface
- membership claim after authentication
- no-membership guard screen

Not yet production-complete:

- SMS delivery requires a configured provider and end-to-end verification.
- Email templates, redirect URLs, production SMTP behavior, and activation support flow require production QA.
- Invitation is currently a permission record/claim flow, not a complete outbound invitation-delivery service.

## Supabase/data state

### Source-controlled migrations

- `202609050001_workspace_access_core.sql`
  - role/status enums
  - workspace member table
  - per-property scope table
  - permission audit table
  - structured stay fields

- `202609050002_workspace_access_functions.sql`
  - role-permission mapping
  - membership claim/access context
  - member list/save/status functions
  - RLS and grants

- `202609050003_workspace_access_hardening.sql`
  - function search-path hardening
  - RLS optimization
  - lookup indexes

### Roles

Database enum values:

- `owner`
- `admin`
- `housekeeper`
- `viewer`
- `viewer_no_price`

Member statuses:

- `invited`
- `active`
- `suspended`

### Structured stay fields

Added to relevant stay/booking storage:

- `extra_guest_count`
- `extra_bed_count`
- `pet_count`
- `baby_supplies`
- `service_note`

## Backend/API state

Implemented foundation:

- Supabase JWT verification
- workspace membership lookup from the database
- active-role resolution
- property-scope context
- role helper for protected operations
- calendar response price redaction for `viewer_no_price`
- booking model fields for stay requirements

Still incomplete for the target product:

- the calendar query must be fully tenant/property-scoped in production, not merely filtered in the client
- production booking mutations are not yet the formal Agent Tools
- payment ledger and reconciliation are not yet modeled as the approved multi-transaction workflow
- current Sheet sync is not yet the complete SSOT-safe write-through architecture
- external Owlnest inventory synchronization is not implemented/verified
- Mission and Tool execution records do not yet drive backend operations

## Documentation state before this handoff

The repository’s previous `AI_CONTEXT.md` and `docs/ai-context/` describe the earlier LINE Reply Copilot direction. They remain useful, but can mislead a new agent because they identify that subsystem as the top-level product.

This handoff adds:

- `AGENTS.md`
- `WORK_CONTEXT.md`
- `docs/work-handoff/*`

New agents must start from those files and treat the Reply Copilot documents as subsystem context.

## Security boundary

### Safe and implemented

- workspace membership tables use RLS
- management writes occur through controlled security-definer RPCs
- Owner role is protected from ordinary reassignment/suspension
- no-price role has monetary-value redaction logic
- public deployment is anonymized

### Must be completed before real guest data is exposed

- comprehensive tenant/property filtering in every production data endpoint
- RLS and grants review for all legacy/public booking-related tables
- server-side enforcement for every booking/payment/write operation
- audit coverage for production mutations
- invitation/auth lifecycle QA
- secret/configuration review
- PII-safe logs, fixtures, screenshots, and error reporting

## Product-spec implementation gap

The larger product design requires these components, which are not yet complete:

- persistent Mission Manager
- Scheduler and 09:00 soft-scheduled report
- Tool catalog/contracts
- `check_order`
- controlled `update_order`
- `create_order`
- `check_availability`
- `get_price`
- `update_inventory`
- `check_finance`
- order history/investigation tooling
- idempotency and expected-version enforcement across business writes
- partial-success recovery Missions
- final authoritative verification as a backend completion condition

The correct next step is to build one end-to-end Golden Workflow, not add more dashboard surface area.

## Recommended first production slice

Implement “record a deposit/payment” end to end:

1. persistent Mission is created
2. `check_order` returns a unique authoritative snapshot/version
3. Agent validates intent against the snapshot
4. confirmation rule is applied
5. `update_order(record_payment)` writes an idempotent Payment transaction
6. totals/status are recalculated transactionally
7. `check_order(order_id)` verifies the final state
8. Mission stores audit and becomes completed only after verification
9. calendar/order/finance views reflect the same persisted result

This slice tests the core architecture without depending on the Owlnest connector.
