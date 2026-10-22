# Sweetfun LINE and Gmail channel readback candidate

The production property still has `channel.mode=none`. The optional internal
`channel.sourceReadbackEnabled` field is absent/false in production. This code
does not change either value or issue an OwlNest request by itself.

## Candidate contract

When a property is explicitly set to OwlNest mode with a ready channel grant
and `sourceReadbackEnabled=true`, a verified source event can commit the local
booking and enqueue one durable `sync_pending` channel operation. New or still
occupied nights request **closed** stock. Nights released by an amendment or
cancellation request **open** stock only if there is no other local booking,
manual block, or unresolved fence; otherwise they request **closed** stock.
The operation fences all affected nights until a fresh, exact provider
observation is accepted. The source receipt records the operation key and
pending channel state. The email source version remains linked to the booking
version after a successful channel readback, so the next Gmail amendment does
not falsely appear to diverge.

The active channel grant can poll `GET /v1/inventory-operations` for bounded,
PII-free pending operations. Polling does not claim a lease, trigger a provider
write, or clear a fence.

An unknown cancellation, an unready channel, or a second source event while
the prior channel operation is unresolved stays in human review. The existing
review behavior remains the default when the internal flag is false. This is
deliberately fail closed: a locally applied order is **not** evidence that
OwlNest inventory has changed.

## Release gates still required

1. Implement a durable per-property dispatcher for pending operations with a
   lease, retry/recovery, provider credentials, and actionable alerts. An
   acknowledgement from OwlNest is insufficient; record a fresh complete
   observation through `recordChannelReadback`.
2. Reconcile all future occupied nights and manual blocks against real OwlNest
   stock before changing production mode. Check that Gmail events remain
   receipted during a source/channel race. Keep a reversible mode and queue
   rollback procedure, preserving existing bookings and fences.
3. Run controlled real-cell tests for source create, move, cancellation, manual
   block, ambiguous provider outcome, and a second Gmail email before expanding
   LINE writes. No guest messages may say “通路已同步” until the channel operation
   is `sync_verified`.

The current LINE credential remains `booking:read` only. This candidate does
not authorize LINE create, amend, cancel, or manual stock changes.
