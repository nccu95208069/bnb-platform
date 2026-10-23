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

The optional LINE `inventory:write` grant can close or open one canonical
manual block through a signed, versioned preview and idempotent commit. It is
separate from booking amend/cancel. Each commit makes a bookingless channel
operation with the same durable claim, fence and fresh readback rules. Opening
is rejected while another booking, manual block or unresolved fence controls
that night. The GCO cutover flag blocks the old Sweetfun OwlNest card, queue
and execute endpoint; any old queued tasks must be drained or quarantined
before this flag is enabled. OFFLAND uses the old path.

The channel runner now has a per-property claim adapter that stores the active
operation in the canonical property transaction. Only an exact `sync_verified`
readback releases it. An error, partial observation, or unknown provider write
leaves a durable `review_required` claim. A crashed process leaves its active
claim in place; there is deliberately no timestamp takeover that could overlap
an OwlNest write. Recovery requires an operator to stop the original worker,
read OwlNest stock, settle the pending operation and document the evidence
before clearing the claim. No automatic recovery endpoint is exposed.
The one-shot worker library selects one pending operation with the channel
grant, acquires that claim, observes or sets exact OwlNest cells, records the
server-checked readback and calls an injected PII-free review alert. The
library has a fail-closed Vercel cron entrypoint at `/api/channel-worker`, scheduled
every five minutes. The entrypoint remains disabled unless the Production-only
`IRON_GATE_PRODUCTION_CHANNEL_WORKER_ENABLED=true`, `CRON_SECRET`, database URL,
property/grant IDs, OwlNest room map and OwlNest bearer credential are all
configured. It handles one operation per tick. The bearer credential is supplied
as a secret environment variable; its expiry or revocation stops dispatch and
leaves the durable claim/fence for review. The entrypoint logs PII-free review
identifiers but no external alert receiver is connected yet. Manual
`scripts/recover-channel-claim.mjs` observes the exact cells before clearing a
claim and never issues another OwlNest write.

An unknown cancellation, an unready channel, or a second source event while
the prior channel operation is unresolved stays in human review. The existing
review behavior remains the default when the internal flag is false. This is
deliberately fail closed: a locally applied order is **not** evidence that
OwlNest inventory has changed.

## Release gates still required

1. Provision and test the disabled scheduled entrypoint with a current provider
   credential and an alert receiver. Verify a deliberate failed tick reaches the
   operator; the current PII-free log alone is not an alert. An acknowledgement from OwlNest is
   insufficient; record a fresh complete observation through
   `recordChannelReadback`.
2. Reconcile all future occupied nights and manual blocks against real OwlNest
   stock before changing production mode. Check that Gmail events remain
   receipted during a source/channel race. Keep a reversible mode and queue
   rollback procedure, preserving existing bookings and fences.
3. Run controlled real-cell tests for source create, move, cancellation, manual
   block, ambiguous provider outcome, and a second Gmail email before expanding
   LINE writes. No guest messages may say “通路已同步” until the channel operation
   is `sync_verified`.
4. Check `/v1/properties/{propertyId}/line-capabilities` with the actual
   zero-traffic candidate grant and compare every enabled LINE write flag to
   `canCreate`, `canAmend`, `canCancel` and `canInventory`. Verify
   `channelReady`, authority epoch and inventory version as well.

The current production LINE credential remains unissued; the candidate code
has separate dormant read, create and manage-all grants. The backend has a
LINE create protocol: an explicitly marked create
grant can request a 15-minute private preview bound to the verified actor,
grant, exact booking input and inventory version. The commit route checks that
preview and the current channel/source-readback gates before atomically writing
one local booking and a fenced channel operation. GCO PR #93 now has a gated
durable confirmation journal and result readback for this protocol. No create
grant has been issued, so no LINE create operation is enabled in production.
The manage-all grant additionally permits confirmed orders from every source to
be amended or cancelled through a versioned, actor-bound preview. External
source changes remain marked for reconciliation; removed nights stay closed
until source acknowledgment and another exact channel readback. Contact and
notes cannot be proven by the current source event schema and remain in review
after a LINE edit. Paid and channel-pending bookings reject LINE mutation.
