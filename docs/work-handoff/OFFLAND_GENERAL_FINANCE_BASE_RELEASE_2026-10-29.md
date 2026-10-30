# Offland new general finance release — 2026-10-29 to 2026-10-30

**Current state, 2026-10-30: Offland's new general income and expense paths are live in OS and the existing LINE OA, backed by one Iron Gate ledger.** The production scope admits only Offland in `general_only` mode, with two connectors and dedicated grants. The latest independent database readback still found zero new-ledger documents, events and request receipts: no real entry has yet been accepted or reconciled. Old Offland entries remain in their current source and are marked `not_imported` in OS; old booking balances remain under review. Sweetfun's historical settlement and source cutover stay disabled.

## Production execution checkpoint

### Coordinated activation and post-live checks — 2026-10-30

The guarded LINE cutover completed after a five-second settle and a full
305-second drain. At 04:22:43–04:23:24 UTC, the candidate reached 100% of
traffic, its 23 release boundaries passed independent verification, and all
seven ingress sources were restored. The first attempt had failed closed on
the controller's own asset probe; its journal rolled back to the guarded
revision before the corrected retry. LINE booking and payment writes remain
blocked. The LINE source and release record are on draft PR #119; the
production image is pinned to source `61ab8cfef64f0b4536b85ee781320233cfda0142`.

After LINE activation, the exact OS source commit
`ad405cb94b1980d5dd02b279bf1ca0f4d950bafd` was deployed as
`dpl_3KJ7mhazgRhytZpcLgw9jWV9Bjbe` on `sweetfun-os.vercel.app`.
Production readback showed `OS_OFFLAND_FINANCE_SSOT_ENABLED=true`,
`OS_OFFLAND_FINANCE_GENERAL_ONLY=true`,
`OS_OFFLAND_FINANCE_HISTORY_STATUS=not_imported` and
`OS_OFFLAND_FINANCE_WRITES_PAUSED=false`. The owner-signed-in finance page
showed the old-history notice and empty new ledger without an error. A general
expense preview was dismissed before commit; the authenticated pending route
returned `{"pending":null}`. Anonymous finance GET, preview POST and finance
POST returned 401. No test transaction was committed.

Independent Iron Gate readback at 04:35 UTC found the Offland scope, connectors
and grants unchanged, with zero finance documents, events and request
receipts. Both sheet-monitor crons ran on the live OS deployment; a
`private_snapshot_write` calendar read timeout at 04:35 recovered with every
phase `ok` at 04:36 and 04:37. The first real owner entry still needs its
request receipt, ledger entry and both client readbacks reconciled. OS source
PR #120 remains open and draft, with four passing CI checks.

### Earlier OS paused production checkpoints — 2026-10-30

The `sweetfun-os` production-target candidate `dpl_3toAjEXu2cxR2GwwGR8o4ab1s1XR`
(`https://sweetfun-51u48ebcc-sweetfuns-projects.vercel.app`) is `READY` and
has no production alias. Vercel's 109 listed frontend source-file hashes match
the local `offland-finance-integrated-20261029/frontend` tree exactly; the
frontend tree is identical at commits `e6bd21f` and `9a45097`. Vercel created
this candidate after its production environment received
`OS_OFFLAND_FINANCE_SSOT_ENABLED=true`,
`OS_OFFLAND_FINANCE_GENERAL_ONLY=true`,
`OS_OFFLAND_FINANCE_HISTORY_STATUS=not_imported`, and the Offland finance grant
secret; `OS_OFFLAND_FINANCE_WRITES_PAUSED=true` was already present. No secret
value was read back. The primary `sweetfun-os.vercel.app` alias still points to
`dpl_3W4VppGcsuatojUYonzTbj7V63BT` at this checkpoint.

The paused guard runs before Offland finance POST and preview submissions;
GET/read and legacy archive routes remain available. Authenticated candidate
HTTP acceptance remains pending: the protected-deployment fetch connector was
rejected by automatic approval review because it would create or reuse an
external share link, and an ordinary anonymous request returned `UNAUTHORIZED`.
No share link was created for this check. Promotion, production alias/cron
readback, signed-in reads, denial checks and final activation are still separate
gates. Existing production cron schedules include Offland sheet monitor and
finance sheet bulk; confirm their deployment binding after promotion rather
than assuming `--skip-domain` updated it.

