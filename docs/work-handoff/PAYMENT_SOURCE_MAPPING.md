# Payment source mapping for the isolated pilot

Status: inspected evidence and implementation proposal, **not an approved production data dictionary**. On 2026-09-05 the owner stated that the production payment table and stable order IDs were unconfirmed and directed work to isolated tests.

## Observed sources

The handoff ZIP manifest contains 18 hash/size entries; all matched. The ZIP's product DOCX is byte-identical to the separately supplied DOCX. Only structural workbook information was used; private rows and screenshots are excluded from source control and test fixtures.

| Source | Observed structure | Meaning for this work |
|---|---|---|
| Anonymized seed `DB_Orders` | Order/property IDs, channel, guest display, state, stay range, room/stay/night counts, currency, total/paid/balance/status, external IDs, grouping/source/quality columns | Candidate normalized order representation; seed semantics are not proof of real receipts |
| Seed `DB_Stays` | Stay/order/property IDs, room, date range, nights, accommodation amount, state and source rows | A full stay is separate from a nightly booking segment |
| Seed `DB_RoomNights` | Room-night/stay/order/property IDs, room/date, nightly amount, occupancy/payment state and source references | Do not record the same order payment once for each nightly segment |
| Seed `DB_Payments` | Payment/order IDs, amount/currency/type/method/status, received date, source and note | Production uniqueness, timestamps, reversals and receipt evidence remain unconfirmed |
| Legacy normalized `訂房紀錄` | 12 columns from unique row ID through notes | Existing `sheets_sync.py` reads these rows; it does not write a formal payment ledger |
| Private original workbook | Operational/calendar and other financial/experiment sheets | No approved payment write direction or row-version strategy established in this task |
| Existing API `Booking` | `sheet_row_id`, optional order/external IDs, nightly rate, payment flag, guest/stay details | Lacks tenant/property keys, payment transactions and expected versions; unsafe as the new write target |

## Pilot mapping and non-assumptions

| Concept | Isolated contract | Production decision still needed |
|---|---|---|
| Scope | Explicit tenant + property on every record and FK | Stable mapping to real Sheet and workspace property |
| Order | One scoped ID for one complete single-room stay | Multi-room/group/move handling and canonical real IDs |
| Money | Positive whole TWD integers; totals derive from stored receipts | Supported currencies, decimal precision, fees, additions, refunds, OTA payouts |
| Payment | One immutable receipt per ledger row, timestamp with timezone, initially unreconciled | Distinguish estimated/opening receipts from actual bank/card evidence |
| Version | Integer revision plus comparison against the checked snapshot | Detect manual Sheet edits; atomic compare-and-write/CAS semantics |
| Idempotency | Scoped instruction key and payload fingerprint | Durable external payment key and read-after-timeout deduplication |
| Source freshness | Five-minute snapshot limit in isolated tests | Real freshness SLA, reconnect behavior and synchronization direction |
| Confirmation | Direct modification off by default; unexpected deposits require confirmation | Final owner-approved amount/risk matrix |

## Actual write directions

```text
Existing operational Sheet -> legacy read-only sync -> legacy bookings -> current UI prototype

Synthetic fixtures -> isolated order snapshots
                           |
               check -> append payment + audit -> check
                           |
                    persistent Mission result

No edge connects the isolated write path to the operational Sheet or public UI.
```

## Required evidence before production writes

1. Approve stable tenant/property/room/order mappings and full-stay grouping.
2. Inspect the live Sheet's columns, formulas, validations, derived reports and manual changes with authorized read access.
3. Confirm where one real receipt is created, how it is identified, and how corrections/refunds are represented.
4. Agree the single authoritative write direction, version/locking mechanism, duplicate retry behavior, external timeout recovery and backup/reconciliation procedure.
5. Implement and verify final authoritative Sheet readback after each payment; never use the local ledger alone as evidence of completed operational registration.

The Sheet remains the operational source of truth. Neither the private evidence nor this isolated PostgreSQL pilot approves moving that responsibility into the product database.
