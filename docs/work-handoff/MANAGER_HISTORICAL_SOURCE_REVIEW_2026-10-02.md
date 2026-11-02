# Historical pending sources and web dismissal — 2026-10-02

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

The incomplete-review fallback now explains that the system could not verify its
sources and retains the task, without asking the owner to open the conversation
or repeatedly press the same action. Viewing history alone never changed the
review builder's activation cutoff.

Initial web action release `2d188d7` completed Next.js/TypeScript production build
and was promoted as `dpl_2ycSjZn7KrwJSXk5iK2PttN3Fmf3`. The primary domain was
checked against this exact deployment. The final copy follow-up is below.

Final web release `af43393` passed scoped syntax/ESLint and its Next.js/TypeScript
production build; `dpl_8G9bd4xskuprzQuKsgQB8nt8HRph` is Ready and promoted at
`sweetfun-os.vercel.app` (exact deployment inspected). No tests were run.

At 14:36 Taipei the normal queue scan rebuilt the reported card as version 5,
including the two historical question sources. The normal web handled action
committed at 14:37:24, with four source IDs and two selected obligations in the
authoritative audit. Read-only inspection confirmed both obligations DISMISSED,
zero runtime pending/attention/incomplete items, and unchanged inbound revision.
After the 14:37 background sync the manager displayed zero pending tasks. Older
unreviewed pre-activation input remains intact in the generic conversation flag;
the scoped manager audit closes only the owner's reviewed current turn.

A different guest sent new input at 14:37:32, after the reported turn was closed.
The next scan correctly showed that one new task while the recovered conversation
remained absent. The previously observed zero count is time-specific, not a claim
that subsequent guest input stays hidden.
