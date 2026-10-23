# Source facts release gate

This branch is an isolated Iron Gate deployment candidate. The companion Gmail
writer and OS calendar changes are reviewed separately. No deployment or data
repair follows from merging or testing this branch.

The source event accepts a proven whole-order amount, currency, platform and
external order number. An absent amount remains unknown. Calendar projection
exposes the whole-order amount only to a principal with the `money` field grant;
it does not split a multi-room amount into invented room prices. The metadata
repair endpoint requires the same source grant, the current source version,
booking version and inventory version. It rejects historical imported rows,
changed room state, conflicting facts and active channel mode.

Before a production release, pin the reviewed commit and verify the existing
runtime configuration, current source links, pending work and rollback target.
Deploy a zero-traffic candidate, test authentication and projection boundaries,
then coordinate the approved ingress pause, drain, traffic change and restore.
Run the companion Gmail repair preflight against each exact original message;
apply only entries still matching their source receipt and occupied room nights.
Verify each new receipt and scoped lookup, then confirm owner and no-price OS
views. A code rollback does not undo a source facts repair.
