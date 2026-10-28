# W6 Card refund and cutover compatibility checkpoint — 2026-10-28

This branch is a local implementation candidate. It does not change production
credentials, flags, connector configuration, or money records.

- A Card Done result records its original payment event UUID once in the booking
  projection and finance ledger. Its alias remains registered under that property's
  `iron_gate_native` source instance, so a later native import cannot accept the
  same source record as a second receipt. Card cutover requires that native source
  instance to be registered, but does not require native cutover or enablement.
- A Card-managed external booking can refund only a Card Done receipt belonging
  to the same booking. The refund writes the booking payment event, finance
  document/event/allocation/ownership, request receipt, and change sequence in
  one PostgreSQL transaction. Prior payments from other sources remain in review.
  Generic finance commands still reject refunds of native or Card receipts.
- With the finance schema installed, an external Card refund must have an
  effective Card or native cutover, an enabled native source instance, and the
  runtime ledger capability. Otherwise the entire write rolls back. An already
  effective but disabled connector also blocks the write. Before migration 005
  creates `finance_connector`, the legacy writer continues to work.
- Authenticated OS booking reads with the `money` field scope expose
  `cardManaged: true` for a Card Done booking. The field is absent for readers
  without that scope. This enables an OS adapter to distinguish the reviewed
  Card refund path from other external bookings.

Verification used synthetic data in an isolated local PostgreSQL cluster:
the Card-first path, two partial refunds, idempotent retry, over-refund
rejection, disabled connector rollback, native source alias, and booking/ledger
linkage passed. The Iron Gate regression suite passed with 439 tests and 15
environment-gated skips. An OS adapter still needs to consume the `cardManaged`
read contract before an operator can use the path in the product.
