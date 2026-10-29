# Offland LINE booking without an external inventory provider

Owner steering: finish the Offland LINE registration, amendment and cancellation
flow against the same Iron Gate orders used by OS. The earlier implementation
required an OwlNest channel even for Offland, whose authoritative channel mode is
`none`. This candidate adds an explicit provider-free booking policy. It does not
activate a production writer or represent an OwlNest synchronization.

## API and authorization

The existing create, amendment, cancellation and atomic bulk-cancellation APIs
accept `channelPolicy: "provider_free"`. Both preview and commit require:

- a current, property-scoped LINE credential and verified staff/group proof;
- the stored `lineProviderFreeEnabled: true` marker and booking manage-all actions;
- a writable property at the credential's authority epoch;
- server-only `channel.mode: "none"`, `ready: false`, no channel grant or enabled
  source readback, `lineBookingMode: "provider_free"`, and
  `lineBookingGrantId` equal to the exact dedicated LINE grant;
- the signed preview, exact input/policy/operator/grant, inventory version and,
  for existing orders, booking version.

The policy is not a caller-asserted channel bypass. Omission remains unavailable
on a property without an OwlNest channel. It cannot downgrade a Sweetfun manual
or provider workflow. No-price/contact-limited credentials cannot create fields
outside their grant. Availability still includes every canonical booking and
all manual/source/provider fences in the property. Provider-free mode cannot
acknowledge a manual closure or call inventory controls.

`GET line-capabilities` now reports `bookingMode` and `canReadAll` as well as the
existing fields. Booking modes are `provider_free`, `manual`, `provider` or
`unavailable`; write flags reflect actual authority/configuration readiness.
Provider-free previews explicitly return `bookingMode: "provider_free"`.
Successful booking receipts return `operationState: "not_required"` and null
`operationKey`; authoritative booking readback returns
`channelSyncState: "not_required"`. There is no OwlNest operation, LINE pending
channel work, or claim of external synchronization. Same-key retries and request
recovery return the original durable receipt.

Only confirmed native orders with no net receipts and no unresolved channel or
source state can be amended/cancelled through this lane. Imported external orders
have incomplete historical payment evidence and return
`LINE_PAYMENT_REQUIRES_REVIEW`; they are not silently treated as unpaid. Retained
orders, including a retained lifecycle that was rescheduled, stay in their OS
workflow. Existing Q/J source aliases and delayed-source protection remain intact.
No historical payment migration, source takeover or refund operation is added.

## Dedicated proof configuration

Offland booking operator proofs use a separate secret from the shared LINE/OS
keys. The stored dedicated grant is never allowed to fall back to the shared key.
The verifier routes only the exact credential, grant and property tuple. The
preview token remains an opaque server-signed value using the existing preview
signing secret; the caller does not sign or decode it.

Production settings are:

- `IRON_GATE_PRODUCTION_OFFLAND_LINE_BOOKING_PROOF_SECRET`
- `IRON_GATE_PRODUCTION_OFFLAND_LINE_BOOKING_CREDENTIAL_ID`
- `IRON_GATE_PRODUCTION_OFFLAND_LINE_BOOKING_GRANT_ID`
- `IRON_GATE_PRODUCTION_OFFLAND_LINE_BOOKING_PROPERTY_ID`

Preview/private processes use the same suffixes after `IRON_GATE_`.
`IRON_GATE_PRODUCTION_LINE_PROOF_SECRET` (or private equivalent) remains required
for preview signing. Set the complete tuple before starting a candidate. The
booking secret must be 43 base64url characters and distinct from the selected
LINE and OS keys. If `OFFLAND_LINE_FINANCE_PROOF_SECRET` is explicitly configured
under that same prefix it must also differ. GCO independently rejects reuse of
its finance proof secret. Production never reads Preview credentials. Partial or
malformed dedicated configuration closes startup; absent configuration leaves
all marked dedicated booking credentials denied.

## Source-controlled credential lifecycle

