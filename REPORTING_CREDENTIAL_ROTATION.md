# Dashboard reporting credential issuance and rotation

The dashboard uses a dedicated `origin=service` credential for
`GET /v1/properties/:propertyId/business-report`. Its only action is
`booking:aggregate`, with `fields: []`. It cannot read raw bookings or mutate
bookings, inventory or payments. Keep the token in the dashboard server's
`IRON_GATE_REPORT_TOKEN`, never in browser code.

## Existing operating model

`PostgresCredentialDirectory.issue` and `validateGrant` enforce a future ISO UTC
expiry no more than 30 days away. `lookup_credential` accepts only active,
unexpired credentials. Neither directory has a renewal API. Existing cutover and
LINE staging scripts issue credentials once. The Vercel cron only dispatches the
channel worker; repository CI/CD does not schedule credential rotation.

The runtime role cannot enumerate, issue, renew or revoke credentials. Keep that
boundary: do not put the administrator connection in Vercel or add credential
administration to the channel worker. Existing infrastructure does not currently
rotate this token automatically. The operating owner must schedule rotation
before expiry; a 28-day credential with rotation at least 7 days before expiry
leaves time to verify and recover. The dashboard's `IRON_GATE_REPORT_EXPIRES_AT`
must match the credential's exact expiry so its warning remains useful.

## Preflight and inputs

Before a release, resolve the actual `iron-gate-green.vercel.app` alias and record
its deployment ID. A latest deployment with `target=production` may still be an
unpromoted candidate. Preserve the alias's current source and existing release
gates; this reporting repair does not activate LINE consumer flags or perform
real booking operations. Recheck the alias immediately before assigning domains.

Use Node.js 22 and the repository's installed dependencies. Run the helper from
an operator environment holding the existing administrative connection. It uses
the same approved Supabase project, pooler, `postgres` identity, hostname-verified
TLS and bundled CA as the existing staging tools. No schema migration is needed.
Private inputs must be regular owner-only files; output must be a new file in an
owner-only directory, for example one created by `mktemp -d`.

The issuance manifest contains only these keys (replace the synthetic IDs and
expiry with values checked for the intended property):

```json
{
  "projectRef": "brcszrkwkgiwatrxevkf",
  "credentialId": "33333333-3333-4333-8333-333333333333",
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "propertyId": "22222222-2222-4222-8222-222222222222",
  "authorityEpoch": 1,
  "expiresAt": "<future ISO UTC timestamp within 30 days>"
}
```

Use a new UUID for each new credential. Keep that UUID for recovery if an attempt
fails. `clientId` is fixed to `sean-dashboard-business-report`, `subjectId` to
`service:sean-dashboard`, and scope is fixed to the reporting action. The helper
rejects caller-supplied actions or field grants.

The separate administrator JSON file follows the existing staging format:
`projectRef` and `url`, containing the authorized project pooler URL with
`sslmode=verify-full`. Obtain it through the established private operator process;
do not paste it into source, logs, command arguments or a runtime environment.

## Issue and activate

1. Confirm the reporting endpoint is present on the intended backend deployment.
2. Create the private manifest, administrator file and output directory. Set
   files to mode `0600` and the directory to `0700`.
3. Run the issuance helper with file paths only:

   ```bash
   node scripts/reporting-credential.mjs issue /private/path/new-manifest.json /private/path/admin.json /private/path/new-report-token.json
   ```

   It locks only the property metadata for a short transaction, confirms the
   workspace/property/current positive epoch and `readOnly=false`, then calls
   `PostgresCredentialDirectory.issue`. It reads back the grant/hash/expiry and
   writes the generated token to the owner-only output file before committing.
   Standard output contains metadata and the output path, never the token.
4. Through the existing authenticated deployment tooling, update the dashboard's
   server-only `IRON_GATE_REPORT_TOKEN` from the private output, and set
   `IRON_GATE_REPORT_EXPIRES_AT` to its exact expiry. Preserve the intended
   `IRON_GATE_REPORT_BASE_URL`, `IRON_GATE_REPORT_PROPERTY_ID` and
   `IRON_GATE_REPORT_AUTHORITY_EPOCH`. Deploy a candidate using those settings.
5. Verify the candidate can fetch a current report: `meta.source=iron-gate`, the
   expected epoch, `readOnly=false`, plausible known totals and visible quality
   warnings. Verify the signed-in dashboard displays both properties and that
   unauthorized dashboard requests remain blocked. Promote only after these
   checks. Do not print the token, authorization header or full report payload.

The old credential remains valid during this sequence. Its validity allows the
previous dashboard deployment to remain recoverable while the replacement is
verified. Never extend the old expiry or add a raw-booking action to fix access.

## Retire the previous credential

After the replacement dashboard has passed verification, run a separate revoke
step using the **previous credential's manifest**, not the newly issued one:

```bash
node scripts/reporting-credential.mjs revoke /private/path/previous-manifest.json /private/path/admin.json
```

The helper requires the exact expected report grant and refuses OS, LINE,
source, finance or broader service credentials. It calls the existing directory
revoke method, reads back `active=false`, and supports safe repeated revocation.
An expired previous manifest is allowed for cleanup; revocation does not issue
anything. Record the new credential ID, expiry, dashboard deployment ID and
successful verification in the private operations record. Retain the minimum
private recovery material required by the existing operator policy.

## Failure recovery

If issuance reports an error, inspect only the matching credential ID's
`active`, `expires_at` and minimal scope metadata through the administrator
connection before retrying. A database commit may succeed even if its response
is lost; the helper intentionally preserves any private output file. Do not
blindly generate another UUID, overwrite the output or revoke the previous
credential. If the intended credential exists and the saved output is complete,
verify it; if it exists but the token cannot be recovered, revoke that exact
report credential before issuing a replacement.

If dashboard verification fails, keep the previous dashboard and credential
available while correcting the new configuration. If the property authority
epoch changes, review the source switch and issue a new bounded grant for the
verified current epoch; do not bypass the epoch check.

## Verification

```bash
node --test tests/reporting-credential.test.mjs
```

The offline tests exercise the real credential directory against a synthetic
query adapter, including expiry, scope, private output, rollback/readback,
ambiguous commit recovery, and scoped revocation. They do not create production
credentials. A real issuance is complete only after its database readback and
the dashboard's authenticated report check succeed.
