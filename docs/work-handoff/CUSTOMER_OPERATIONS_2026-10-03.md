# Customer operations and onboarding follow-up

The owner's October 3 request extends the new-customer workspace to multiple properties, collaborators, unsold lists, pricing and order receipts. The implementation is on `codex/customer-onboarding` / draft PR #26. It is not a production-domain rollout. The original pilot still requires customer-controlled password setup and import acceptance.

## Product decisions and user flow

1. `/join` accepts a Sheet or directs a new applicant without a Sheet to assisted setup. The file is shared read-only with the dedicated reader; the server checks readability and saves an application. The applicant receives an activation link and verifies their own account. The latest owner decision removes file owner/editor identity matching; the source creator can be a different account.
2. `/account-setup` provisions the first isolated workspace and property. `/w/[slug]/import` suggests exact header/room mappings, maps the source row/amount structure, previews complete grouped orders, and commits selected valid orders. It does not ask every applicant whether cumulative paid money went to the property or a platform. The source is not modified or continuously synchronized.
3. `/w/[slug]/settings` lets the owner add properties without another account. Each property starts in Sheet-review mode or requires explicit confirmation that it has no existing orders. An unresolved property cannot accept new bookings or produce an authoritative unsold list. Completed properties remain usable independently.
4. The owner invites collaborators by email, role and property scope. Default UI scope is selected properties and default role is `viewer_no_price`. Seven-day invitations use a signed URL fragment; existing users authenticate with their original password and new users set their own. Revocation, scope changes and suspension are enforced from current membership on every request. The account home also drops inactive workspace references.
5. `/w/[slug]/availability` returns only unoccupied nights in a maximum 90-day interval. Price display is off by default; saved lists store query conditions and requery current inventory. Users can copy the resulting text. There is no public share URL or inventory hold. Checkout is exclusive; in mixed properties a room booking removes the whole-villa option, and villa/room choices are not additive stock.
6. Settings supports TWD base nightly prices and inclusive date overrides per room or villa. Overlapping override ranges are rejected. The owner/admin separately enables price display. Missing rates stay unknown (`另洽`); explicit zero remains zero. These reference rates do not alter booked totals.
7. `/w/[slug]/finance` and calendar details use the same order ledger for deposits, balances, full/other receipts and refunds. Each order holds one total and one ledger, even with several rooms or date segments. Receipt-date reports use Asia/Taipei dates and exclude imported opening balances from period income.

## Roles and property boundaries

| Role | Available operations |
| --- | --- |
| Owner | All workspace properties; add property, invite/change/suspend members, import, pricing, booking, receipts/refunds, terms and opening balances |
| Admin | Import, pricing, booking, receipts/refunds, terms and opening balances in granted properties; no member or property creation |
| Housekeeper | Booking creation and receipt entry in granted properties; no refunds, terms/opening changes, member administration or cancellation |
| Viewer | Read granted calendar, pricing and finance; no mutations |
| Viewer without price | Read granted calendar and unpriced availability; server strips pricing, receipt history, totals, contact, notes and imported financial/source details; finance page denied |

An all-properties grant includes future properties in that workspace. Selected-property grants never expand automatically. Legacy owner/god credentials do not confer customer membership; their separate platform support authority remains restricted to the onboarding operator API.

## Sheet format decisions and assistance

The current format assistant uses local deterministic labels and exact room names, not an external LLM. Whole-order rows, room/date segments, nightly rows without checkout, and explicitly grouped calendar grids are supported. Repeated IDs coalesce only within their source/property; conflicting guest/amount/payment values or duplicate occupied nights quarantine the entire order. No name, color or adjacency heuristic establishes order identity.

Amounts distinguish order totals, line totals, nightly totals and per-room-night totals. Repeated cumulative paid values are retained once as source summaries; unknown values remain unknown and no payment date or per-night allocation is invented. See [standard workbook specification](STANDARD_SHEET_2026-10-03.md) for the versioned rules and tested examples.

Additional properties bind shared Sheets after current membership/scope and readability checks. Source owner/editor addresses are not queried. Format questions still create durable support tickets; old pending source-review records retain a readability-based compatibility route without an identity checkbox. Complete standard-workbook exports are restricted to unrestricted workspace owners; other members use scoped application views.

Every completed Sheet import records its coverage start. Booking creation and availability reject dates before that start rather than equating missing data with empty inventory. Header-only or past-only sources require explicit empty confirmation; zero-order confirmation cannot be undone as if it were an ordinary imported batch.

## Order and money invariants

