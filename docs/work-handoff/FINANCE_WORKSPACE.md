# Finance workspace — 2026-09-08

## Owner scope and shipped routes

Home `/home` under the authenticated main layout replaces `/` redirect-to-calendar. Six module entries: 日曆, 對話, 攬客, 競品, 財務, 設定. Only calendar, finance and settings are enabled; the other three are explicitly planned and do not link to legacy subsystem functionality. Existing URLs remain compatible. Member management is linked under settings at `/settings/access` (existing `/access` retained).

Finance: `/finance` overview and `/finance/bookkeeping` monthly ledger. Month/property filters are URL-addressable and use browser history. Default current Taiwan month. Only owner/God/admin may access this initial finance workspace, enforced in page layout and every API call. Other roles retain existing calendar access, not global financial statements. No new membership privileges assigned.

## Accounting meaning

This is an operational received/paid ledger, not accrual accounting, a bank reconciliation report, tax filings or a formal P&L. Dates use Taiwan local receipt/payment day. Income minus expenses is labelled recorded cash-flow difference, not profit. Missing records are explicit; there are no invented demo transactions. OTA-collected payments are included in guest receipts and separately labelled as not verified bank payout. Sheet `done` without an actual OS receipt is not synthesized into any month's income.

Expense categories: laundry, water/electricity/gas, cable TV, internet, cleaning, supplies, repairs, rent, small items, other. Income categories: lodging, breakfast, overtime/late checkout, additional guests/beds, partner income, other. Deposit/balance/full are receipt stages under lodging, never a second income category. OS calendar `other` receipts remain other income pending future classification; manual additional service income can select the right category. Do not re-enter calendar receipts manually.

## Shared deterministic API

GET `/api/v1/finance?property={id}&year={yyyy}` returns allowed property labels, annual entries and ledger version. Sources: manual entries plus existing OS payment ledger receipts, projected once by receipt ID and received_at Taiwan date. It never writes or recalculates order payment status. Calendar receipts remain immutable here.

POST `/api/v1/finance` takes action=create|void, property_id, year, expected_version, request_id UUID and the corresponding fields. Create: kind, category, positive amount (TWD, max 2 decimals), date, description, method, optional lodging stage. Void: entry_id and required reason. Server rejects future cash dates and mismatched year/categories, denies non-managers and other-property scopes, rate-limits, checks same-origin, and derives actor from the authenticated session.

Storage: private non-expiring Redis `sweetfun-os:finance:v1:{property}:{year}` with version, entries and append-only operation audit. Amounts stored as integer cents. CAS plus expected version, idempotency hash and final authoritative readback. Void preserves amount/date/original actor and records reason/actor/time; excluded from totals but visible in ledger. No destructive record deletion. Limit 10,000 operations per property/year; no truncation. Repeated operation IDs with altered payloads are rejected. Pending UI retries preserve original payload.

Existing calendar payment keys have no property index. Read-only scan uses the allowed property and exact ledger key shape, chunks MGET, deduplicates IDs, fails if complete retrieval cannot be obtained. This is suitable for the current small deployment; secondary indexing and consistent multi-ledger report snapshots are later scaling work. Summary reflects the read batch, not a transactionally locked accounting close.

## UI

Overview: three recorded income/expense/difference cards, annual expense bars with accessible month values, expense donut with category legend, recent entries. Bookkeeping: same analysis plus income/expense tab, text/category filter, entry details and primary Add expense. Manual income CTA under income tab. Details show method, date, source, receipt stage, operator, creation time; manual void needs reason and confirmation. No paid-service integration or credential changes.

## Validation / boundaries

Pure and storage tests cover role/property denial, cent arithmetic, validation, idempotency, concurrent version conflicts, void audits, year/month totals, source receipt deduplication, and Taiwan month boundary. Live persistence smoke test uses a synthetic separate key and cleans only that key; no business record was created by tests.

No invoices/attachments, recurring bill scheduler, bank/OTA settlement imports, tax accounting, writeback to Sheet, receipt reclassification or modification to calendar payment totals. No general Mission scheduler integration claimed; deterministic endpoints and persistent operations support subsequent Agent tooling. Backup/migration remains necessary for broader financial rollout; rollback UI must retain all finance keys.

## 2026-09-08: receivables and recurring expenses

Latest owner decisions override the initial cash-only dashboard:
- Expense descriptions optional. Monthly recurrence creates **pending** occurrences, not payments. Confirming creates an ordinary audited expense with rule/date identity. Day 31 clamps to month-end. Due items accumulate, including previous years. Stop preserves past dues and payments. GET derives occurrences without writes, so no cron delivery dependency or cash mutation is needed.
- Only actual receipt counts as received. Checkout and Sheet `done` never synthesize cash. Agoda eligible date = checkout + 30 days (owner-supplied rule); requesting claim is not a receipt. Trip.com and Owljourney use manual-event receipt by default; optional monthly expected date is checkout month + 1–3 months, day clamped. Expected dates never book cash.
- Room receipts from finance require explicit per-order allocations, including batch OTA payouts and partial payments. Server checks source, platform, allocation sum and outstanding amount; re-reads live Sheet for linked writes. Actual receipts settle receivables, including direct-booking deposits before arrival. Extra service income remains separate. Source room rates are the available total; undocumented fees/commissions are not guessed.
- Revenue chart basis: orders grouped by check-in month, split by actual allocations **as of now**. Cross-year receipt stays attributed to the original stay cohort. Non-lodging/unallocated historical service cash is attributed to receipt month. Cash summary separately uses actual receipt/payment date. These are operational totals, not accrual/tax accounting.
- OTA-method calendar entries represent guest payment to platform, not cash to property. They do not lower property receivables. Manual bank payout allocates separately. Existing historical manual lodging without links cannot be matched automatically; reconcile those records rather than assume identity.
- Existing conflicted source groups are excluded with visible count. Source changes after receipts may leave overpayments needing investigation; no refund is silently inferred.
- Rules remain in original annual finance key; queries read all authorized property years. Payout settings resolve by latest update timestamp. Reports carry all-year projection hash and annual versions; writes use CAS, property payment lock, idempotency, actor audit and readback. Calendar checks include finance allocations and guard overpayment; no duplicate ledger copies are written. Main Sheet remains unchanged.
- All chart bars and donut segments expose amount on hover, focus, or tap. API: `/api/v1/finance`, new actions `recurring_create`, `recurring_stop`, `payout_rule`; ordinary create accepts allocations or recurrence identity. The same deterministic contract is usable by a future authorized Agent.
- Test coverage: deposit example, checkout/done without cash, OTA vs payout, cross-year allocations, month-end payout rules, conflict exclusion, malformed/overallocated links, recurrence overdue/stop/void, previous-year settlement, idempotency and calendar overpayment.

Verification for this upgrade: 26 finance/payment tests passed, TypeScript and ESLint passed (two existing calendar warnings). Vercel production build passed; local build was blocked only by Google Fonts network download. Real Redis verification used a unique synthetic property and removed its keys after checking recurrence persistence, retry, due generation and payment. Production browser verified GET 200, invalid amount 400, out-of-scope property 403, mobile recurring form and batch Agoda allocations, bar/donut focus hints and no horizontal overflow. No test income or expense was added to real property accounts.
