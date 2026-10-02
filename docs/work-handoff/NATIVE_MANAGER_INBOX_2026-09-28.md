
## 2026-10-02 — historical pending sources and web dismissal

The backend review builder now includes exact historical source messages referenced
by pending obligations even when they predate bridge activation. Previously the
obligation IDs remained in the review while their messages were removed by the
activation cutoff, causing every explicit dismissal to fail the complete-review
guard. Conversation discovery still starts at activation; all tenant/conversation
and current-snapshot checks remain in place. Backend code: `1400b5f`.

The web manager now uses the same `no_reply` action as LINE for contract-v3 cards,
labelled 標為已處理. It shows 結案處理中 while the existing authenticated worker
saves the decision. Legacy host cards retain their existing takeover operation.
No action is automatically replayed onto an expanded snapshot. The owner's
requested conversation will be closed through its current normal application
control after deployment, then checked in the authoritative audit/runtime.

JavaScript syntax, scoped ESLint and diff whitespace checks passed. No tests were
added or run. Production build and observed outcome are recorded separately.
