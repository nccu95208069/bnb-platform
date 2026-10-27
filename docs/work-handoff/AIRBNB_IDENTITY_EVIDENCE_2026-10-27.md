# Airbnb group identity enrichment — 2026-10-27

The owner requested tracing five imported Airbnb room records to original mail or platform evidence and filling only confirmed order numbers. The records originated without an OTA number; this is separate from the previously fixed null-update identity loss.

The reservation confirmation, cancellation of the former reservation, and current authenticated Airbnb reservation establish one active whole-property reservation. Keep the five existing room records and source links. Do not merge bookings or replace the immutable imported rows. Guest identity, reservation codes, private evidence, and manifests are excluded from this repository.

`iron-gate/scripts/enrich-airbnb-group-identity.mjs` generates a default-rollback maintenance transaction from a private, operator-reviewed manifest. It requires five distinct room records for the same guest and stay, blank original identifiers, aligned source links, no payment events, complete before-images, and confirmation/cancellation evidence. The transaction locks the expected property version, rejects an existing occurrence of either reservation number, and verifies every target and link exactly. A drift on any target rolls back all five.

The booking changes are current platform/order identity, booking version, and a private identity-enrichment marker. Link applied versions advance together; source versions, original rows, dates, room occupancy, amounts, receipt histories, channel operations, and all other bookings remain intact. One property version increment and five audit/outbox events record the repair. Replaying the original manifest fails closed without another mutation.

The calendar previously discarded the legacy payment reference and normalized booking date whenever current source metadata existed. The runtime now recognizes the exact version-bound enrichment marker and retains those labels only when the original room record, dates, platform, group reference and amount still match. Later booking mutations invalidate the marker. The marker is never projected to API callers, and money permission remains required for the reservation/payment references. Deploy this compatibility change before applying the enrichment.

The verified platform payout differs from the existing internal room allocations. Record that difference in restricted audit evidence and report it to the owner; this identity repair does not change money or invent a receipt.

Validation includes a red/green calendar projection regression, redaction and stale-marker checks, real PostgreSQL rollback, late-target drift, duplicate links, reservation collision, exact post-state, five audit events, and replay refusal. `IRON_GATE_IDENTITY_TEST_URL` must point to a dedicated local `iron_gate_identity_test` database. Required repository CI runs before merge. Runtime release, live application and readback evidence belong in the associated PR without private identifiers.
