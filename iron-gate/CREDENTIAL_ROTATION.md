# OFFLAND calendar and source credential rotation

The OS calendar reader and Gmail order source use separate property-scoped
credentials. A stored credential is valid only while `active=true` and
`expires_at > now()`. The initial OFFLAND cutover issued seven-day credentials;
the calendar cannot recover from an expired credential by retrying. OS member
proofs are separate five-second request signatures, not renewable bearer tokens.

`scripts/credential-rotation.mjs` prepares an operator package for these two
capabilities. It does not contact a database, change environment variables,
deploy an application, or send a notification. The existing runtime remains
unable to issue, enumerate, extend, or revoke credentials. Administrator
credentials must stay out of Vercel and Cloud Run application runtimes.

## Scope and safety contract

- Supported inputs are the existing OFFLAND OS calendar grant (`booking:read`
  and optional `occupancy:aggregate`) and the existing `offland-calendar-sheet`
  source-only grant. Finance, LINE and reporting grants are rejected.
- The entire stored grant is copied, including any additional restrictions.
  Only `credentialId` changes inside the grant. The new token and expiry are
  separate credential fields; workspace, property, client, subject, epoch,
  actions, fields, source system/account and source grant remain identical.
- The previous credential must still be active, with exactly the expected
  expiry and grant. Expired active credentials can be replaced. Revoked
  credentials cannot be reactivated by this workflow.
- Every replacement has a fresh UUID, independent random token and future
  expiry no more than 30 days away. Prefer 28 days with a renewal review seven
  days before expiry. There is no in-place extension or indefinite credential.
- Property authority must still match the reviewed workspace/epoch and be
  writable. The package never updates property state, bookings, occupancy,
  payments, roles, grants, source links, or schema.
- Application is one serializable transaction. A bounded credential-table
  lock prevents competing packages from issuing duplicate replacements. All
  old grants and the property authority are rechecked inside that transaction.
- Replaying the same package accepts an already-issued credential only if its
  UUID, token hash, complete grant, exact expiry and active status match. A
  different active replacement for the same scope is rejected.
- Previous credentials remain unchanged until both consumers have passed their
  own authenticated verification. The helper intentionally does not retire them.

## Prepare a private package

Use the exact approved Supabase project `brcszrkwkgiwatrxevkf`. Create the
manifest and snapshot as owner-only regular files, mode `0600`. Never commit
either these inputs or the generated package. Use a new private output
directory; an existing package is never overwritten.

The manifest shape is:

```json
{
  "projectRef": "brcszrkwkgiwatrxevkf",
  "propertyId": "22222222-2222-4222-8222-222222222222",
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "authorityEpoch": 1,
  "replacements": [
    {
      "oldCredentialId": "33333333-3333-4333-8333-333333333333",
      "newCredentialId": "44444444-4444-4444-8444-444444444444",
      "expectedOrigin": "os",
      "expectedExpiresAt": "<exact old ISO UTC expiry>",
      "expiresAt": "<future ISO UTC expiry within 30 days>"
    },
    {
      "oldCredentialId": "55555555-5555-4555-8555-555555555555",
      "newCredentialId": "66666666-6666-4666-8666-666666666666",
      "expectedOrigin": "source",
      "expectedExpiresAt": "<exact old ISO UTC expiry>",
      "expiresAt": "<future ISO UTC expiry within 30 days>"
    }
  ]
}
```

These are synthetic IDs. Obtain actual old IDs, exact expiry and authority
from a metadata read, and generate the new UUIDs once. The exported
`rotationSnapshotSql(manifest)` produces a read-only snapshot query for the
selected property and old IDs. It returns property identity/epoch/read-only
state and complete selected grants, but no tokens, token hashes, guest data,
booking rows or financial data. Preserve the returned `snapshot` object as
JSON without changing its values. Preparation rejects snapshots older than
15 minutes; the live SQL additionally rechecks the important values.

```bash
node scripts/credential-rotation.mjs prepare /private/path/snapshot.json /private/path/manifest.json /private/path/new-rotation-package
node scripts/credential-rotation.mjs check-package /private/path/new-rotation-package
```

The output directory has mode `0700`; every file has mode `0600`:

