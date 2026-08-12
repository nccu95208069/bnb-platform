# Product & Decisions

## Product position

An iOS-first AI reply copilot for small hospitality operators using LINE Official Account.

The product is **not** an autonomous chatbot. It helps the owner understand the current conversation, resolve booking/identity context, and generate the safest useful reply suggestion. The owner remains the sender.

## V1 goals

- Reduce repeated typing and context switching.
- Surface booking-aware replies without turning the product into a PMS.
- Keep the experience mobile-first and close to a familiar messaging workflow.
- Avoid hallucinating prices, policies, room data, or identity.
- Learn from owner corrections without immediately fine-tuning.

## Frozen product decisions

- iOS first; Android and Web may follow.
- LINE OA is the first communication channel.
- Human-in-the-loop: no automatic AI sending in V1.
- Google Sheet remains Reservation SSOT.
- LINE User ID writes to column R for all related stay rows; SaaS keeps one canonical IdentityLink.
- Router accuracy is more important than minimizing inference cost.
- Fixed/data-inserted replies are preferred over free generation.
- Historical conversations are evidence, not current business truth.
- Human-provided context from phone calls/notes is first-class product data.
- Sensitive values are structured/versioned and never stored as general RAG text.

## Core product flow

```text
Guest LINE message
  -> message ingestion
  -> context builder
  -> conversation router
  -> identity/reservation resolver if needed
  -> reply engine
  -> one or more reply suggestions
  -> owner taps/edits
  -> owner explicitly sends
```

## Non-goals for V1

- autonomous guest-facing AI
- replacing the PMS / Google Sheet
- a heavy desktop-only admin tool
- analytics-first dashboard
- per-property fine-tuning as onboarding
- requiring every new property to label hundreds of messages

## Decision precedence

When implementation sources conflict:

1. latest owner-approved decisions / spec freeze
2. latest Mobile UI/UX spec
3. V1 PRD and subsystem specs
4. research findings
5. legacy README/code behavior