The owner-authorized paused promotion subsequently assigned the exact candidate
to `sweetfun-os.vercel.app`; alias readback identifies
`dpl_3toAjEXu2cxR2GwwGR8o4ab1s1XR`, and the four nonsecret Offland finance
settings above still read back unchanged, including `WRITES_PAUSED=true`.
Runtime logs show the Sweetfun and Offland sheet-monitor cron requests reached
this deployment after promotion. The signed-in Vercel Cron Jobs panel is
enabled and lists all nine paths and schedules from the deployed `vercel.json`;
it does not expose per-job deployment IDs, so the remaining seven cron runtime
bindings have not been independently observed. An authenticated Offland finance GET reached
the new OS route but returned `UNAVAILABLE`. Concurrent Iron Gate finance
reads ended with a PostgreSQL connection termination. The connection-limit
finding and corrected deployment are recorded below. This first promotion did
not satisfy acceptance or activate writes.

The failed GETs at 02:52 and 02:54 UTC correlated with Supavisor
`too many connections for role iron_gate_prod_app` (SQLSTATE 53300). The role
limit is four, while the Offland view previously opened ledger, five catalog
reads and booking reads concurrently. Commit `ba05c46` on draft PR #120 now
serializes only Offland's Iron Gate finance view reads; the focused route test
asserts one active backend request and passes, as do TypeScript, changed-file
lint, production Webpack build and CI run #486. The matching fixed-source
production-target candidate `dpl_EpPY98XEmzrwhMQeLQ8q8LeewfCx`
(`https://sweetfun-33vtddmjm-sweetfuns-projects.vercel.app`) built `READY`;
all 223 Vercel-listed source-file hashes match its frozen source archive. It
was promoted to `sweetfun-os.vercel.app`, with alias and paused environment
readback. Authenticated owner GET then succeeded with `ssot_enabled=true`,
`history_status=not_imported`, `writes_paused=true`, `general_only=true`,
`entries=[]` and version zero; booking rows remained ineligible for finance
commands and retained historical-review status. The finance home also rendered
the paused and missing-history notices and a zero new-ledger total. Both
Sweetfun and Offland sheet-monitor cron logs subsequently targeted this new
deployment. The database role-cap increase
remains an unapplied contingency, not a production change. OS/LINE write
activation and a first-real-entry readback remain separate gates.

The serialized read avoided the connection-limit error but the finance home
still took at least 22 seconds on a repeat load. Draft PR #120 head
`16d0759` replaces it with one request-local budget of three concurrent
Iron Gate fetches across ledger, catalog and both booking passes. The same
booking checks remain in place, Sweetfun's path is unchanged, and a backend
fetch error still returns `UNAVAILABLE` without a legacy money write. Thirteen
targeted tests, TypeScript, changed-file lint, a production Webpack build and
CI run #489 pass. Matching fixed-source candidate
`dpl_61AzYBCMe7DHHHguRcsf8KC57JCL`
(`https://sweetfun-rjpiycovn-sweetfuns-projects.vercel.app`) is `READY`
without an alias; all 223 Vercel-listed source-file hashes match the frozen
archive. The reviewed `iron_gate_prod_app_connection_limit_12_20261030`
migration was subsequently applied and read back in the existing Iron Gate
project: role OID 17768 has limit 12, with role attributes and membership
unchanged and no finance document, event or receipt. The exact bounded
candidate was then promoted to `sweetfun-os.vercel.app`; alias and deployment
readbacks agree, and the four Offland settings still include
`WRITES_PAUSED=true`. Authenticated latency, denial and first-real-entry
acceptance remain open. Offland writes stay paused.

The bounded candidate's authenticated finance GET then returned `UNAVAILABLE`.
Iron Gate request logs showed its first three reads succeeded, while four
queued reads returned 401: the request-local budget had waited *inside*
`fetch`, after OS created its five-second signed proof and network timeout.
There was no new database role-limit error. The production alias was restored
to the paused serial deployment `dpl_EpPY98XEmzrwhMQeLQ8q8LeewfCx`, and
authenticated GET succeeded in 23.0 seconds. No writer was opened.

