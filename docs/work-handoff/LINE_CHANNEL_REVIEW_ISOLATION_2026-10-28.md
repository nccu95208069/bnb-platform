# LINE channel review isolation — 2026-10-28

## Owner decision and failure

An unresolved provider operation must protect its own exact room nights without
blocking unrelated LINE open/close requests. LINE must distinguish waiting,
active processing and review blocking. The owner authorized the coordinated fix
and release, and completion of the original already-confirmed pending request.
The old uncertain operation must not be replayed or silently marked successful.

Previously, any property dispatch claim caused the immediate worker to return
`sync_pending` and cron to return `idle`, indefinitely. The status API exposed no
dispatch phase. A held review on one date therefore stranded an unrelated date
while LINE incorrectly described it as OwlNest processing. A synthetic replay of
the released implementation reproduced sixty idle cron ticks with no provider
GET or PUT for the new request.

## Contract and implementation

There is still at most one active provider writer per property. An active claim
has no TTL takeover. A settled uncertain outcome is retained as a durable
`channelReviewHolds` entry containing the complete original claim, exact cells,
isolation time and reason. The original operation, booking, booking fence and
provider observations remain unchanged. A transaction emits an isolation audit
while moving the settled claim into the hold and acquiring the next claim.

The next operation must be disjoint from every review hold. Admission, pending
selection, status projection and transactional claim acquisition use the same
scope validation. Duplicate, missing, altered or malformed scope fails closed.
The queue skips blocked entries so an unrelated entry can proceed. No old review
is converted to success, and no old provider PUT is retried.

New claims have `scopeVersion: 1`. Automatic isolation additionally requires
`settledAt`, written only after the provider runner has returned or thrown.
An external recovery that merely marks an active claim for review does not prove
that its writer has ended and does not enable automatic isolation. A caught
provider exception records a durable review operation; unrelated future work
can proceed while the uncertain cells remain blocked. Login failures occurring
before claim acquisition still reach review after three attempts, including
when an unrelated settled review exists.

For `sync_pending` operations, `line-channel-actions` status adds:

- `dispatchStatus`: `queued`, `running`, or `blocked_by_review`.
- `blockingReason`: null for queued/running; otherwise
  `reviewed_operation_overlap`, `review_scope_unavailable`, or
  `review_isolation_required`.
- `queuedAt`: the original operation creation timestamp.

Terminal operations omit these fields. No other operator's identifiers or
operation details are exposed. New independent previews/confirmations refuse a
blocked request with `409 LINE_CHANNEL_REVIEW_BLOCKED` before storing an operation
or receipt. An existing idempotent receipt remains recoverable without replay.

## Controlled legacy transfer

Deploying this code does **not** release a historical claim that lacks the new
settlement markers. The operator-only `scripts/reviewed-channel-transfer.mjs`
reads a bounded JSON manifest from stdin; credentials stay in memory. Its fields
are `runtimeEnv`, `propertyId`, `targetOperationKey`, `expectedClaimId`,
`expectedInventoryVersion`, `expectedCells` (roomId/date/desired) and `reviewReason`.
The target must be an existing pending `provider_only` operation.

The tool obtains a fresh complete GET of the old claim's exact cells itself;
it does not accept provider observations from the manifest. A partially open
old scope may be isolated because its entire scope remains under review. That
observation is retained as isolation evidence, never accepted completion proof.
One compare-and-set transaction validates the exact claim, inventory version,
target and scope again, stores the review hold and audit, then acquires the
original target operation's active claim. Cron cannot take a different job
between isolation and acquisition. The standard runner observes, writes only
unsatisfied target cells once, and verifies fresh readback. Already-correct target
cells need no PUT. Repeating the transfer after the state changes is refused.

The existing `recover-channel-claim` helper remains unchanged. Its exact claim
comparison prevents an old recovery from clearing a newly acquired claim.
Neither helper is an instruction to replay the old uncertain operation.

## Verification and rollout boundary

New regressions first failed against the old behavior. Synthetic coverage includes
same-room/different-date and same-date/different-room progress; overlapping
requests; active and externally reviewed writers; malformed/altered holds;
immediate/cron contention; old recovery versus the new claim; immutable old
booking/fence/operation evidence; bounded authentication failure; and explicit
legacy transfer with complete, stale, incomplete and concurrently changed evidence.
Local verification and release evidence are recorded with the associated PR.
Synthetic tests are not live provider acceptance.

Coordinate the paired GCO status release and backend source with other maintainers.
Keep the historical claim unchanged through staging and promotion; inspect exact
current target and old-scope readback before the separately authorized transfer.
Verify the original operation key and exact target cells after completion, along
with preserved OS state and old review evidence.

**Rollback:** once a review hold exists, do not roll back to a backend that cannot
read and enforce `channelReviewHolds`. Stop new confirmations and use a compatible
forward fix or compatible rollback. Never erase a review hold, claim, operation
or booking fence to make a rollback pass.
