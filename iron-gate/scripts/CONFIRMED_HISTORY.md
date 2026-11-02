# Owner-confirmed historical recovery

`prepare-confirmed-history.mjs` prepares a private SQL transaction for historical
stays whose provider record and actual occupancy have been confirmed by the owner.
It can recover a missing external booking or extend one unpaid legacy booking to
include previously omitted nights. This is an offline maintenance tool, not a
mail-processing route or a deployment requirement.

Use an exact private manifest with original-mail and provider evidence hashes,
owner decision reference, current property version and full state hash. Keep all
guest data, manifests and generated SQL outside Git. Inspect existing source
identities, quarantined imports and same-room occupancy before preparing a plan.

Run `node scripts/prepare-confirmed-history.mjs dry-run PRIVATE_MANIFEST` and
execute the generated transaction; it ends with ROLLBACK. Resolve every validation
failure before preparing `apply`. Both versions acquire locks and reject state
drift, duplicate identities, existing repair audit records, occupied rooms,
manual closures, review fences and pending operations. A review fence must not be
removed just to make the transaction succeed: inspect its original evidence and
obtain the missing owner decision first.

Creates have no payment events. Extensions preserve the existing booking except
stays, total and version, and mark its old import link diverged to prevent a stale
source from replacing the owner-confirmed history. Original import snapshots,
payment data, existing receipts, quarantines and fences remain intact. The tool
adds room-night occupancy, normal booking outbox events and an audit entry with
the owner evidence. It does not dispatch channel actions or send messages.

After commit, independently read the targets and occupancy, then reconstruct the
old state by reversing only the intended changes and compare its full hash.
Verify the exact month-level room-night and room-fee differences in the live
report. Do not interpret a provider's paid marker as a new internal payment.

Replays fail closed with `HISTORY_REPAIR_ALREADY_RECORDED`; use audit readback to
verify completion rather than issuing a second repair key. A successful historical
repair does not establish complete mailbox coverage or resolve other quarantined
source rows.