Draft PR #120 head `ad405cb` moves the three-permit budget around each whole
Iron Gate call, so the permit is acquired before proof signing and timeout
creation. The regression advances a fake clock six seconds while calls queue
and rejects an expired proof; the corrected route still passes, along with
13 focused tests, TypeScript, changed-file lint, production Webpack build and
CI run #495. The frozen-source production-target deployment
`dpl_4i4dmwgNTN9Fv83J9C3iFCorqvPg`
(`https://sweetfun-3d0i8agy4-sweetfuns-projects.vercel.app`) built `READY`,
with all 223 Vercel-listed source hashes matching the archive. It was promoted
to `sweetfun-os.vercel.app`; alias and paused environment readbacks agree.
The owner-authenticated finance home rendered with the expected paused and
history notices, zero new-ledger totals and historical booking review. A
measured refresh completed in 15.48 seconds without an error; anonymous
finance GET returned 401 `UNAUTHORIZED`. Both Sweetfun and Offland
sheet-monitor cron logs targeted the corrected deployment; the Cron Jobs panel
lists all nine schedules but does not expose seven other per-job deployment
IDs. No Vercel finance runtime error cluster or error-level log was found in
the observation window. Offland writes remain paused pending coordinated LINE
cutover, denial readback and first real-entry acceptance.

On 2026-10-29, the owner explicitly approved the Offland-only general-finance release. The existing healthy Iron Gate Supabase project was read back with migrations 001–003, zero `finance_%` tables, zero SSOT finance credentials and zero nonlegacy finance actions before any change. Source-controlled migrations 005, 006 and 007 were applied in order and each migration record was read back. At that checkpoint the readback was 20 `finance_%` tables. The latest production readback after 020 found all 26 `finance_%` tables empty, zero finance connectors, zero finance documents and zero SSOT finance credentials. No finance writer has been opened.

Automatic approval review rejected the original migration 008 twice because its shared runtime role would gain finance table writes for any property context, broader than the approved Offland-only release. No alternate route was used. The owner chose to narrow the database write scope to Offland. The revised 008–018 passed local PostgreSQL scope tests and were applied to production in order; at that migration checkpoint the scope table was empty, so no new finance writer was active.

Migration 013 also granted the shared runtime role direct `SELECT` on `audit_log`, conflicting with Iron Gate's startup safety guard. The calendar dependency returned 503 until the emergency production migration `finance_audit_read_emergency_revoke_019` removed that grant and the same healthy backend artifact was restarted. Migrations 019 and 020 are source-controlled. Production readback immediately after 020 found `finance_activity_operations(uuid)` present, direct runtime `audit_log` SELECT absent, and zero scope rows, connectors, documents or events. No finance source or credential was provisioned during that repair. Later provisioning and the paused OS promotion are recorded above.

## Server-side scope

The new Offland OS and LINE credentials are property- and connector-bound and carry `financeGeneralEntriesOnly:true`. Iron Gate accepts only unallocated `property_receipt` with `receipt_purpose=other` or `expense_paid`; it rejects lodging, deposits, extras, OTA payments, processor fees, refunds and booking allocations. Amend/void is limited to an active general document in that connector that has never had a booking allocation. A marked OS credential may create only `custom_*` categories through `finance:plan`; account, recurring, payout and operational-status writes are denied. The existing calendar and booking credentials remain separate. A later historical import into either general connector requires a fresh correction-scope review.

The revised database policy starts with no property admitted for finance writes. At the coordinated cutover, an administrator seeds only Offland in `general_only` mode in the same transaction as its two source connectors. Restrictive row policies must then reject finance writes for every other property and reject non-general event kinds, booking allocations and unrelated plan/import tables even if the shared runtime role holds table privileges. A future property or broader finance mode needs its own explicit authorization and database change.

