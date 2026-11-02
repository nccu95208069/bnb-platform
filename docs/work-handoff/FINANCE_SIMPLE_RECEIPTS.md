# 訂單收款簡化 — 2026-09-08

Owner accepted M1 and requested a direct operational screen. `/finance/summary` now displays current check-in month, with global historical search by booking IDs, room or date. Main cards contain order, verified receivable, recorded receipt, outstanding and one Record receipt CTA. Unknown totals remain unknown; no receipt record is shown as 未登記 rather than zero. Agoda claim is a small badge with legacy provenance explained in details. Other platforms do not show an irrelevant claim panel.

Removed user-facing capture/version/registry diagnostics controls. Existing registry and authorized API remain intact; this change does not implement background registry capture or Sheet writeback. Technical identities are no longer the main user task.

Record receipt opens a single-order form: amount, received date, method, optional note. Uses the existing finance POST, live source checks, financial permission scope, projection version, idempotency and verification. Empty note uses a generated lodging description because the existing income API requires one. No amount is automatically inferred/prefilled, no stage is silently set to full. Same existing server-side maximum applies; an unavailable/full/conflicted order is not bypassed. For platform orders, the form explicitly asks for actual property receipt, not a claim request. OS-only persistence remains unchanged.

Review: request-key fetch isolation, abort on unmount, selected order ID binding, pending replay payload, disabled uncertain form, permission reuse and optional-note compatibility checked. No critical issue found. No real payments generated for testing. Focused model/route/receipt contract tests and TypeScript passed. Browser/deploy result appended below.

Verification: full frontend suite 121 passed; TypeScript passed; ESLint zero errors (two existing calendar warnings). Vercel production `sweetfun-33wmppmk1-sweetfuns-projects.vercel.app` aliased successfully. Mobile 390x844 verified global search finds the accepted Agoda order and shows the unclaimed badge. Record receipt opens the matching single-order modal with empty amount, date, method and optional note. Browser errors empty. No real receipt submitted. Existing PR #17 updated; main merge remains deferred because of the separate baseline integration dependency.

## Whole-booking prefill

Owner requested automatic full room-charge amount. Receipt form now prefills existing order receivable (sum of all linked room-night charges, less OS-recorded receipts), remains editable, and shows all linked room numbers, check-in through checkout, whole-booking room-charge total and any recorded receipts. This is based on current source amounts, not new verification of platform settlement basis. Independent order IDs are not merged by name or date. Added two-room/two-night regression with a single deposit deducted once; TypeScript, lint and focused tests passed. Review found no critical issue; no real receipt was submitted.

## Optional expense advance payer (2026-09-08)
Expense creation and recurring-expense payment confirmation accept optional `advanced_by`:
- omitted/null: unspecified (existing records unchanged)
- `{type:"self"}`: server resolves current principal ID and display name
- `{type:"account",account_id:"..."}`: server resolves an active member scoped to the property
- `{type:"other",name:"..."}`: trimmed nonempty name, maximum 100 characters

Stored data includes type, name snapshot and account ID where applicable. Recorder and audit identity remain unchanged. GET finance exposes only eligible payer account IDs/names. Payer appears in bookkeeping rows/detail and participates in search. No reimbursement balance or extra expense is created. Recurrence templates do not assume the same payer each month. Request hashes include the supplied payer only when present, preserving prior idempotency hashes. Account validation is repeated before new writes; replays preserve the original result after renames/deactivation.

Verification: 124 frontend tests passed, including optional/self/custom payer, account scope/status checks, server-resolved names and retry conflicts. Self-review found no critical issue; production integration remains on the reviewed baseline branch pending main integration.

## Optional multi-month expense allocation (2026-09-09)
The expense form keeps allocation collapsed by default. Enable it, choose start/end months, preview an equal split, or edit individual amounts. Turning it off omits allocation. Existing payment date and amount remain one entry; recurrence payment confirmations can also allocate independently.

`POST /api/v1/finance` expense creation accepts optional `expense_spread: [{month:"2026-07",amount_cents:200000},{month:"2026-08",amount_cents:200000}]`. The server requires 2–120 contiguous ordered unique months (2020–2099), nonnegative integer cents and exact sum to expense amount. Income cannot carry this field. The split is durable alongside the entry and included in request idempotency hashing without changing legacy request hashes. GET returns the allocation for humans/agents. Void preserves the original split but excludes all its amounts from charts.

