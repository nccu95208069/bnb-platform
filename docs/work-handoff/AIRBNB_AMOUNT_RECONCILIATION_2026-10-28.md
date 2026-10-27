# Verified Airbnb amount reconciliation

A five-room imported Airbnb stay retained its manually entered amount after the guest cancelled and rebooked. Verified platform gross, host fee and expected net now have a separate money-only correction record. The original imported rows remain immutable. No receipt, refund, expense or channel operation is created by the correction.

## Contract

- Canonical booking totals and finance receivables use expected net payout. The UI separately labels gross room charges, host fees, platform tax and guest payment; room amounts use the original allocation weights, with whole-TWD largest-remainder rounding.
- An exact, complete private manifest binds five booking/link before-images to reviewed platform/mail/history evidence. The serializable maintenance transaction checks the property version, refuses changed targets/collisions/replay, updates all five bookings and source links, increments inventory once, and records five audit/outbox events.
- Evidence hashes and actual reservation identifiers stay in private manifests/audit. Public source control contains only the generic repair and synthetic tests.
- The reconciliation marker validates original immutable source references, room/stay, platform identity, original total, corrected total and balanced group totals. It remains valid after an unrelated version increment only while every bound fact still matches. Price-hidden readers receive no correction amounts.
- Finance overlays the five existing legacy order IDs. Existing real receipts remain in their original ledger; neither source payment flags nor expected platform payouts generate income. Missing, partial, inconsistent or duplicate mappings stop projection instead of falling back to the stale amount.
- Later finance allocations revalidate the authoritative booking/version/net amount and preserve the legacy ledger identity. Uncorrected legacy orders retain their existing checks.

## Verification and rollout

Synthetic coverage exercises allocation rounding; unknown fields, receipt evidence, stale links and changed targets; PostgreSQL dry-run, atomic rollback and replay; unchanged occupancy/other bookings; money redaction; calendar/payment identity; finance projection with zero receipts; and one actual synthetic receipt with an idempotent retry. Production receipts are never used for testing.

Deploy both compatible readers before applying a private manifest. Coordinate with the active LINE release, re-read current production source/deployments and property version, and regenerate the manifest on a new version. After apply, verify all five booking/link versions and net totals, retained gross/fee evidence, zero new receipts, identical other-booking and channel state, and authenticated calendar/finance readback. The PR carries the final release/readback evidence; this document alone does not assert production completion.
