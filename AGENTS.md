# AGENTS.md — BnB SaaS / Sweetfun OS

This file is the entry point for ChatGPT Work, Codex, Claude Code, and other coding agents.

## Mandatory reading order

1. `WORK_CONTEXT.md`
2. `docs/work-handoff/README.md`
3. `docs/work-handoff/PRODUCT_DECISIONS_V0_2.md`
4. `docs/work-handoff/IMPLEMENTATION_STATUS_2026-09-05.md`
5. `docs/work-handoff/NEXT_WORK.md`
6. Relevant code and tests

`AI_CONTEXT.md` and `docs/ai-context/` describe the earlier LINE Reply Copilot subsystem. Preserve them as useful subsystem context, but do **not** treat them as the current top-level product contract when they conflict with `WORK_CONTEXT.md` or the newer Agent-First order/finance decisions.

## Current product track

The active build track is an Agent-First hospitality operations system for small properties. It combines:

- month/week/day booking and occupancy views
- order and payment operations
- availability and price lookup
- workspace roles and property scopes
- structured stay requirements
- persistent Missions, deterministic Tools, Playbooks, scheduling, audit, and recovery

The earlier messaging/reply-copilot work is a parallel or future subsystem, not the immediate implementation priority.

## Source precedence

When sources disagree, use this order:

1. latest explicit owner decision
2. `WORK_CONTEXT.md`
3. `docs/work-handoff/PRODUCT_DECISIONS_V0_2.md`
4. `docs/work-handoff/IMPLEMENTATION_STATUS_2026-09-05.md` for actual shipped state
5. current code, migrations, tests, and merged PRs
6. older `AI_CONTEXT.md` and `docs/ai-context/`
7. legacy README or comments

Never silently reconcile a conflict. Record it and state which source wins.

## Core execution rules

- Agent owns intent understanding, Mission planning, Tool sequencing, input/output validation, and replanning.
- Tools own authoritative queries, unique matching, deterministic business validation, calculations, writes, external synchronization, idempotency, and structured errors.
- Important writes follow `check -> update -> check`.
- A Tool returning success is not sufficient; the final authoritative query must match the original instruction.
- Never let the model choose one record from ambiguous active bookings.
- Overlapping active orders for the same room/stay period are a data-integrity incident and should create a blocking investigation Mission.
- Resume a paused write Mission only after revalidation.
- First version: one Tool execution stream per property; switch Missions only at Tool boundaries.
- Priority: safety/blocking > owner real-time > routine scheduled.
- Waiting for the owner blocks only the dependent Mission.

## Implementation discipline

- Keep the public Vercel site anonymized until production authorization and data isolation are complete.
- Never commit guest PII, raw chats, booking exports, access codes, bank details, credentials, tokens, or production secrets.
- Treat private spreadsheets and screenshots as local/project evidence only.
- Use branches and pull requests for changes.
- Keep migrations idempotent where practical and source-control every production database change.
- Run frontend lint/build and backend lint/format/tests before merge.
- Distinguish a demo/localStorage interaction from a production-persisted operation in UI and documentation.
- Do not claim SMS login is operational until a provider is configured and end-to-end delivery is verified.

## Autonomy rule

Proceed independently for reversible, low-risk engineering work. Stop only for irreversible or high-risk actions, paid-service/credential requirements, missing critical assets with no safe substitute, or a decision that materially changes the approved product strategy.

## Definition of done

A task is done only when:

- behavior matches the accepted product decision
- authorization is enforced server-side where relevant
- errors and partial success are represented explicitly
- tests/builds pass
- docs reflect the actual state
- no sensitive data is exposed
- final behavior is verified rather than inferred
