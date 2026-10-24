# Sweetfun 302 source-review repair — 2026-10-24

The 2026-10-24 room 302 stay was sold in OwlNest under source order
`OBE06240618826102306`. Its original Agoda confirmation arrived in the
Sweetfun mailbox at 01:56:46 Asia/Taipei. The Gmail writer submitted the
source event while the previous booking for the same room-night was still
confirmed because its cancellation had failed. Iron Gate recorded a
`ROOM_CONFLICT` receipt and a `source_review` fence; it did not create a
booking or source link. The previous booking was later cancelled, but the
review fence intentionally remained.

On the owner's request to clear the redundant block, the repair was limited
to that one source order, room and night. The original Gmail message was
reparsed without changing its labels. Its deterministic request key and
canonical request hash matched the stored `ROOM_CONFLICT` receipt. A fresh
database read showed inventory version 56, no active occupancy or source link
for this order, exactly one matching review fence, and a verified closed
channel operation for the room-night. The owner independently confirmed the
new order in OwlNest.

The source-bound repair script first ran in a transaction that rolled back.
Its readback predicted one confirmed booking, one source link, one occupied
room-night, no old review fence and one pending channel fence. An independent
read confirmed the rehearsal left version 56 unchanged. The same pinned
transaction then committed version 57. The independent post-write query
confirmed:

- booking `2a1d18d2-a9a5-4624-983b-e311c5b2d1d7` is confirmed for room
  302, 2026-10-24 through 2026-10-25;
- the source link points to that booking and is not diverged;
- the old `review:[...OBE06240618826102306]` fence is absent;
- exactly one occupied room-night exists; and
- channel operation `7476c886-c115-4eda-8b1e-867ce50650a6` requires
  `closed` and retained a `channel_pending` fence until external readback.

At 10:00:37 Asia/Taipei the next channel worker invocation read back the
actual OwlNest stock as zero for the room-night. The operation became
`sync_verified`, the booking's channel state became `verified`, and its
temporary `channel_pending` fence disappeared at inventory version 58.
The authenticated Sweetfun OS calendar was refreshed and showed the Agoda
booking for room 302 on 2026-10-24 through 2026-10-25, not a review block.

The original review receipt remains intact for audit. Guest details and
database credentials are not stored in this repository. The private repair
manifest was built from the original email and is not part of this commit.
Do not reuse the script for another order; its identity, versions, source
hash, room and date are intentionally fixed.
