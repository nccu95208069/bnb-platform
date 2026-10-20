# Owner booking acceptance — 2026-10-20

Scope: Houyuan owner calendar, order lookup, receipt confirmation, refunds and cancellation. The owner explicitly requested isolated testing with official sales closed. No production property, inventory, account, payment, notification delivery, or sales setting was changed.

## Fixes found through the owner UI

- A first website hold could not confirm a bank deposit: it required a receipt account, but account creation was only exposed after confirmation. Owner/admin users can now add an account from the hold payment form. The existing authorized, versioned `receipt-account` operation saves only a name and final four digits. It does not create a receipt or convert the hold. The form preserves the proposed amount and requires receipt/scope confirmation afterward. Lost responses lock other writes and replay the same operation key.
- The shared month calendar classified `Official Website` as Other and represented held bookings as source conflicts. Website orders now use Direct, held bookings retain their actual status and explicit hold label, and expired holds remain occupied with a pending-owner label. Cancelled orders are omitted from occupancy. Month and day views distinguish holds from confirmed orders.
- Cancelled order search results still described the historical amount as outstanding payment. They now use the same original-room-fee/difference wording as order details and explain that the difference is not a request for payment.

## Browser and data acceptance

Actual owner Next pages/HTTP handlers and the existing Studio/guest workers shared synthetic in-memory storage. The owner app ran with an empty inherited environment, synthetic session/storage settings, and an outbound-fetch block. No production credentials were loaded. Local storage emulated the adapter's compare-and-set operations; this browser run did not use production Redis.

The main synthetic order used a whole-house plan for 14 adults, October 25–27, two nights at NT$18,000, total NT$36,000.

| Step | Verified result |
| --- | --- |
| Guest reserve | One held order, correct Official Website source, dates, party and total |
| Owner calendar/search | Two occupied nights; checkout night free; name/source search returns the same order |
| First receipt account | Account added without any payment or status change |
| Confirm bank deposit | NT$10,800, same order ID, confirmed status, NT$25,200 remaining on both sides |
| Cancel before refund | Rejected; order and occupancy retained |
| Record bank balance | NT$25,200; total received NT$36,000 and zero remaining; finance list shows one settled order |
| Excess refund | NT$36,001 rejected |
| Refund and cancel | One NT$36,000 refund; net received zero; same order cancelled; historical entries preserved |
| Guest lookup and inventory | Ended status and refund amount agree; identical dates can be quoted and reserved again |
| Second unpaid hold | Visible under Direct with a hold label; opens the original detail from the calendar |
| Extend and release | Twelve-hour extension retains the same ID; release creates no payment and removes occupancy |
| Cancelled search | Both historical orders remain searchable; no misleading outstanding-payment label |

Local evidence includes screenshots and authoritative snapshots at held, deposit, paid, cancelled and final stages. Those private/local artifacts are not committed. Final state: two cancelled synthetic orders, one receipt account, one deposit, one balance, one refund, and no active occupancy.

## Validation and limits

- 30 UI/calendar checks, 38 domain/booking checks, and 14 existing regression checks passed (82 total).
- Frontend lint: zero errors; five pre-existing warnings in unrelated files. `next build --webpack` and TypeScript passed. The default Turbopack build cannot follow this checkout's shared dependency symlink, so the supported webpack build was used.
- New UI tests are included in the existing GitHub Actions website test step; calendar projection tests are already in its UI suite.
- The five local Redis HTTP tests require a dedicated Redis server and could not run on this host. The existing CI job provides Redis 7.2 and runs them. The browser acceptance exercised actual owner HTTP routes with isolated storage.
- Emails/LINE delivery, bank transfer execution, live production persistence and real sales activation were intentionally outside this test. Queued notification text is not evidence of delivery.
- Changes remain in a review branch; this task does not authorize a production rollout or reopening sales.

## PR #60 review follow-up

The owner authorized a full review of the draft PR and fixes for any findings, while keeping Houyuan in test mode and withholding merge/deployment approval. Review covered all changed files plus the underlying session/membership checks, receipt and hold operations, workspace transactions, cancellation, guest availability and calendar projection.

No runtime defect was reproduced in the reviewed permissions, receipt replay or cancellation paths. A coverage gap was addressed: the new first-account flow did not have direct HTTP tests for revoked permissions or concurrent financial operations. The additional tests exercise actual route handlers against isolated memory storage locally and repeat the six API scenarios against Redis/Lua in CI.

| Area | Review and regression evidence |
| --- | --- |
| Authorization | Current active role and property grant are enforced on every command, including replay. Viewer/housekeeper account creation and hold conversion, out-of-scope admins, missing sessions and cross-origin writes are rejected. Removing an admin's scope, downgrading the role or deactivating membership also rejects a previously successful command's retry. Hidden-price calendar responses contain no accounts, totals or receipts. |
| First account and deposit | Concurrent identical account creation produces one account and no receipt. Different content on the same request key is rejected. Foreign account IDs are rejected. Concurrent bank-deposit confirmation, subsequent replay and stale/new-key conversion attempts retain one receipt and one order ID. |
| Balance and refund | Two different requests based on the same version cannot both commit. Exact retries retain the original ledger entries. Housekeepers retain their documented scoped receipt permission but cannot refund or cancel; viewers cannot write. Refunds cannot exceed net received. |
| Cancellation and inventory | Payment settlement and explicit website-cancellation confirmation are required. Refund alone retains occupancy. Successful cancellation removes only that booking's occupancy. Replaying the old cancellation neither deletes a maintenance block nor releases a replacement hold. Historical cancelled orders remain queryable, while the rendered calendar excludes them. |
| Concurrent actions and UI | Deposit/release and payment/cancellation races each admit one mutation. The resulting ledger and availability agree. Rapid double submission after account creation sends one deposit command; a lost bank-deposit response locks other actions and retries the exact payload without adding a receipt. |

Local follow-up validation: six HTTP scenarios using isolated memory storage plus 19 focused UI/calendar checks passed. CI includes the same six scenarios twice (memory and real Redis), the expanded UI tests, all existing workspace regressions, backend checks and the frontend production build. The exact revision's CI result is recorded on [draft PR #60](https://github.com/nccu95208069/bnb-platform/pull/60).

This follow-up changes tests, CI coverage and this review record only. It does not change production application logic, property settings, external channel inventory, real payment execution or notification delivery. The application records acknowledged receipts/refunds; actual bank reconciliation and production acceptance remain separate from these synthetic tests.
