# BnB Platform — LINE Reply Copilot Subsystem Context

This folder is a public-safe, AI-readable specification hub for the earlier LINE Reply Copilot subsystem.

## Current top-level context

For the active Agent-First booking, occupancy, payment, reconciliation, Mission, and Tool product track, read:

1. [../../AGENTS.md](../../AGENTS.md)
2. [../../WORK_CONTEXT.md](../../WORK_CONTEXT.md)
3. [../work-handoff/README.md](../work-handoff/README.md)

If this folder conflicts with those newer files or a later explicit owner decision, the newer source wins.

## What remains valid here

These pages preserve useful subsystem work for future or parallel messaging capabilities:

1. [Product & decisions](product.md)
2. [Mobile UI/UX](mobile-ui.md)
3. [Identity & reservation resolution](identity.md)
4. [Context & conversation state](context-state.md)
5. [Knowledge & reply model](knowledge-replies.md)
6. [Conversation Router & Reply Engine](router-reply-engine.md)
7. [System architecture & data model](architecture-data.md)
8. [Evaluation / Stage 3B](evaluation.md)
9. [Implementation plan & agent rules](implementation.md)
10. [Sweetfun current business truth](sweetfun-current-truth.md)

The root `AI_CONTEXT.md` is the detailed historical baseline for this Reply Copilot track. It is no longer the top-level product contract for the repository.

## Privacy boundary

The public docs intentionally exclude:

- raw LINE exports
- guest phone/email/PII
- reservation row datasets with identifiable guests
- OTA screenshots
- actual entrance/keybox/Wi-Fi passwords
- bank-account values
- raw contextual benchmark examples containing identifying data

Those remain private project evidence.