The private grant package is prepared offline from a current Offland property/workspace/epoch readback and fixed connector candidate. Its issuance SQL holds only token hashes, rechecks live authority and connector configuration, rejects an existing finance document or duplicate active subject, and reads back each issued grant. The optional LINE grant also rechecks the active current OA group/actor authority. Plaintext credentials stay in private `0600` files and are delivered only to the respective service secret stores. The package expires after 28 days and needs planned renewal.

## Release sequence

This is the original ordered gate plan. The 2026-10-30 checkpoint above records
which gates have since occurred; a successful promotion does not itself open
finance writes or satisfy live read acceptance.

1. Fix the reviewed code commit and require passing CI and local finance authorization, PostgreSQL, and frontend checks. The local PostgreSQL 15 fixture applied 001–003 and 005–018 and exercised finance commands under `iron_gate_runtime` RLS. A second run of hardened migration 015 added no new rows. The guarded empty-only rollback was tested on a separate disposable database, including refusal when any finance data or new finance credential exists; pre-existing `card:sync` and `finance:ledger` credentials do not prevent removal of an otherwise unused schema.
2. Confirm the destination is the existing Iron Gate Supabase project and Vercel project. Production has migrations 001–003 and 005–020, with no finance connectors or documents. Skip 004: it changes a specific Sweetfun OS credential and is not a schema dependency. Migration 020 has been applied and read back; before enabling finance commands, recheck its activity function, the lack of direct runtime `audit_log` SELECT, and the existing booking/calendar authority contract. Migration 015 briefly locks `property_state`; its 5-second lock and 60-second statement timeout bounded the production attempt.
3. Stage and inspect an exact Iron Gate production build before assigning its production alias. Configure a private finance preview secret and `IRON_GATE_FINANCE_COMMANDS_ENABLED=true` only when the schema and the activity read repair are ready. Keep native-ledger and historical-settlement flags off. With no finance connector or credential active yet, the new command routes cannot write. Verify the existing booking API and unauthorized finance requests before promotion. Read back both `iron-gate-green.vercel.app` and `iron-gate-sweetfuns-projects.vercel.app` aliases separately; the latter currently points to an older deployment. Verify the `/api/channel-worker` cron is bound to the promoted build, because an earlier staged deployment left it on the old build.
4. After pausing old Offland OS and LINE finance writes and draining uncertain requests under their original keys, in one guarded transaction admit only Offland to the database finance write scope in `general_only` mode and provision its `os_manual` and `line_finance` connectors with their reviewed source-instance IDs, enabled and effective at the coordinated new-entry start. Keep `os_legacy_payment` disabled. Read back the sole scope row, connector configuration history and zero documents. Issue and read back the dedicated general-only grants only after those checks, then deliver each token through its service's secret configuration. No grant is published in Git or chat.
5. With the old writers still paused, verify the new ledger is empty and source identities match, then enable the new general-entry routes for OS and LINE at the coordinated start. Old booking-linked receipts remain blocked. Exercise authenticated reads, preview without commit, denied booking receipt and cross-property access, and the OS/LINE UI with flags closed to ordinary writes until the shared start. Do not create a fake financial transaction for a smoke test. Observe the first real entry through request receipt, ledger and both client readbacks.

The guarded cutover described above supersedes the earlier unpinned-controller and guard-only preparation state. The separate retained-order feature has its own release and acceptance record; its finance behavior is not part of this cutover.

## Recovery and open boundaries

Before any new connector, SSOT credential or finance row exists, the guarded empty-only rollback can remove the new schema; it refuses after any such state appears. Existing legacy `card:sync` and `finance:ledger` grants are preserved by that rollback. After the first accepted new-ledger operation, pause new writes and reconcile forward from Iron Gate receipts rather than returning to the old OS/LINE writer. Old Offland finance and booking balances still require their own source-by-source reconciliation before they can be imported or treated as paid/unpaid. Sweetfun W7 keeps its separate final-watermark, historical-cash and owner cutover gates.

The planned remote PG17 restore-drill migration was rejected by automatic approval review because that externally managed test project had not been explicitly authorized as disposable. No remote test database was changed. Migration 020, the scoped grants and the general-entry runtime activation are now applied as recorded above; the first real entry and historical import remain separate acceptance work.
