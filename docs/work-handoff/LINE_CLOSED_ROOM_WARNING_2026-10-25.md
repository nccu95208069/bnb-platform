# LINE registration against manually closed rooms

## Owner decision

The owner explicitly requested that a manually closed room may still be registered,
with a visible warning that the room is closed and there may be overbooking risk.
This supersedes the blanket refusal for every manual closure in the LINE manual
booking flow. An existing held/confirmed booking and any unrelated operation fence
still block registration; ambiguous occupancy is not resolved by this exception.

## Contract

LINE create and stay-amendment requests may include `acknowledgedClosedNights` only
with the existing authorized `channelPolicy=manual`. The list must exactly match
all manually blocked target nights, without duplicates. The preview echoes it as
`closedRoomNights`; the LINE adapter verifies the echo and displays room/date details,
the risk and the meaning of pressing confirmation. There are no booking writes at
preview time.

The list is bound into the signed preview, idempotency digest and audit record.
Target occupancy, manual blocks and fences remain bound into the existing target
hash; target changes invalidate the card before commit. Under the property
transaction, exact acknowledgement is checked again. Acknowledgement never bypasses
another active booking or a pending-operation fence. No manual block is deleted,
no OwlNest write is issued and no source/payment identity is changed by registration.
Existing explicit channel-handling steps continue to apply.

OS, website, legacy non-manual LINE, holds, source ingest and cancellation contracts
are unchanged. An old LINE client continues to refuse a closed room. A new LINE
client paired with an old backend fails closed on the unsupported request field.

## Verification and rollout

- Before the change, new acknowledgement tests reproduced `ROOM_CONFLICT` failures.
- Six isolated checks cover create, HTTP amendment, exact acknowledgement, no preview
  writes, idempotency, retained blocks, no external operation, occupied rooms, fences,
  changed target state and tampered signed requests.
- TypeScript check and build pass. Iron Gate full suite after integration: 297 passed, 9 skipped;
  skipped suites require their separate configured PostgreSQL test environment.
- A concurrent signed OwlNest notification release changed production before promotion.
  The closed-room patch was moved onto that exact deployed source; all 58 runtime
  source files in the fresh deployment matched the selected base. Its source-event
  identity validation and duplicate protection remain intact.
- No production guest booking, payment, inventory or LINE test message was written.
- Candidate/production rollout is pending. Runtime-specific operational evidence
  stays in the private release record; this public document contains no guest data.