| File | Purpose |
| --- | --- |
| `credentials.private.json` | Recoverable new plaintext tokens and destination identity metadata. Never display or send to chat. |
| `plan.private.json` | Exact old/new grants, expected expiries and new token hashes. |
| `dry-run.private.sql` | Same guarded insertion/readback as apply, then explicit rollback. |
| `apply.private.sql` | Guarded application, commit and combined metadata-only readback. |
| `verify.private.sql` | Independent readback of both new credentials. |
| `expiry-monitor.sql` | Read-only expiry metadata for active credentials of the selected property. |
| `receipt.json` | Package identity, credential IDs/expiries and file digests; no token values. |

The script saves and fsyncs all token material before an operator can apply
anything. Its stdout contains only package metadata. CLI errors use a fixed
safe message so a parser/driver exception cannot reveal private input.

## Apply and verify

1. Read back the actual production aliases and current consumer configurations.
   Confirm this repair is for the intended OFFLAND property and epoch. Do not
   use a different project or weaken deployment protection.
2. Run `check-package`. Execute the exact `dry-run.private.sql` with the
   established administrator SQL transport against the approved project. The
   expected final result is `dry_run_rolled_back`; no new credential remains.
3. Execute the exact `apply.private.sql` once. Its final result contains one
   row for each replacement. Require `replacement_matches=true`,
   `lookup_matches=true`, and `previous_unchanged=true`, with the reviewed
   expiry. Run `verify.private.sql` independently after any uncertain response.
4. Install each new token only in its original consumer's existing server-only
   secret/configuration. For the OS calendar grant, change `credentialId` and
   `token` together in `IRON_GATE_OFFLAND_CALENDAR_GRANT`; preserve all other
   values. The existing OS proof secret does not change. For the Gmail source,
   update only the selected OFFLAND source credential secret/version and its
   established runtime binding; do not change source grant identity or scopes.
5. Deploy/restart the intended consumers through the existing approved release
   process. A successful secret update alone does not update an existing
   deployment. Verify the logged-in OFFLAND calendar returns fresh data and
   that the source consumer can authenticate. Do not manufacture a booking or
   payment as a smoke test. Check failed source events during the outage and
   replay only through the established idempotent ingestion workflow.
6. Record the production deployment/revision, new credential IDs, exact expiry
   and authenticated checks in the private operations record. Retire the exact
   old credential only after both consumers are verified. Retirement requires
   its own guarded, metadata-verified operator step; it is not automatic here.

If COMMIT acknowledgement is lost, preserve the whole package. Query the
prepared new IDs using `verify.private.sql`; a matching result means the same
saved tokens remain recoverable. Never generate another UUID/token before
resolving the first outcome. If a new credential exists but token material is
lost, revoke that exact unused credential through the existing operator
process before preparing a replacement.

## Prevent another silent expiry

Run the metadata-only `expiry-monitor.sql` daily at **09:00 Asia/Taipei** using
the already available ChatGPT Automations/Supabase operator connection. Reuse
an existing credential-maintenance task when present. The task should check
this exact project/property, report every active credential that is expired or
within seven days of expiry, and include only origin, subject, credential ID
and expiry. It must not retrieve a token/hash or create credentials itself.

A concrete automation prompt is:

> Check the approved Iron Gate project and OFFLAND property using the stored
> read-only credential expiry query. Alert me when an active credential is
> expired or expires within seven days, with its consumer and Taipei expiry.
> Never print tokens, hashes, guest records or financial information. Do not
> rotate, revoke or deploy automatically; prepare the existing reviewed
> rotation workflow for the exact affected credential when action is needed.

This schedules the check, not token renewal. A maintenance owner must execute
the reviewed package and consumer verification before expiry. Fully automatic
renewal would require a separately designed and authorized credential-issuer
service with a narrow capability and durable delivery receipts. Adding a
database administrator secret to the OS or Gmail runtime is not an acceptable
substitute.

## Validation

```bash
node --test tests/credential-rotation.test.mjs
```

Where the execution sandbox prohibits Node child processes, the equivalent
`node tests/credential-rotation.test.mjs` runs the tests directly. Seven offline
tests cover exact scope preservation, future restriction preservation,
authority/revocation/expiry guards, stale/cross-project/duplicate inputs,
private durable output and replay refusal, tamper/symlink checks, and safe CLI
errors. The generated PostgreSQL must still pass its dry-run and independent
live readback; offline tests do not establish production success.