Cash summaries and bookkeeping lists remain based on actual payment dates. Expense trend and category charts use allocated months, falling back to payment month for unsplit entries. All-year finance context already loads ledger years, so allocations across December/January appear in either year's charts without copying entries. Details show each month and amount; list identifies the allocation range. No automatic recurring payment, reimbursement or main-sheet mutation is introduced.

Validation: 127 frontend tests passed; TypeScript passed; lint has no errors (two pre-existing calendar warnings). Self-review checked scope, idempotency compatibility, exact integer-cent sums, cross-year reporting, void handling and optional/default form behavior; no critical issue found.

## Split utilities and custom expense categories (2026-09-09)
New entries offer water, electricity and gas separately. Existing `utilities` entries remain intact and labeled legacy; an existing recurring utilities payment may retain its original category. No historical amount is guessed or redistributed.

Expense and recurring forms offer an inline Add category option. A trimmed name (1–50 characters, no control characters) is saved with the entry/rule; it is then reusable across years by that property's authorized finance users. Custom names have stable server-derived IDs and name snapshots. `category:"custom", category_name:"..."` creates/uses a category; subsequent calls use the returned custom ID plus name. Invalid custom IDs, income custom categories and altered idempotent retries are rejected. GET finance returns `expense_categories` derived only from the scoped property's persisted entries/rules, including historical/void records to retain options. No separate record is created when a form is cancelled. Category labels flow through recurring dues, list/detail/search and allocation-aware charts. No main-sheet writes.

Validation: full frontend suite (128 tests) passed plus an additional recurring/category-isolation test; TypeScript and lint passed (two existing calendar warnings). Self-review checked scope, old request hashes, legacy utility records, recurring-name propagation and persistence. No critical issue found.

## Payment account suffix settings (2026-09-09)
Settings → Payment accounts provides property-scoped credit-card (exactly 4 digits) and bank-transfer (exactly 5 digits) identifiers with optional names (up to 50 characters). The UI/API accepts suffixes only, retaining leading zeros. Existing generic payment methods remain available. Settings are shared by authorized finance users for that property; they are not personal login preferences.

`POST /api/v1/finance` action `payment_account_create` takes method, last_digits, name plus existing property/year/version/projection/request fields. It creates a durable UUID account record, not a financial transaction. Accounts across ledger years are exposed by GET as `payment_accounts`; existing finance permission and property locks/CAS apply. Repeated request IDs replay; changed suffix/name conflicts. Maximum 100 accounts per property; equal suffixes do not imply the same real account.

Expense creation may supply `payment_account_id`. The server resolves only accounts in the same property with the matching method and snapshots id/name/method/last_digits on the expense. Unknown or cross-property IDs and method mismatches are rejected. Existing/old expenses retain original data and manual method-only entries need no account selection. Expense list/detail/search show the chosen identifier. No main-sheet updates or real money movement occur. Editing/removing account presets and setting recurring-template defaults are not included in this increment.

Validation: 131 frontend tests passed; TypeScript and lint passed (two existing calendar warnings). Self-review checked account scope, suffix validation, leading zeros, cross-year availability, preservation on other finance actions, and idempotency. No critical issues found.

## Mobile form focus zoom (2026-09-09)
A shared, unlayered CSS rule keeps text-entry controls, native selects and editable content at least 16px on narrow screens or coarse-pointer touch devices, overriding inherited/text-sm 14px styles. This covers payment-account settings and other forms. Desktop typography stays unchanged, and no viewport zoom restriction is introduced. No data/API changes. Review confirms checkbox/radio/range/hidden inputs are excluded.

## Edit recorded expenses (2026-09-09)
Active manual expense details expose Edit expense and prefill amount, payment date, category, description, method/account, advance payer and exact allocation rows. Save uses `update_expense` with entry_id and the existing version/projection/request protocol. Income and void records are not editable through this action. Original entry ID, creator/time and recurrence identity remain intact; omitted advance payer preserves its historical snapshot, explicit null clears it. Allocation and payment-account fields reflect the full submitted replacement. A recurring payment cannot move earlier than its occurrence; changing one payment does not edit the recurring template.

