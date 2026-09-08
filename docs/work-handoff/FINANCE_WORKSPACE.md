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
