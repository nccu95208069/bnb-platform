# Independent LINE provider room controls — 2026-10-27

The owner requires OS order changes and LINE channel controls to be independent.
OS occupancy, manual blocks and deferred booking synchronization must not refuse
an explicit LINE OwlNest open/close command. A LINE provider command must not
change OS bookings or occupancy. This decision supersedes the earlier shared
inventory/booking-bound control policy for newly created LINE confirmations.
The OS desktop action-button work belongs to a separate task.

## Contract

`POST /v1/properties/:id/line-room-control-previews` accepts exact sorted `cells`
and `desired` (`open` or `closed`). `POST .../line-room-controls` requires the
same body, an idempotency key and the signed, unexpired preview. Authentication,
property/room scope, LINE operator/group proof, explicit inventory capability,
authority epoch, provider readiness and supported dates remain enforced.

The preview uses a separate signed audience; it does not depend on OS inventory
or booking versions. Confirmation appends a `controlMode: provider_only`
operation with null `bookingId`, an immutable receipt and audit. It neither
inserts an OS fence/manual block nor alters booking, source-link or inventory
versions. OS edits between preview, confirmation and verification do not change
the confirmed provider targets. The existing transactional property row lock
still serializes persistence even when inventory version is unchanged.

The shared worker starts immediately after durable confirmation. It checks
OwlNest before writing, skips cells already at the requested state and verifies
each exact room/date afterward. Independent close requires count 0 and locked;
independent open requires count 1 and unlocked. Zero inventory without a lock
does not prove manual closure. Existing provider `safe_stock_check=1` stays on.
PUT acknowledgement alone is not completion, and unknown outcomes never retry
PUT or release the existing dispatch claim automatically.

Status/receipt reads reuse `line-channel-actions` with the explicit control mode.
Independent status is restricted to its original LINE actor and grant. Historical
operations retain their original semantics. No migration, claim clearance,
historical replay or production business write is included.

OS booking synchronization flags remain as they were: independent controls do
not certify or complete an OS synchronization task. Actual in-flight/uncertain
provider work still holds the shared dispatch lock; OS occupancy itself does not.

## Verification and release boundary

The new tests first failed because the independent route/service did not exist.
Synthetic cases cover occupied/blocked/fenced nights, OS edits after preview,
unchanged OS state, replay, authorization, exact targets, expiry, an existing
unknown dispatch claim, already-closed no-op, zero-unlocked stock, incorrect open
count, incomplete provider snapshots and a lost write result.
Integrity checks count pending independent work without requiring an OS fence.
The existing explicit recovery tool can verify these operations by fresh exact
readback only, with the original claim ID; it never retries PUT. Negative controls
first reproduced an incorrect integrity alarm and blocked valid read-only recovery.

The paired GCO script `scripts/acceptance/line_independent_channel_contract.py`
runs the real signed Python HTTP client and LINE confirmation journal against
`iron-gate/tests/fixtures/line-independent-server.mjs`, a loopback-only server
using the actual authenticator, service and worker with synthetic provider data.
Close, open and already-open confirmation pass with two writes for three verified
operations, despite OS edits after each preview. OS data remains unchanged.

Final Iron Gate type checking, build and full regression pass: 323 passed, nine
database-environment tests skipped, zero failures. Frontend lint has zero errors
and seven existing warnings; the production Webpack build passes after allowing
its public font download. No frontend source changed. The paired GCO suite passes
6,310 tests with 11 deselected. Database integration requires its separate test
environment; this is not live OwlNest or phone acceptance.

Status: implementation candidate, not merged or deployed. Deploy this compatible
API before switching GCO to the new calls. Existing uncertain provider claims
remain protected and subject to release/recovery gates. No production settings,
data or notification targets were changed.

Rollback must stop new GCO confirmations first. Keep this Iron Gate version until
all `provider_only` work is verified and its claims resolved; an older worker does
not understand this persisted mode. Never roll back the worker over pending or
uncertain independent operations, or erase them to make a rollback pass.
