# Sweetfun historical review exception

During the 2026-10-22 cutover rehearsal, the frozen source contained four
quarantined rows covering two room-night collisions from 2025. The owner chose
to leave 2025 history out of the live inventory decision. The original Sheet
and all four source rows remain unchanged; the Iron Gate shadow retains the
quarantined rows and both review fences for later audit.

`sweetfun-historical-review.mjs` permits a versioned, source-hash-bound waiver
only when the shadow contains exactly four single-row
`ROOM_NIGHT_CONFLICT` groups, two distinct room-nights each represented twice,
both nights before 2026-01-01, and exactly their two matching review fences.
The waiver records the owner's decision reference, time and a fingerprint of
the frozen source evidence. Credential staging and authority activation reject
missing or stale waivers, any new conflict, a changed source hash, or a fence
outside those two historical room-nights.

The exception does not resolve the historical bookings or count them as
accepted inventory. It does not activate authority by itself. The usual
writer pause, drain, final source copy, source-link verification, credential
staging, epoch switch, and post-switch reconciliation remain required.
