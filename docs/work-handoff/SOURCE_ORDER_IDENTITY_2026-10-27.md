# Preserve source order identity during amendments

An existing Booking order became unresolvable by card sync after a valid source amendment supplied a null OTA number. The source link still identified the exact booking, but `applySourceEvent` replaced its current identity with null. The frozen import retained the original number.

For an exact, current source link, null or omitted identity labels now mean absent evidence: retain the established platform and OTA number. On the first amendment of a legacy import, preserve the identity only when every frozen row agrees. Existing current metadata takes precedence over the frozen import. An explicitly different platform or number requires `SOURCE_IDENTITY_MISMATCH` review. New-order verification, source-version checks, review fences and fee freshness are unchanged.

## Controlled repair

`iron-gate/scripts/repair-source-order-identity.mjs` generates a private transaction for one owner-approved missing Booking identity. It requires exact property, inventory and booking versions, an aligned non-diverged source link, the original OwlNest key, unanimous frozen OTA identity, the unchanged total, and no existing card or payment results. It rejects collisions and duplicate repair request keys. The transaction locks the property, restores only the OTA field, advances booking/link/inventory versions together, and writes audit/outbox evidence. Occupancy, source version and financial records are preserved.

The private manifest and generated SQL must stay outside Git. Run `dry-run PRIVATE_MANIFEST` first (transaction rolls back), then `apply PRIVATE_MANIFEST` only after fresh validation. Read back the identity, aligned source version, unchanged occupancy and receipt counts before using the ordinary signed card-sync workflow. A failed card result creates no receipt; replay must leave the failure result and all existing receipts unchanged.

## Validation

Regressions cover omitted/null labels, exact legacy identity, conflicting legacy rows, current metadata precedence, explicit identity conflict, signed OwlNest amendments with no channel work, and source update → failed card sync → replay. The three original identity regressions failed before the fix and passed afterward. Type checking, build and the full IronGate suite pass; database-dependent tests require the separate local test database. The guarded transaction was exercised with rollback against the exact authorized record, and a wrong OTA number was rejected. Live repair, deployment and reconciliation evidence belongs in the associated PR; production identifiers remain private.
