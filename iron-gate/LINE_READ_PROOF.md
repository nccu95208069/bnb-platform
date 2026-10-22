# Sweetfun LINE read boundary

The LINE read API is implemented but remains disabled until a separately
authorized release. It does not enable LINE booking writes or OwlNest changes.

## Credential and proof

- Issue a distinct, expiring credential with `origin: "line"`, one property and
  workspace, an opaque UUID `grantId`, exact `lineGroupId`, an explicit
  `lineActorIds` allowlist (at most 32), only
  `actions: ["booking:read"]`, and only the fields the group needs. The current
  grant validator rejects LINE create, amend, cancel, payment, source and
  channel permissions. Keep the token hash in the credential directory and the
  token only in the Cloud Run secret mount.
- Configure a separate 43-character base64url LINE proof secret (32 random
  bytes encoded) in the Iron Gate
  Production environment as `IRON_GATE_PRODUCTION_LINE_PROOF_SECRET` and in the
  Cloud Run secret mount as `IRON_GATE_LINE_PROOF_SECRET`. Preview uses
  `IRON_GATE_LINE_PROOF_SECRET` in the Iron Gate Preview environment. Never use
  the OS proof secret or Gmail source token for this purpose.
- The Cloud Run signer first requires the verified LINE webhook's allowlisted
  actor and group. Every GET carries `x-iron-gate-line-proof`: an HMAC-SHA256
  signature over the credential, workspace, property, grant, group, actor,
  issue/expiry time, exact method, path/query, idempotency header and body
  hash. The maximum proof lifetime is 15 seconds. Iron Gate refuses a missing,
  expired, altered or mismatched proof, or an actor removed from the current
  credential allowlist, before constructing the actor principal.
- The response includes `lineScope.grantId` for LINE reads. The caller rejects
  a different scope. List and inspect expose only `source=line` bookings with
  `sourceKey=line:<grantId>`; OTA/Gmail bookings cannot be enumerated. The
  separate `/availability` read returns local room-night states across all
  booking sources without guest or order details. An `unsold` cell is never
  reported as externally sale-ready.

## Release gate

Do not provision or route production LINE reads until the group, employee
allowlist, credential, expiry, scope fields and two separate secret mounts have
been checked. The zero-traffic Cloud Run candidate must pass its protected
`/internal/iron-gate-line-readiness` probe and an authorized group must pass a
real read. Cross-group, revoked-token, expired-token and removed-employee
attempts must fail. Removing an employee from the credential's
`lineActorIds` takes effect on the next Iron Gate request; also remove the
employee from the Cloud Run revision whitelist at the next rollout.

The proof is short lived but has no durable replay store. The current LINE
grant is therefore read only. Booking writes need a separate versioned
confirmation protocol, durable request identity and channel readback before
their grant shape can be expanded.
