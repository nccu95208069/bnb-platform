# Context & Conversation State

## Core rule

Do not classify or reply from the latest guest sentence alone.

A short message such as `Kevin`, `可以嗎？`, or `那這個呢？` may only make sense after reading the previous owner/guest turns and the current reservation state.

## Router context stack

Each routing decision may use:

1. Property State
2. Reservation State
3. Human-provided Context
4. Confirmed Conversation State
5. Open Loops
6. up to the most recent 50 human messages
7. latest message and relevant media evidence

Automation/system messages should not crowd out human context.

## Hard state

Longer-lived confirmed facts, typically reservation-scoped:

- confirmed identity
- active reservation
- room(s)
- check-in / check-out dates
- confirmed special exception, e.g. approved late checkout
- payment/transaction state when verified

## Soft state

Temporary conversational state:

- active topic
- waiting for a guest name
- waiting for booking number
- current clarification step
- current target room ambiguity

Soft state should be archived when the topic is resolved or superseded.

## Open Loops

An unresolved topic is not a permanent to-do item that must be injected into every reply.

A previous OpenLoop may be surfaced only when:

- the latest message clearly continues it
- the current answer depends on it
- it is a real transactional obligation that still must be completed

Otherwise, remember it silently.

**Memory exists so the AI does not forget; memory does not mean the AI should mention everything it remembers.**

## Phone / offline context

Phone conversations are a genuine information gap, not a model failure.

Owner-entered context should be represented as first-class `HumanContextEvent`, for example:

- `電話確認可延後退房至 12:00`
- `已人工確認為 8/15 302 客人`
- `電話詢價後等待匯款`

Human-provided context outranks AI inference.

## Source priority

A practical source order:

1. owner-confirmed manual context / reservation-specific exception
2. Google Sheet reservation data
3. confirmed conversation state
4. recent raw conversation
5. AI-inferred soft context

Each important fact should preserve:

- value
- source
- confidence
- scope
- effective time when relevant

## Scope model

- Property: property-wide rules/variables
- Person: persistent person-level facts that are truly person-level
- Reservation: room/date/booking-specific state
- Session/Conversation: short-lived interaction state

Do not save temporary reservation details permanently on a person record.

## Recent-message window

V1 may make up to 50 recent human messages available to the Context Builder.

A future optimization may pass the latest 15–20 messages verbatim and retrieve only relevant older messages from the remainder. Accuracy comes before token optimization during early dogfood.

## Reservation-specific exceptions

If the owner has explicitly approved a guest-specific exception, that exception outranks the general policy for that reservation.

Example:

- general checkout = 11:00
- owner explicitly approved this guest until 12:00

The reply should use 12:00 for that reservation.

## Context completeness

Router should be able to mark context as HIGH / MEDIUM / LOW.

If a guest message obviously depends on an unavailable phone/offline conversation, the system should not guess. It should signal incomplete context and let the owner take over or add a note.