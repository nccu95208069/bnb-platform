# Offland new general finance grants

`scripts/prepare-offland-general-finance-grants.mjs` prepares an **offline,
private** grant package for new Offland income and expenses. It does not issue a
credential, change a connector, deploy code, or enable a writer. Do not reuse the
Sweetfun grant script: its property, connector and subject checks are fixed to
Sweetfun. This package deliberately excludes `finance:import`, `finance:link`,
`payment:write`, `card:sync`, and any native-ledger capability.

## Required private inputs

Pass four arguments: the existing Offland connector candidate JSON, a current
authority readback JSON, a **new** private output directory, and optionally a
verified LINE group authority JSON. All input files must be mode `0600` under
`/private/tmp` or the system private temporary directory. The output directory
must be a direct child of one of those directories and must not exist.

The authority readback has this shape and must be compared with current Iron
Gate `property_state` and the existing Offland calendar grant before preparing
the package:

```json
{
  "project_ref": "brcszrkwkgiwatrxevkf",
  "property_id": "<current Offland property UUID>",
  "workspace_id": "<current Offland workspace UUID>",
  "authority_epoch": 1,
  "read_only": false
}
```

When LINE group and operator authority is independently verified, the optional
LINE input must contain `existing_credential_id`, `existing_property_id`,
`existing_grant_id`, `group_id`, and `actor_ids` from one **active existing**
Sweetfun Iron Gate `line-staff-manage-all` grant for the same OA group. The
issuance SQL rechecks that exact source property, credential, group and actor
list. The source grant may belong to a different workspace; it proves only the
established OA group and approved actor list. The **new** grant is bound to the
current Offland workspace and property, and Iron Gate still requires a current
Offland operator proof with that workspace, property, group and allowed action
on every request. The Sweetfun proof cannot authorize an Offland write. Do not
invent actor IDs, reuse an unverified group, or copy a plaintext token from the
existing grant. Omit this input until the LINE team has verified it; the script
then prepares only the OS grant.

The generated `os.json` and optional `line.json` contain new plaintext tokens;
`issue.sql` contains only their SHA-256 hashes and full scoped grant metadata.
Keep all package files private. The generated grant expires after 28 days and
must be renewed before expiry. The package is bound to the candidate's exact
Offland `os_manual` or `line_finance` source instance, current workspace and
authority epoch, and includes `financeGeneralEntriesOnly:true`.

## Issuance gate

An administrator may apply `issue.sql` only after migrations 005–018 are in
place, the backend candidate and its general-entry restriction are verified,
and each selected connector is enabled with an effective `cutover_at`. The SQL
checks the live property authority, connector source/account/scope, existing
LINE group evidence when present, duplicate active subjects, credential expiry
and full readback in one transaction. Each selected connector must have **zero
existing `finance_document` rows** when the new-entry credential is issued.
This prevents a general-only launch grant from attaching to historical money
already imported through the same source instance. A later historical import
into either connector requires a fresh correction-scope review and new grant
plan; this package must not be silently reused. Reapplying the **same** private
package after an uncertain issuance only verifies the identical active
credential and may succeed even if later new entries exist. It fails closed if
any value changed.
The runtime database role cannot issue credentials.

Set `IRON_GATE_FINANCE_COMMANDS_ENABLED=true` and a private
`IRON_GATE_FINANCE_PREVIEW_SECRET` of at least 32 characters in the Iron Gate
runtime before enabling either client. `IRON_GATE_FINANCE_NATIVE_LEDGER_ENABLED`
and historical settlement remain off for this new-entry release. The OS grant
is delivered only to `IRON_GATE_OFFLAND_SSOT_FINANCE_GRANT`; the LINE grant is
delivered only to its property-scoped LINE service configuration. Neither grant
is put in Git, a log, a chat message, or an HTTP response. After OS and LINE
readback and cross-property denial checks pass, their own flags may be enabled.

The existing `os_legacy_payment` connector remains disabled. Old Offland
receipts, imported booking balances and historical imports are separate review
work; an empty new ledger is not proof of nonpayment. After the first accepted
new-ledger write, pause the new writer and repair forward on failure rather
than returning to the Redis finance writer.
