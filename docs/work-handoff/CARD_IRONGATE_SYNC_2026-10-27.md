# Booking Credit Card sync — 2026-10-27

Released on 2026-10-27 after owner-authorized review and deployment. The record below distinguishes production connectivity checks from synthetic receipt/replay acceptance; no real Sheet status or payment was changed by release validation.

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
- For the finance SSOT cutover, prepare a connector-bound replacement credential with `node iron-gate/scripts/prepare-sweetfun-finance-grants.mjs NEW_PRIVATE_DIRECTORY CARD_SOURCE_INSTANCE_ID --card-sync`; issuance SQL contains only the token hash, verifies the Sweetfun Card connector and authority, and refuses duplicate active subjects. The plaintext grant is sent only to the OS production environment.
- OS: `IRON_GATE_CARD_SYNC_GRANT`, `CC_SYNC_OS_TOKEN` (32+ random characters), `IRON_GATE_CARD_SYNC_ENABLED=true`; existing Sweetfun finance/calendar configuration remains required.
- cc-sync: `CC_SYNC_TARGET=irongate`, `CC_SYNC_OS_URL=https://<OS>/api/internal/card-sync`, matching `CC_SYNC_OS_TOKEN`, existing IAM and source OAuth mounts. Dashboard always sends `target=irongate`.

Do not release only one component. Disable new card writes to pause; retain canonical finance projection and ownership markers after receipts exist. Never roll back to the frozen main-Sheet writer or clear an unknown claim to retry.

## Baselines and validation

The integration baseline combines backend release `c3c215f` with released OS/Offland baseline `ad90379`, preserving current LINE/OwlJourney and OS behavior. Review base `114e817` explicitly excludes the still-open PR #95 amendment-button change. The integration baseline is separated from the card feature so its diff contains only this task.

Verified locally:

- IronGate check/build and post-review full suite: 339 passed, 9 environment-dependent checks skipped.
- Actual OS finance/legacy-payment route tests: card full-total multi-room/night projection, duplicate replay, changed week, pre-existing SF receipt, lost response recovery, modified signed input and a legacy write between preview/confirm.
- Cross-repository acceptance: GCO parser and HMAC preview → actual OS internal route → actual IronGate HTTP/transaction → actual OS finance context. Fail, Done, repeated confirmation and Done→Fail all preserve the expected single-receipt balance.
- Frontend lint has zero errors; seven existing warnings remain. Production build passed.

`frontend/tests/helpers/card-sync-wire.mjs` is a synthetic stdin/stdout harness for the companion GCO acceptance command. It rejects all external network access. The synthetic checks prove receipt/replay behavior. Production preview checks below establish real Google/service connectivity; an actual real-item confirmation remains a separate operational step.

## Authorized production release — 2026-10-27

The owner requested code review, fixes for P1 or higher, then deployment. Review corrected two P1 issues, each with a failing regression before the fix and a passing regression afterward:

1. Card results incremented booking version without advancing an already-aligned source link, so the next valid source amendment/cancellation could be incorrectly blocked. The same transaction now advances aligned links and preserves pre-existing divergence.
2. The cc-sync reader assumed fixed source-column positions. After header movement it could request a sensitive card column. It now validates unique allowlisted header names before requesting only the safe columns and rechecks the headers after reading; unknown/ambiguous headers stop before row reads.

Post-review checks passed: IronGate 339 tests (9 environment-dependent skips), GCO 6,348 offline tests (11 deliberately deselected), dashboard 424 tests, relevant OS tests/builds and cross-repository synthetic acceptance. Remote CI passed for all three feature PRs. Fail creates no receipt; Fail → Done → repeated confirmation or response-loss recovery retains exactly one receipt.

| Component | Source / merge evidence | Production release |
| --- | --- | --- |
| IronGate | tested `0a94299`, merged PR #97 / `9410edb` on the dedicated release base | `dpl_9ojA57F6Y8ApsZrxE1UAXY7jJfUe`, primary alias READY |
| Sweetfun OS | same tested BnB source | `dpl_5vJsPAzq9BqGj3KY6J5Q2cEU664U`, primary alias READY |
| Independent cc-sync | GCO `1472c25`, merged GCO PR #107 / `2dcaec7` | Cloud Run revision `cc-sync-card-1472c25`, 100% traffic |
| Sean dashboard | `b43add9`, merged dashboard PR #107 / `088c076` | `dpl_BLy8KFjrnmqHNGGaukBuNDKvV2Dn`, primary alias READY |

The BnB release combines the previously released backend/OS baselines described above and does not include the open amendment-button PR #95. GCO packaging came from the exact pushed commit through its release allowlist. The independent cc-sync service was first deployed at zero traffic, validated, then promoted. Gmail, LINE, notification and scheduler services were not deployed or changed.

A dedicated `finance` grant permits only `card:sync` and `money` for the existing Sweetfun workspace/property/current epoch. The versioned grant-preparation script produced the issuance SQL. Readback confirmed its scope and expiry at 2026-11-24 09:53:33 UTC. The OS bridge uses a separate secret pinned as `booking-card-sync-os-token:1` in cc-sync; existing credentials were not rotated. Operators must renew the scoped grant before expiry through the established issuance procedure.

Runtime comparisons preserved existing regions, routes, cron configuration, compute limits, timeouts, concurrency, identities, secret mounts/pins and IAM bindings. The only configuration additions were the scoped card grant/flag/bridge token in OS and the explicit IronGate target/OS URL/token in cc-sync. No frozen main-Sheet writer is used as fallback.

Candidate and primary-domain authenticated previews succeeded. The scoped card grant was also denied generic booking access. Real source preview of the current-week Credit Card tab returned HTTP 200 with 10 prospective full receipts and 1 audit-only failed result; 1 additional unmatched order was blocked for manual review. Guest/order identifiers, source content, credentials and screenshots remain private and are not included here. The authenticated production Dashboard browser displayed the same 11 pending items, zero already-synced items, one blocked item, and the explicit confirmation control. No preview was confirmed and no real receipt was invented for testing.

Release-window checks found no error/fatal logs on the newly deployed IronGate and OS functions. The completed cc-sync read-only probes returned HTTP 200. These observations are timestamped release evidence, not a claim about future service health.

For rollback/pause, disable new card writes while retaining receipt projection and ownership fences. Once real receipts exist, do not restore an implementation that hides them, clear reservations, or re-enable frozen main-Sheet writes.
