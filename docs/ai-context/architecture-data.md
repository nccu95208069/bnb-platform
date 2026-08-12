# System Architecture & Data Model

## High-level V1 flow

```text
LINE Webhook
  -> Message Ingestion
  -> Conversation / Message Store
  -> Context Builder
  -> Conversation Router
  -> Identity / Reservation Resolver when needed
  -> Reply Engine
  -> Suggestion Store / Mobile UI
  -> Owner edit + explicit send
  -> LINE Send
  -> Feedback / Audit
```

Side data sources:

```text
Google Sheet Reservation SSOT
Property / Room structured data
Reply Topic / Reply Content
Sensitive Variable Store
Model Gateway
```

## Engineering priorities

- tenant isolation from day one
- reliable webhook ingestion and idempotency
- persist incoming messages before AI processing
- manual-send fallback even if AI is unavailable
- clear audit trail
- masked secrets in logs
- provider abstraction for Router / Vision / LLM
- reversible implementation choices when details are not frozen

Do not begin the project by optimizing prompts.

## Core entities

V1 should conceptually support:

- Tenant
- Property
- Room
- Contact / LINE User
- Reservation / Booking
- StayUnit
- Conversation
- Message
- IdentityLink
- StateFact
- OpenLoop
- HumanContextEvent
- ReplyTopic
- ReplyContent
- StructuredVariable / SensitiveVariable
- RouterDecision
- ReplySuggestion
- FeedbackEvent

## Important relationships

### Contact / LINE User -> IdentityLink -> Reservation

The person/channel identity and the reservation are distinct. IdentityLink connects them.

### Booking -> StayUnit(s)

A single customer booking may map to multiple stay rows because of multiple rooms or multiple nights.

### Conversation -> Messages

Messages are immutable event history. Rebinding identity should not rewrite past messages.

### Conversation -> StateFact / OpenLoop / HumanContextEvent

State lives beside the raw conversation. It is not a replacement for the message history.

### ReplyTopic -> ReplyContent

A topic classifies the question. Reply content is the actual text/editor content.

### StructuredVariable

Current operational values such as check-in time, parking data, or room facts should be structured when possible.

### SensitiveVariable

Sensitive values use dedicated access/version handling and are not general RAG documents.

## FeedbackEvent

Capture at least:

- suggestion text
- owner final text
- whether suggestion was selected/rejected/ignored when observable
- diff between suggestion and final text
- associated RouterDecision / ReplyTopic when available

This data is first used for evaluation and product improvement; do not automatically fine-tune from every edit.

## Auditability

Important mutations should be attributable to:

- actor
- source
- timestamp
- previous/current value when appropriate

This matters for identity binding, reservation-specific exceptions, sensitive-variable changes, and owner-provided context.