- A native order accepts up to 50 date/room segments in one property. Calendar bars, conflicts and availability use those segments, not the outer minimum/maximum dates. Legacy flat orders retain their old shape and behavior.
- A three-room one-night order for TWD 9,000 with a TWD 3,000 deposit has one receipt and TWD 6,000 remaining. Adding a later stay segment does not repeat that deposit or occupy the gap between stays.
- An expected deposit is a target, not a receipt. TWD values validate to cents, reject negatives/non-finite values, and use integer cents for sums. Receipt timestamps require an explicit time zone and cannot be in the future.
- Imported `propertyReceived` is an opening receipt balance. Imported `guestPaid` is not cash received by the property. Unknown imported cash stays unknown until an owner/admin confirms an opening amount and its date; explicit zero is valid. Existing source amounts cannot be overwritten through the opening-balance operation.
- Receipts/refunds append to history. Refunds cannot exceed known net receipts. Overpayments require explicit confirmation. Cancellation requires a known zero net receipt balance; cancellation fees and partial cancellation need a separate future workflow.
- Adding an extra charge requires updating the agreed total before recording its payment. Separate charge-line receivables, operating expenses, tax/invoices, profit-and-loss and bank reconciliation are outside this slice.
- Cross-property orders and shared payment allocation are not implemented. Separate property orders require explicit allocation so their combined receipts equal the actual payment.

## Persistence and recovery

Workspace mutations require current membership, workspace version, a durable operation key and a normalized request hash. Order finance also checks order version. Writes are atomic Redis CAS operations and reread the saved receipt/order before success. HTTP APIs enforce same-origin requests, input bounds, rate limits and private/no-store output. React command forms retain an immutable in-flight payload and retry it after uncertain responses; the payment dialog cannot be dismissed while the result is uncertain.

Limits remain explicit: up to 30 properties, 100 rooms/property, 100 members, 500 invitation history entries, 5,000 bookings/workspace, 20,000 operation receipts/workspace and 1,000 payments/order. This is an initial bounded workspace store, not a high-volume ledger architecture. No database migration or legacy store rewrite is included.

## Verification and remaining release gates

Local verification on October 3:

- 54 service/API/auth tests pass, including new multi-property, multi-stay, ledger, invitation, source-approval and format cases alongside existing legacy isolation tests.
- 15 React DOM tests pass, covering three-room/multiple-date creation, member settings, pricing visibility, invitation handling, mapping assistance and identical uncertain-write retries.
- ESLint: zero errors, two pre-existing unused-variable warnings in legacy calendar components. Production webpack build including TypeScript passes.
- Integration-style HTTP tests use real Next request/response handling with synthetic Google and Redis responses. Invitation emails are suppressed in these tests; no new real recipients are contacted.

These results do not constitute browser visual or live invitation-delivery acceptance. Browser automation remains blocked by the environment's access policy. A proposed additional synthetic write/cleanup test using production storage credentials was rejected by automatic approval review as not explicitly authorized; it was not executed, and no indirect workaround was attempted. Prior three-key Redis verification belongs to the earlier onboarding slice and does not verify these new operations.

Before production rollout: complete customer-controlled activation/import, verify actual collaborator invitation delivery and scope on the protected candidate, review the new screens in a real browser, obtain explicit authorization for any additional production-storage mutation test, and obtain authorization to switch the public domain. Keep PR #26 draft until release gates are satisfied. A rollback to an older customer deployment must not expose new multi-segment orders to code that treats their outer dates as continuous occupancy; retain a schema-aware candidate or disable new customer operations during rollback.

The companion Chinese Word manual covers the end-user flow and worked receipt examples. It is delivered as a local artifact, separate from public repository sources and private customer evidence.

## Protected acceptance deployment

- Code commit `5c8899630bae767da4323a0e2e5407be2d6c938f` is deployed as `dpl_Gjuz3iwcQkahaMa84ErF6tgAyetm`, READY at https://sweetfun-dm64f7mau-sweetfuns-projects.vercel.app . Its deployment-scoped lifecycle links use that hostname. Vercel authentication remains enabled: unauthenticated requests redirect to `vercel.com/sso-api`.
- The cloud Turbopack build, TypeScript and 59 route generation completed successfully. Read-only acceptance checks returned 200 for `/join`, `/start`, `/account-setup` and `/invite`; customer-session, workspace, member and availability APIs all returned 401 without a customer session. No writes, customer login or new email were performed by these checks.
- `sweetfun-os.vercel.app` still resolves to the previous READY deployment `dpl_2jLsmZFuqA9hv4uxpzE2CcU4M9uC`. No primary-domain promote/alias action was performed.
- GitHub run https://github.com/nccu95208069/bnb-platform/actions/runs/37054695042 did not start its jobs because the repository account is locked due to a billing issue. This is not a remote test pass; the local and cloud-build results above are the available evidence.
- The eight-page Word manual was rendered and every page visually inspected. Account activation must still be completed by the customer, followed by login at the new candidate to test the newly added operations. Earlier activation emails target the previous protected candidate and have not been resent by this follow-up.
