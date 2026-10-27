# LINE finance booking guard checkpoint (2026-10-28)

This change is an additive candidate behind the disabled Iron Gate finance
command flag. It does not change production data, credentials, or cutover state.

The LINE connector can now submit a confirmed Iron Gate booking UUID directly
after an Iron Gate preview binds its current booking version and snapshot to a
signed preview token. A room or deposit still needs a confirmed booking and
the existing payment and room-price guards. Other connectors retain their
reviewed `finance_source_link` requirement for external bookings.

Voiding a booking-linked document requires `booking_guards` naming every
booking in the current revision and its expected version. Preview and commit
both compare those guards with the current Iron Gate booking state. A booking
status change does not prevent a corrective void, but a version change rejects
the stale confirmation. Idempotent receipt replay remains available after a
successful commit.

Local checks: `npm run check` passed. The isolated PostgreSQL finance command
integration test passed against `iron_gate_finance_test3`, including direct
LINE receipt preview, stale void rejection, and guarded void acceptance.

Release gates remain: exercise this path against the isolated LINE service,
complete historical source reconciliation and Sheet projection, then perform
the per-property W7 shadow comparison. No production writer is enabled here.
