# Sweetfun LINE read-only pilot release record

No LINE credential or proof secret has been issued by this change. Production
LINE reads and all LINE booking mutations remain disabled.

## Prepared release unit

`scripts/stage-sweetfun-line-read-grant.mjs` accepts a mode-0600 private JSON
manifest, the existing private Supabase admin connection JSON, and a new
private output path. The manifest contains `projectRef`, `propertyId`,
`workspaceId`, `expectedVersion`, fresh UUIDs for `credentialId`, `grantId`
and `clientId`, one `groupId`, the exact `actorIds` allowlist, and an
`expiresAt` within 30 days. The script checks authority epoch 1, the exact
property version, active Sweetfun source grant, six room IDs, local-only
channel mode, and absence of another active LINE credential. It then stages
only `booking:read` with the minimum display fields and writes the random
bearer token and separate operator-proof secret to an exclusive mode-0600
file. It prints no secret. A failed or unknown commit must be resolved by
reading the credential row before any retry.

## Owner-approved pilot sequence

1. Confirm the intended LINE group and staff IDs from the live Cloud Run
   allowlists. Refresh the private manifest's expected inventory version
   immediately before staging. Keep its identifiers and output outside Git.
2. Stage the grant, distribute the token to Secret Manager and the separate
   proof secret to the Iron Gate runtime, then verify the exact credential
   hash, grant, expiry and active status through the admin connection. No LINE
   write action is part of this grant.
3. Build from the two reviewed PR commits, deploy a zero-traffic Cloud Run
   candidate, and call the protected `/internal/iron-gate-line-readiness`
   endpoint. Verify a revoked actor, another group, wrong property and stale
   epoch are denied before moving traffic.
4. Enable `IRON_GATE_LINE_READ_ENABLED` for one group only. Check a real
   all-source room-night response and a scoped LINE direct-order read, while
   Gmail source receipts and OFFLAND continue normally. Unsold local nights
   must never be described as OwlNest sale-ready.
5. Roll back the read pilot by disabling the Cloud Run flag and revoking the
   one LINE credential. This does not change bookings, source links, channel
   mode or OwlNest stock.

The GCO repository's release rules require explicit owner authorization for
production configuration, credential staging and deployment. This document
is a prepared review record, not that authorization.
