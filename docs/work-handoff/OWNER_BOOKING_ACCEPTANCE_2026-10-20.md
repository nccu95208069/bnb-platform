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
