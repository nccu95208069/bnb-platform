# Guest name remarks
- Authorized Sheet name projection now also returns `guest_remarks` with kind, label and matched source. Original `guest_name` is retained in full; no destructive name cleaning or sheet writes.
- Recognizes extra bed, explicit +N people, travel card (國旅/國旅卡), subsidy (國旅補/國旅補助), receipt and crib. These are distinct requests, not eligibility/payment/fulfilment statuses. Common negated/cancelled phrases are not emitted as positive requests. Unrecognized text stays in the original.
- Month shows one short label on one-day segments, two on longer segments, plus remaining count. Only lanes with remarks grow. Week/day wrap all labels; detail shows full original name field above operations.
- Uses existing platform palette foreground/borders. Remarks are private and available to authorized no-price viewers, like names. Not included in anonymous stored monitor snapshots. Name-only edits are projected from the current authorized source read.
