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

## Reviewed SQL transport for an administrator without a connection file

`iron-gate/scripts/prepare-offland-line-booking-sql.mjs` prepares private SQL for
the existing administrator SQL transport. It does not connect to a database,
issue a credential, install a secret, or deploy a service. The connected
PostgreSQL lifecycle CLIs above retain their behavior. Both paths reuse the same
pure grant/activation planners and grant shape validation.

From the `iron-gate` package, using Node 22 and installed locked dependencies:

```sh
node --experimental-strip-types scripts/prepare-offland-line-booking-sql.mjs snapshot \
  /private/tmp/release/manifest.json /private/tmp/release/snapshot.sql
node --experimental-strip-types scripts/prepare-offland-line-booking-sql.mjs stage \
  /private/tmp/release/manifest.json /private/tmp/release/snapshot.json /private/tmp/release/stage
node --experimental-strip-types scripts/prepare-offland-line-booking-sql.mjs activate \
  /private/tmp/release/activate-manifest.json /private/tmp/release/fresh-snapshot.json /private/tmp/release/activate
node --experimental-strip-types scripts/prepare-offland-line-booking-sql.mjs revoke \
  /private/tmp/release/revoke-manifest.json /private/tmp/release/fresh-revoke-snapshot.json /private/tmp/release/revoke
node --experimental-strip-types scripts/prepare-offland-line-booking-sql.mjs verify \
  /private/tmp/release/activate/plan.json /private/tmp/release/activate/committed-readback.json
```

Every input must be a regular private file. Outputs are exclusive new files or
directories under the real private temporary directory, with mode 0600/0700;
existing packages and symlink inputs are refused. `snapshot` emits a repeatable
read, read-only query. Execute it against the exact reviewed `manifest.projectRef`
and save its single `snapshot` object without changing the embedded raw JSONB
text. The snapshot contains private records and credential hashes; never print
it or add it to source control. It expires after fifteen minutes.

Stage and activation manifests have the earlier stage fields plus `requestKey`
and `authorizationRef`. Revocation uses only `projectRef`, `propertyId`,
`workspaceId`, `expectedVersion`, `credentialId`, `grantId`, `requestKey` and
`authorizationRef`. Each new action needs a new request key. Activation must use
the same staged grant IDs, actors, group and expiry; refresh its property version
and snapshot after any intervening legitimate write. Revocation accepts an
expired credential and current authority changes, with fresh complete evidence.

Staging prepares one random bearer in `credential.private.json` before writing
SQL. That file explicitly says `prepared_not_applied`: it is not proof that a
credential exists. All other artifacts contain only its hash. Keep the file when
an apply response is uncertain, and inspect the exact existing request/credential;
never generate a replacement token just to retry. The package includes
`apply.sql`, `dry-run.sql`, `readback.sql`, a token-free `plan.json` and file hashes.
The executable SQL contains the target grant and full-scope hashes, not guest
records or unrelated credential contents.

Apply/dry-run use SERIALIZABLE isolation, a locked property row, bounded lock and
statement timeouts, exact database-native state/occupancy/credential hashes and
relational metadata. A short credential-table lock prevents grant phantoms.
Staging rejects another unexpired booking grant even if inactive. Stage and
activation also reject any other credential using the dedicated grant ID,
including finance credentials or another property's grant: the proof router
selects a dedicated identity by grant ID as well as credential ID.

Activation and revocation derive only the two channel policy keys and the next
inventory version from the locked database state. They update only the exact
credential's active flag and verify every remaining state/credential/occupancy
value before recording the immutable request audit. Audit failure rolls the
whole operation back. No schema, RLS, role, booking, occupancy, finance or source
data mutation is generated.

An exact recorded request returns its original receipt before freshness/version
checks; an altered request with the same key is rejected. Replaying activation
after a later revoke cannot revive the credential. Readback distinguishes the
historical receipt from current state and credential match flags.

Run `dry-run.sql` first, then the exact reviewed `apply.sql`, then run
`readback.sql` independently and save its single `verification` object. The
verifier recomputes the immutable plan identity and compares current hashes to
the actual committed audit. It refuses `dry_run` and `apply_postcommit` outputs,
missing receipts, changed expected fields and expired stage/activation grants.
Recovery queries remain available after plan/credential expiry. No dry run or
historical receipt alone is a current activation proof.

Isolated PostgreSQL verification covers rollback/commit, inactive denial,
full-state and occupancy drift without a version increment, credential
hash/grant/expiry drift, concurrent staging, global grant-ID collisions, lost
acknowledgement recovery, later-revoke replay, audit failure, state/audit
corruption, and preservation of another property and existing financial rows.
Deployment and production activation still require their own release evidence.
