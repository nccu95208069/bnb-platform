# Customer operations and onboarding follow-up

The owner's October 3 request extends the new-customer workspace to multiple properties, collaborators, unsold lists, pricing and order receipts. The implementation is on `codex/customer-onboarding` / draft PR #26. It is not a production-domain rollout. The original pilot still requires customer-controlled password setup and import acceptance.

## Product decisions and user flow

1. `/join` accepts a Sheet or directs a new applicant without a Sheet to assisted setup. The file is shared read-only with the dedicated reader; the server checks readability and saves an application. The applicant receives an activation link. Email verification and file owner/editor evidence, or explicit platform-operator review, are required before cells are released.
2. `/account-setup` provisions the first isolated workspace and property. `/w/[slug]/import` suggests exact header/room mappings, asks for financial interpretation, previews rows, and commits selected valid orders. The source is not modified or continuously synchronized.
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

The current format assistant uses local deterministic labels and exact room names, not an external LLM. It proposes mappings but does not choose financial semantics. Calendar grids, missing checkout/per-night layouts and unrecognized structures prompt assisted conversion. Repeated source order IDs remain blocked; the importer must not multiply a repeated deposit or infer aggregation from row order.

Amounts require a declared order/night basis and property-received/guest-paid meaning. The importer still supports only normalized single-row orders with common stay dates; native manual orders can contain different date segments. An AI interpreter can be added later to propose a structure and questions, with explicit customer confirmation and the same deterministic preview/write validation.

Additional properties can bind their own shared Sheet after verified-email/file-permission checks. Unprovable access or format questions create durable support tickets; `/onboarding-admin` lists and responds to them. Source approval requires explicit identity confirmation, current requester admin/owner scope, Google readability and atomic workspace/ticket changes. Tickets never authorize reading cells by themselves.

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
