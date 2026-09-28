# Customer manager: separate booking and message actions

Latest owner decision supersedes dual native labels: defer LINE OA emulator tags.

- Confirm booking only creates the canonical Daili association and structured
  stay label, with the existing Sheet writeback result reported independently.
- Approve message only sends the reviewed text; it never creates a binding.
- Both actions have separate approval, operation IDs and durable receipts.
- Post-binding message approval checks the active canonical link and stay dates
  and room against its receipt, as well as the current conversation stamp.
- Pending old combined identity cards are invalidated. Newly collected proposals
  display two explicit buttons. Confirming preserves the unsent reply draft.
- Native tag outbox is disabled, no new host tasks are dispatched, and local
  companion stopped. Existing canonical associations remain intact.
- Binding failures/unknown results never imply a sent guest message. Native label
  code remains dormant for a future explicit product decision.
- No test guest messages, booking approvals or native label writes were executed.
  Static lint/build passed; live end-to-end writes await owner use.
