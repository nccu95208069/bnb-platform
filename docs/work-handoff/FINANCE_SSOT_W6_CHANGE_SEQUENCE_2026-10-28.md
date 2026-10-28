# W6 finance change sequence and ledger snapshot contract

Migration `iron-gate/sql/015_finance_change_sequence.sql` adds a property-local
`finance_change.change_seq`, an event-to-change link, and one canonical Sheet
outbox row per accepted finance change. The command, receipt, event link and
outbox row commit in the same property transaction. A successful retry reads
the original receipt and does not allocate another sequence. The new Sheet
outbox consumer must select `change_seq IS NOT NULL`; older per-event rows
with a null sequence remain as legacy evidence and must not be dispatched a
second time. No projection worker or production writer is enabled here.

## Ledger API

`GET /v1/properties/{propertyId}/finance/ledger` and the import ledger accept
`from`, `to`, `limit` (1–100), `cursor`, and `as_of_change_seq`. The dates filter
immutable `effective_on`. The first page may omit `as_of_change_seq`; use its
returned value on **every** later page, passing `next_cursor` without changing
the date filters. An invalid or future sequence is rejected. Each response has:

```json
{
  "events": [{ "id": "...", "change_seq": 42 }],
  "next_cursor": "...",
  "as_of_change_seq": 42,
  "current_change_seq": 43,
  "unsequenced_event_count": 0
}
```

The sequence fields are JSON safe integers. `current_change_seq` can advance
between pages; `as_of_change_seq` stays at the requested pin. A pinned read
includes only events accepted at or before that sequence and derives document
status, document version, current actor/reason, and evidence level as of the
same sequence. `as_of_event_id` is retained for older clients but is only the
last event on that page and is not a snapshot token. Other finance read
endpoints include their transaction's `as_of_change_seq` for freshness, but
only the ledger endpoint currently supports a historical pin.

Accepted finance receipts also contain `as_of_change_seq`. If a caller sends
`origin_request_hash` as a lowercase 64-character SHA-256 hex digest, command
and operation receipts echo it. The caller must compare the echoed digest and
stable request key when recovering an unknown HTTP result.

`GET /v1/properties/{propertyId}/bookings/{bookingId}/finance` additionally
returns `legacy_payment_review_required` (boolean) and
`unmapped_legacy_payment_events` (integer). They count legacy booking
`paymentEvents` that lack a verified same-property ownership mapping, including
malformed IDs. `card_payment_review_required` and
`unmapped_card_done_results` separately flag Card Done results without a
same-property `sweetfun_card` ownership mapping. The broader
`legacy_payment_review_required` is true for either condition. A new LINE
booking with no legacy payment or Card Done results returns false and zero
for these fields, even though the general `review_required` may remain true
because its remaining due is unknown. New LINE ledger receipts do not create
legacy booking payment events. Connectors must still check their own pending
or unknown source operations separately.

## Existing shadow rows and release gate

Migration 015 serializes against property writes and assigns deterministic
`legacy_baseline` changes to all existing document revisions and current
non-cash finance rows. It links pre-existing events to their document-revision
change and queues one canonical Sheet projection per baseline change. Rows
without a historical timestamp are ordered before timestamped rows, then by
source identity. This is a migration ordering, not a claim about the original
order of historical plan or catalog edits. Earlier versions of mutable
non-cash rows cannot be reconstructed from current-state tables.

The ledger still returns any event that remains unsequenced, with
`change_seq:null`, and reports `unsequenced_event_count`. Daily reconciliation
must fail closed when that count is nonzero. If an older writer adds such rows
after migration, pause that writer, retain a private source snapshot, review
the affected revisions and outbox rows, then reapply migration 015 to append
baseline changes. Verify the count is zero and compare event IDs, amounts and
source identities before accepting the day's evidence. W7 still requires
source-by-source reconciliation and review of historical non-cash versions
and legacy outbox rows; a zero unsequenced count alone does not approve cutover.
