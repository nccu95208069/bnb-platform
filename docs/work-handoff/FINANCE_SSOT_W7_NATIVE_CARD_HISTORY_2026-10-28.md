# W7 native and Card historical candidate — 2026-10-28

This is a disabled, local engineering candidate. No production source was read,
no production ledger was changed, and no finance writer flag or cutover time was
enabled. It does not satisfy the W7 per-property cutover gate.

## Scope and exact identity

`iron-gate/src/finance-native-history.mjs` derives native payment history and
Sweetfun Card results from the same Iron Gate `property_state.state_json` that
still serves the existing booking API. The planner emits only safe IDs, amounts,
dates, source fingerprints and hashed source actor references. It does not copy
guest details, card numbers, expiry data, original actor IDs or raw Sheet rows.

The source-specific service requires a property-scoped `finance:import` principal,
the matching registered connector, an unchanged authority epoch and a connector
whose `cutover_at` is still null. Preview is read only. Commit takes the
`property_state` row lock, repeats the preview under serializable isolation,
requires its exact preview hash, writes missing rows in one transaction and
reconciles them again before returning. It never updates booking JSON or booking
versions. There is no HTTP route or automatic production runner for this service.

- Native `source_record_id` and event ID are the original immutable payment-event
  UUID. Native receipts and refunds retain the exact booking allocation and
  refund-of-event link.
- Card `source_record_id` is the booking UUID. Each original result fingerprint
  is a revision in original order. Fail is a `card_fail` revision with no event
  and zero cash. Done uses the original deterministic payment-event UUID once,
  creates one `sweetfun_card` ownership row and adds an alias from the native
  connector's event ID to that Card document. It remains operator-attested;
  it does not imply bank settlement.
- A native refund of a Card receipt requires the Card receipt to be imported
  first. An unresolved refund link, duplicate event ID, changed Card fingerprint,
  mismatched amount/booking, duplicate ownership, orphan ledger document,
  conflicting alias or any other source receipt on an already paid booking
  blocks the import. The adapter never chooses a likely match automatically.
- Every preview row reports expected cash effect, current cash effect and the
  difference. A zero difference with any issue is blocked. A zero difference
  after synthetic import proves only that those fixture records matched.

Migration `016_finance_historical_actor.sql` adds nullable
`finance_revision.source_actor_ref`. The regular `actor_ref` remains the
authenticated import credential. Generic reviewed shadow imports may provide a
safe opaque `source_actor_ref`; native/Card imports derive a SHA-256 opaque ref
from the original Iron Gate actor ID. Ledger and activity reads expose this
separate historical field. It is source evidence, not an authorization claim;
the imported source snapshot and actor mapping still need private review.

The generic shadow import path deliberately remains limited to
`os_manual`, `os_legacy_payment` and `line_finance`; it cannot mint native/Card
receipts with new UUIDs. The new service is the dedicated source-specific path.

## Isolated verification

- PostgreSQL 15 disposable database, migrations 001–003 and 005–016 (004 is a
  production-specific credential grant): native/Card synthetic import tests
  pass, including Fail → Done, original ID/ownership/alias, native and Card
  refunds, no booking mutation, exact retry, disabled cutover and unresolved
  cross-source overlap.
- Generic finance-command PostgreSQL regression passes with importer actor and
  historical source actor checked separately. The three pure planning fixtures
  and Iron Gate TypeScript check pass.

## Remaining W7 gates

1. Obtain a current private W0 source snapshot with property, connector and
   watermark identity. Inspect every real native payment event and Card result,
   including the ten Sweetfun Done IDs and two Fail results observed in the
   October 28 aggregate. Aggregates alone cannot prove event ownership.
2. Review exact cross-source aliases and ownership against OS Redis, LINE
   Firestore, Sheet and Card sources. Resolve all duplicate money, unknown
   outcomes, orphan events and mismatched original booking IDs before an import.
3. Import source-specific OS and LINE historical revisions, statuses and rules
   through their separate guarded paths. The native/Card adapter does not
   transform those sources or establish actual OTA payout or bank evidence.
4. Reconcile the accepted ledger with pinned source snapshots per event and per
   property, verify the live Sheet projection and private backup, then decide a
   future per-source cutover. Keep all current finance writer flags off until
   those checks pass and the owner approves the actual cutover.
