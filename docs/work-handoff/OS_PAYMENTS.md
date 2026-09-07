# OS payment records — 2026-09-08

Owner approved OS as the payment record store; no Google Sheet writes. Booking data remains Sheet-owned. This decision supersedes the earlier read-only/payment-sandbox boundary for this limited operation.

## Contract

- GET `/api/v1/order-payments?property=…&order=…` is `check_order`: authenticated, property-scoped, price-visible. It returns complete parent-order room-night scope, room fee, source fingerprint, OS ledger version and receipts.
- POST same path records `deposit`, `balance`, or `other`. Inputs: property_id, order_id, expected_version, source_version, request_id (UUID), amount (TWD, positive max two decimals), payment_type, payment_method, received_at (UTC ISO timestamp), note, settles_room.
- UI shows Taiwan local time; default now, editable before confirmation. created_at is immutable server time. Actor comes from authenticated principal, never request data.
- Balance requires explicit confirmation that **all rooms/nights of that parent order** are settled, including historical receipts not yet imported. Other fees do not settle room charges. No inferred historical receipt amount/date; source `done` is guest paid, not OTA payout.
- Existing internal parent IDs remain stable. Missing parent IDs remain per-row. OTA/OwlNest IDs are private overlays on matched live rows. Sweetfun reader now includes N (OTA order number); no raw external IDs enter anonymous monitor snapshots.

## Persistence and safety

Private Redis (existing managed OS storage), non-expiring keys `sweetfun-os:payments:v1:{property}:{sha256(order_id)}`. Schema: version and append-only receipts; each receipt has actor, request hash, source fingerprint, Mission ID and timestamps. Up to 1,000 receipts per order; no silent trimming or TTL. Sheet monitor uses independent keys.

Server enforces owner/God/admin/housekeeper with property scope and viewPrices. Viewer GET allowed; viewer POST denied; no-price users denied both. Same-origin POST and rate limit. Per-property lease plus atomic fenced CAS protects ledger/verification-pending Mission together. Successful readback completes the persisted Mission; retries use the same request ID, even if Sheet changed afterward. Conflicting payloads under one request ID rejected. Source conflicts/changes create a persisted blocked investigation child; resubmission always checks current source again. Full Mission Center UI/scheduler integration is not included here.

Before write, current live Sheet projection must exactly match the published order fingerprint. Source change does not get silently written over. Existing receipts survive source changes; settlement confirmation is fingerprint-bound. Failed storage never falls back to browser demo state. No order payment is fabricated during verification.

Month badges preserve platform colors (✓ paid, 訂 deposit, 未 unpaid, ? unknown); week/day labels use same status. Hidden-price bookings render no badges. Mixed nightly source statuses are not inherited from the first night. Calendar overlays full parent order status before front-end merging.

## Boundaries

No Sheet writeback, refund/void, post-save receipt edits, OTA settlement/reconciliation, or automatic invoice generation. Receipt time is editable before save; original receipt and actor are immutable. Old source-paid receipts are not synthesized. OS received amount is not claimed to be all historical payments or an exact outstanding balance. Source identity regrouping requires investigation; no name-based financial matching.

Rollback: redeploy previous UI/API; retain payment keys and Missions (never delete financial records). Schema v1 remains readable. Export/migration and provider-level backup policy need to accompany broader finance rollout.

## Verification

Unit/adapter tests cover authorization, property scope, validation, expected versions, source changes, idempotency, CAS contention, persistent receipt readback, OTA IDs on matching rows, no public ID leakage, and Sheet reader range. Private live-storage test uses a synthetic verification-only property and cleans only its own keys. No real guest payment is written by tests.

## 2026-09-08 payment review simplification

Payment review defaults off. The sold toolbar has an authorized price-visible toggle. Normal mode hides payment badges/legend and preserves platform colors; review mode renders paid booking cards gray in month/week/day and retains unresolved status badges. Full payment is a distinct receipt type `full`, prefills the room fee less OS-recorded room payments, requires explicit settlement confirmation, and preserves all existing validation/version/idempotency rules.

## Main Sheet writer investigation (local source inspection, not deployed-revision verification)

Inspected `gmail-check-order` local worktrees and `card-charge-app`:
- `src/processors/splitter.py:get_payment_status`: Agoda defaults to done, other platforms not_yet on ingestion. `src/sheets/updater.py:_order_to_row` puts this in H.
- `src/main.py` modification flow deletes existing records then splits/inserts; therefore initial payment defaults are also a rewrite risk on modification.
- `scripts/sync_credit_card_status.py:build_batch_updates` writes O:Q, plus H=done only when q_value equals done and amount_status equals amount_ok. Its header comment about never touching H is outdated; executable implementation and tests specify H writes.
- `src/cc_sync_service.py` wraps that script as a separate service; do not assume the main checkout is the deployed ingestion revision. Local documentation explicitly records different deployed branches.
- LINE registration has an initial not_yet default; OFFLAND registration has blank payment status. Manual Sheet editing is another source per owner.
- Card UI updates its credit-card sheet status/date; a separate synchronizer propagates eligible successful charges to the main sheet.

OS does not write back to Sheet in this revision. Before enabling: identify deployed writer revisions, route writers through a shared payment-status change contract with actor/source/old/new/time/expected revision and stable row identity; preserve append-only audit. Cross-source attempts after an earlier edit should become review-required rather than silently overwriting, including same-value writes. Manual Sheet edits need an attributable change capture path; value polling alone cannot reconstruct editor identity or an intervening edit that returns to the same value. Unknown source must remain explicitly unknown. Main H is only a full-payment flag; deposits/other receipts stay in OS ledger. Do not invent historical actor attribution.
