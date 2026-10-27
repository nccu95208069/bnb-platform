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

### Runtime-only one-time transfer

When the application database secret is available only inside Vercel, use
`POST /api/channel-review-transfer` on a deliberately activated deployment. This
route is absent by default (`404 disabled`), also on preview deployments. It
reuses the existing application database role and broker credentials inside the
runtime. Do not export the database secret or substitute an administrative role.

Enable only a single production candidate using deployment-level `vercel deploy
--env` values; do not add these values to persistent project environments:

- `IRON_GATE_PRODUCTION_CHANNEL_REVIEW_TRANSFER_ENABLED=true`
- `IRON_GATE_CHANNEL_REVIEW_TRANSFER_TOKEN_SHA256`: lowercase hex SHA-256 of a
  fresh independent 32-byte random token encoded as 43-character base64url.
- `IRON_GATE_CHANNEL_REVIEW_TRANSFER_INTENT_JSON`: exactly `propertyId`,
  `targetOperationKey`, `expectedClaimId`, `expectedInventoryVersion`,
  `expectedCells`, `reviewReason`, `issuedAt`, and `expiresAt`. Times use canonical
  ISO UTC strings and cover at most 15 minutes. The property must equal the
  configured channel property. The intent contains no runtime secrets or provider
  observation.

The ordinary production and channel-worker enable flags must also be true. Keep
the plaintext review token only in process memory or a private mode-0600 temporary
file; never in source, deployment arguments, logs or evidence artifacts. Only its
hash and pinned intent are deployment configuration. The dedicated hash may not
match the cron, authentication-broker or alert token. Authentication compares
fixed-length SHA-256 digests in constant time.

Build and verify a second candidate from the identical commit with this route
disabled. Release the truthful GCO status behavior first, promote the active
backend candidate, then send exactly one request with the dedicated bearer token,
JSON content type, no query parameters and body `{}`. The HTTP body cannot choose
or broaden a target, change runtime configuration, or supply provider evidence.
Expiration is checked before and after reading the bounded body, before provider
access, and again inside the claim transaction after the old-scope GET. An expired
transfer cannot archive the old claim or acquire a target claim.

Whether the request succeeds, fails, or has an unknown network outcome, promote
the prepared disabled candidate immediately and verify `404 disabled`. An unknown
outcome is followed only by read-only inspection of the original operation and
provider state; do not resend the transfer. Duplicate or concurrent submissions
cannot acquire a second target writer: the original claim/version/target compare
and set permits a single acquisition, and completed or reviewed targets cannot
be replayed. The active candidate's authorization also expires after 15 minutes,
including on its immutable deployment URL. Do not roll back to code that lacks
review-hold enforcement.

Responses expose only `state`. `200 sync_verified` is terminal success;
`409 review_required` is unresolved; `409 state_moved` refuses stale, expired or
conflicting execution; `503 unavailable` requires inspection, not a retry. The
route never retries the operator call. Runtime setup is shared with the existing
stdin CLI through `src/channel-review-runtime.mjs`; the CLI may optionally supply
`expiresAt`, while the HTTP route always requires the bounded deployment intent.

## Verification and rollout boundary

New regressions first failed against the old behavior. Synthetic coverage includes
same-room/different-date and same-date/different-room progress; overlapping
requests; active and externally reviewed writers; malformed/altered holds;
immediate/cron contention; old recovery versus the new claim; immutable old
booking/fence/operation evidence; bounded authentication failure; and explicit
legacy transfer with complete, stale, incomplete and concurrently changed evidence.
Runtime route regressions cover disabled gates, independent token authentication,
expired or broadened manifests, forbidden HTTP input, slow-body expiration,
expiration during provider GET and inside claim acquisition, and two simultaneous
authorized requests followed by a duplicate with only one target provider write.
Local verification and release evidence are recorded with the associated PR.
Synthetic tests are not live provider acceptance.

## Release status

PR #102 merged as `c32f089c19db3446f771151d28ad143afb516a36` after all four CI jobs
passed. Released source `cc52400528132e84e64aa5e158ae3ef0aa1d58d4` includes the
coordinated payment compatibility change. TypeScript check/build and the full
backend suite passed: 430 passed, 10 skipped. The signed synthetic cross-service
contract also passed with OS state unchanged.

The optional runtime operator remains disabled by default. Exact deployment,
private business identifiers, runtime observations and live acceptance evidence
are retained outside this public repository. The historical review protection and
compatible rollback requirements below remain part of the shipped contract.

Coordinate the paired GCO status release and backend source with other maintainers.
Keep the historical claim unchanged through staging and promotion; inspect exact
current target and old-scope readback before the separately authorized transfer.
Verify the original operation key and exact target cells after completion, along
with preserved OS state and old review evidence.

**Rollback:** once a review hold exists, do not roll back to a backend that cannot
read and enforce `channelReviewHolds`. Stop new confirmations and use a compatible
forward fix or compatible rollback. Never erase a review hold, claim, operation
or booking fence to make a rollback pass.
