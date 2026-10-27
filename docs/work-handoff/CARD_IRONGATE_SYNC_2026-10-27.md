# Booking Credit Card sync — 2026-10-27

Implemented and tested with synthetic data. No production grant creation, deployment, Sheet write or real receipt has been performed.

## Behavior

Sean Dashboard keeps two steps: record Done/Fail in Credit Card, then preview and confirm synchronization. Current scope begins 2026-10-26. Only full Booking room-price receipts qualify. The resolver requires an exact OTA number within the scoped property, a unique canonical external booking, exact stay bounds, matching total and a confirmed, non-diverged order. Names never select a booking.

IronGate has a dedicated `POST /v1/properties/:propertyId/card-sync/{preview,commit}` contract. It accepts only sanitized fields (sheetId, tab, row, platform, orderId, checkIn, checkOut, amountCents, status, chargeDate). Commit additionally binds bookingId and expectedBookingVersion. Only a separate finance `card:sync` credential with money access can call it; mixed action grants are rejected.

Done appends one immutable credit-card received event with a deterministic property/booking event ID. Row moves, week moves and new request IDs cannot create another receipt. Fail appends only a result/audit entry; Fail→Done records the first receipt once. Done→Fail, changed amount/date, existing legacy paid flags and other receipts block automatic synchronization. A failed attempt does not remove a legacy paid claim.

The OS server-only `/api/internal/card-sync` bridge authenticates a dedicated secret, signs the reviewed input and version, uses the shared payment lock, checks every exact old SF/IG identity, then reserves those identities before the remote write. Both legacy OS receipt paths enforce those durable reservations. Unknown results keep the reservation; fresh preview/readback recovers the receipt. No automatic refund or deletion is part of recovery.

Review correction (P1): a financial result must not make the next source-owned amendment/cancellation diverge solely because it increments the booking version. Aligned source links advance with this result in the same transaction; existing divergence remains blocked. A real service regression test first reproduced the missed cancellation and now passes for both Fail and Done, preserving the original receipt after cancellation.

The finance snapshot includes only native OS bookings plus external bookings with canonical card receipts. OS replaces the matching legacy order projection with the canonical order and counts the whole multi-room/night total once. Credit-card entries are labeled Booking; manual native-payment controls remain limited to direct bookings. Calendar paid status derives from the same immutable receipt.

## Release contract

The companion GCO document `docs/CARD_IRONGATE_SYNC_2026-10-27.md` specifies the four-stage release and exact-source acceptance. Required new server configuration:

- IronGate: dedicated credential with origin `finance`, actions `[card:sync]`, fields `[money]`, exact workspace/property/current epoch. Existing transactional JSON state persists results; no new database schema.
- Prepare this credential with `node iron-gate/scripts/prepare-sweetfun-finance-grants.mjs NEW_PRIVATE_DIRECTORY --card-sync`; issuance SQL contains only the token hash, verifies authority and refuses duplicate active subjects. The plaintext grant is sent only to the OS production environment.
- OS: `IRON_GATE_CARD_SYNC_GRANT`, `CC_SYNC_OS_TOKEN` (32+ random characters), `IRON_GATE_CARD_SYNC_ENABLED=true`; existing Sweetfun finance/calendar configuration remains required.
- cc-sync: `CC_SYNC_TARGET=irongate`, `CC_SYNC_OS_URL=https://<OS>/api/internal/card-sync`, matching `CC_SYNC_OS_TOKEN`, existing IAM and source OAuth mounts. Dashboard always sends `target=irongate`.

Do not release only one component. Disable new card writes to pause; retain canonical finance projection and ownership markers after receipts exist. Never roll back to the frozen main-Sheet writer or clear an unknown claim to retry.

## Baselines and validation

The integration baseline combines backend release `c3c215f` with released OS/Offland baseline `ad90379`, preserving current LINE/OwlJourney and OS behavior. Review base `114e817` explicitly excludes the still-open PR #95 amendment-button change. The integration baseline is separated from the card feature so its diff contains only this task.

Verified locally:

- IronGate check/build and suite: 334 passed, 9 environment-dependent checks skipped.
- Actual OS finance/legacy-payment route tests: card full-total multi-room/night projection, duplicate replay, changed week, pre-existing SF receipt, lost response recovery, modified signed input and a legacy write between preview/confirm.
- Cross-repository acceptance: GCO parser and HMAC preview → actual OS internal route → actual IronGate HTTP/transaction → actual OS finance context. Fail, Done, repeated confirmation and Done→Fail all preserve the expected single-receipt balance.
- Frontend lint has zero errors; seven existing warnings remain. Production build passed.

`frontend/tests/helpers/card-sync-wire.mjs` is a synthetic stdin/stdout harness for the companion GCO acceptance command. It rejects all external network access. These checks do not prove real Google/production service connectivity; live preview and a specifically authorized real-item confirmation remain release acceptance steps.