No script in this implementation has been run against production.
`iron-gate/scripts/stage-offland-line-booking-grant.mjs --stage` takes a private
manifest, an existing private admin connection file, and a new private temporary
output path. The manifest contains project/workspace/property IDs, exact inventory
version, credential/grant/client UUIDs, the exact active Offland source account,
LINE group and actor allowlist, `channelPolicy: "provider_free"`, and an expiry no
more than 30 days away. It rejects provider-enabled properties or existing writers.

Staging creates an **inactive** credential; it cannot authenticate. The token is
written once to a mode-0600 private file, while only its hash is stored in the
credential table. Property configuration, bookings and occupancy remain unchanged.
If COMMIT acknowledgement is unknown, preserve the file and inspect the exact
credential instead of issuing another token. Existing unexpired staged or active
writers require explicit resolution before staging another.

`iron-gate/scripts/switch-offland-line-booking-grant.mjs --activate` takes the same
private manifest plus a fresh `requestKey` UUID and a bounded `authorizationRef`,
and the private admin file. It verifies the inactive stored grant and expiry,
current source/property/version, absence of another active writer, and occupancy
integrity. In one serializable transaction it enables the exact credential, sets
the provider-free property policy, increments inventory version and appends an
immutable audit receipt. Readback must match the exact state, credential and
unchanged occupancy before COMMIT. Audit failure rolls the entire switch back.

`--revoke` uses a fresh request key and current expected version. It disables the
exact credential, removes only its matching provider-free policy, increments the
inventory version and writes the audit in the same transaction. It neither deletes
orders nor alters source/financial/provider work. An expired credential can still
be revoked. Retrying the same switch manifest returns its historical receipt with
`alreadyApplied: true`; it cannot repeat activation after a later revoke. Always
read current capabilities/credential status after recovering an uncertain switch.

The activation helper is part of source control; do not replace it with ad-hoc
production SQL. Normal runtime credentials remain unable to issue credentials.
Release orchestration must install the dedicated secret tuple, stage/review the
credential, deploy the paired backend/GCO candidate, execute an authorized switch,
and verify signed capabilities before routing Offland booking traffic. Revocation
is the supported fail-closed rollback. Existing booking receipts remain available
to the original authorized actor only while the credential is active.

## Verification and release boundary

Final candidate validation: `npm run check` and production TypeScript build pass.
The full Iron Gate suite passes **541 tests**, with **20 unrelated specialized
PostgreSQL suites skipped** because their separate finance/import/shadow databases
were not configured. The standard PostgreSQL repository and retained-order suites
and both new provider-free PostgreSQL cases did execute successfully.

Independent review reproduced a dedicated-grant escalation when property channel
configuration drifted to ready OwlNest and the caller omitted the provider-free
policy. The fix binds the dedicated marker to provider-free policy on every booking
path and excludes that marker from provider capabilities. The same independent
reproduction now reports unavailable capabilities and zero provider operations.


Isolated tests cover provider-free create/amend/cancel/bulk, canonical readback,
signed policy/operator binding, unrelated-property rejection, stale version and
configuration refusal, whole-property conflicts, paid/imported/retained refusal,
Q/J delayed-source protection, duplicate recovery and no provider side effects.
Dedicated verifier tests cover missing configuration, exact tuple selection, no
fallback, key separation and production/preview isolation.

The paired GCO acceptance runner uses its real Python client and Engine over a
loopback HTTP listener with the production grant authenticator and dedicated
proof router. Operator and preview keys deliberately differ. It checks create,
lost-response receipt recovery, amendment and cancellation, cross-property and
inventory refusal, three submissions/receipts, and zero provider/pending work.

Real local PostgreSQL tests additionally check one last-room winner, reconnect
and receipt recovery, scoped runtime isolation, inactive credentials, atomic
activation rollback, activation/revocation readback, immutable audit and unchanged
imported orders/occupancy. The optional provisioning test requires a disposable
loopback PostgreSQL database explicitly selected by
`IRON_GATE_PG_PROVISION_TEST_URL`; it never reads production configuration.

This document records engineering and isolated verification only. Production
credential issuance, secret installation, activation, deployment and a real LINE
operator acceptance remain the coordinated release's separate evidence.
