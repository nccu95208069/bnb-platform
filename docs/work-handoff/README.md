# Work Handoff Index — 2026-09-05

This folder organizes the product decisions, shipped implementation, unresolved work, and transition instructions needed to continue in ChatGPT Work or a coding agent.

## Read in this order

1. [`../../AGENTS.md`](../../AGENTS.md) — operating rules for AI agents
2. [`../../WORK_CONTEXT.md`](../../WORK_CONTEXT.md) — current top-level product and architecture context
3. [`PRODUCT_DECISIONS_V0_2.md`](PRODUCT_DECISIONS_V0_2.md) — detailed digest of the 2026-09-04 Agent-First product document
4. [`IMPLEMENTATION_STATUS_2026-09-05.md`](IMPLEMENTATION_STATUS_2026-09-05.md) — what is actually merged, deployed, and still demo-only
5. [`NEXT_WORK.md`](NEXT_WORK.md) — ordered milestones and acceptance criteria
6. [`START_IN_WORK.md`](START_IN_WORK.md) — copy/paste prompt for a new Work thread

## Source map

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