Each edit appends an immutable prior snapshot (without nested history), server actor ID/name and timestamp. Details show prior values; at most 200 edits per entry are accepted (further edits rejected rather than dropping history). Idempotent retries return the same entry; changed payload or stale ledger/source versions reject. Existing permissions/property isolation still apply.

To support changing payment year without a non-atomic ledger move, GET adds `ledger_year` from the containing storage record. Edit/void submit that ledger year even after the date changes; cash/monthly reports already read all years and use actual date. This keeps one authoritative entry and audit chain. No Sheet writes.

Validation: 133 frontend tests passed, including same-ID update, cross-year totals, recorder preservation, history without nesting, explicit clear vs omission idempotency, recurrence preservation, and denial for income/void/foreign property. TypeScript and lint passed (two pre-existing calendar warnings). Self-review found no critical issue.

## Single-month expense attribution (2026-09-09)
Supersedes the earlier 2-month minimum: `expense_spread` accepts 1–120 months. The form's optional expense-month section defaults to one month, with a nested multi-month toggle. Single-month allocation always follows the full expense amount; multi-month custom amounts still require an exact total.

Bookkeeping/overview expense rows now follow allocation months (payment month fallback), and each row shows only the selected month's allocated amount. Income still follows receipt date. Details retain the full amount, labeled payment date, original registration timestamp and explicit expense-month breakdown. Cash summaries stay based on actual payment date. Moving an expense from September into August changes neither payment date nor creation timestamp and creates no second payment.

Validation: 134 tests passed, including 7,694 paid in September attributed wholly to August, preservation of both dates, exclusion from September expense list/chart, and partial amounts for multi-month rows. No live customer record was modified: assistant login expired and the available browser connection could not be retrieved. Owner can edit the identified laundry expense once deployment completes.

## Financial activity audit — 2026-09-09

New successful finance mutations persist a versioned `FinanceAuditEvent` inside the same Redis/KV CAS write as the business change. Covered actions: income/expense creation, expense editing, income/expense voiding, recurring expense creation/stopping, payout-rule changes, and payment-account creation. Calendar receipts persist the event inside the receipt in their existing ledger CAS. Readback verifies the audit as well as the operation; an identical retry returns the existing result without another event.

Fields: schema version, request ID, property, target type/ID, explicit action, authoritative principal ID/display name/email/role, server UTC timestamp, finance/calendar origin, succeeded result, before/after business snapshots, changed field names, ledger versions, and source/projection version when applicable. Business/payment dates remain separate from operation time. Snapshots exclude recursive history and request hashes. Payment account snapshots contain only the previously authorized last digits and label.

`/finance/audit` is reachable from finance navigation. `GET /api/v1/finance?year=2026&property=…&audit=1` returns all available ledger years, 30 events per page, optional `page`, `action`, `q`. Existing property/finance authorization and private no-store responses apply. There is no audit edit/delete endpoint. Agents can use the same authorized structured GET. Source is the route (finance/calendar), not a claim that all actors are humans; there is no distinct service-agent principal classification yet.

Existing generic operations are presented as `legacy_unknown` / `legacy_partial`, retaining only original actor ID, timestamp and target. Existing calendar receipts have known action/name/time but missing metadata is null. No historical data is rewritten or invented. Existing expense history remains available in entry details. No main Sheet write is added.

Scope limits: this logs successful covered financial mutations, not rejected requests, page views, authentication activity, or finance identity-registry captures. Redis/KV ledger records have no application TTL; this is persistent application storage, not an externally immutable or separately backed-up audit archive. Existing limits fail further writes rather than silently truncating records. Audit retrieval currently shares finance context availability requirements (booking snapshot and ledgers). Owner/God/Admin with price access and property scope may view; no-price accounts cannot.

Review: checked mutation coverage, server actor attribution, before-state copies, prior-year payout settings, retry behavior, CAS/readback integrity, authorization and sensitive-field exclusions. Automated tests include snapshots, setting changes, calendar receipt audit, anonymous denial and missing-audit readback failure. Authenticated production UI still requires user acceptance; no real financial entries were created for verification.
