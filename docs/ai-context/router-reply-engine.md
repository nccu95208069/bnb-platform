# Conversation Router & Reply Engine

## Router role

The Router reads structured state plus recent conversation. It is not a single-message classifier.

Conceptual output includes:

- intents
- conversation acts
- known fields
- missing fields
- context completeness
- identity/room resolution need
- next action
- reply-topic candidates
- confidence
- state updates

Intent and Conversation Act are separate. A message can provide identity evidence or a follow-up value without creating a new business intent.

Multi-intent messages are supported.

## Reply Engine role

Router answers: what is happening and what data is missing?

Reply Engine answers: what suggestion should the owner see?

Typical routes:

- Parking question with current policy -> Fixed Reply
- Bed-size question with known room -> Room Master -> Data-Inserted Reply
- Bed-size question with unknown room -> resolve identity/room first
- Booking-room question -> return only the requested reservation field
- Open-ended recommendation -> AI-Written
- Unknown money or exceptional situation -> Human Handling

## Suggestion lifecycle

1. Store new guest message.
2. Build context.
3. Route intent/state/missing data.
4. Produce current suggestion.
5. Owner taps suggestion to insert it into the input.
6. Owner edits if needed.
7. Owner explicitly sends.
8. Store feedback and audit metadata.

A new guest message makes the previous suggestion stale and starts a new suggestion round.

## Safety rule

Missing business truth is never filled from plausible historical patterns. Resolve structured data, ask for required information, or use Human Handling instead of inventing an answer.