# Sweetfun LINE / OS full booking editing — 2026-10-25

The owner requested that the entire editable booking record be available for both LINE orders and orders created in OS, and explicitly included previously imported LINE orders. This decision supersedes the earlier name-only restriction for imported LINE orders. OTA/source-event orders retain their existing name-correction policy.

## Behavior

Open an active direct booking in the calendar and choose **修改訂單**. Owners, admins and god users with price access can change guest name, contact, notes, booking date (including clearing an unknown date), rooms, stay dates and nightly prices. The form supports multiple rooms and multiple non-contiguous stays in the same room, adding/removing segments, and different prices for each room-night. Adjacent imported one-night rows are combined for display; metadata-only saves preserve the original stored stays and nightly amounts.

Existing orders without a proven nightly distribution keep their original total. The owner may edit the total directly, or explicitly enter all nightly amounts. Changing rooms/dates requires a complete nightly allocation in the UI; the system never invents a split of an old total. Duplicate room-nights are rejected before submission and checked again by Iron Gate.

The booking ID, source and payment events remain unchanged. Imported LINE orders retain their immutable J/L ledger alias after version/date/amount changes, so their existing OS receipts remain associated with the same order. The old Sheet paid flag is not asserted against a changed total. Actual payment events remain append-only and use the existing receipt/refund flow.

## Boundaries and persistence

Eligibility is derived server-side from native `os`/`line` source or immutable Sweetfun import rows whose platforms are all LINE. Blank/mixed platform evidence, OFFLAND evidence, or an external source-calendar order cannot claim full direct editing. Authorization, property/field scopes, optimistic versions and idempotency remain enforced. Source divergence and an in-flight/review-required room operation must be resolved before the UI offers another edit.

OS amendments save locally first. A room/date change records the original provider baseline and keeps removed room-nights fenced until **同步房況** completes. Repeated edits retain that original baseline; reverting to it clears the pending change and restores the prior state. A pending room move cannot be cancelled before synchronization. Metadata and price edits alone do not create an OwlNest operation.

Explicit synchronization closes newly selected nights before reopening removed nights, and completes only after readback. An existing verified close can establish the old baseline; otherwise the old/new nights must be inside the observed OwlNest window. Missing observation blocks unsafe synchronization, while the saved booking remains available. The UI describes this as saved data with pending room synchronization.

An imported LINE order changed in OS is marked as locally managed. A later upstream event is retained for review rather than overwriting the owner's edit. The original source evidence remains private and unchanged. No database migration, new grant, flag change, receipt migration or live test order/payment is required for this feature.

## Verification

- Integrated authenticated gateway → HTTP handler → Iron Gate repository → independent readback tests cover native OS, native LINE and imported LINE edits of every field, multiple rooms/disjoint dates, nightly totals, immutable payment events and ledger identity.
- Service checks cover immutable eligibility, no-money redaction, date validation, upstream overwrite refusal, original room fences, saved edits outside the observation window, and deferred synchronization.
- Existing provider-worker lifecycle verifies close-new-before-open-old and readback; the updated flow first requires the explicit sync action.
- DOM checks exercise the real form: imported LINE editing, disjoint stays in the same room, added/removed segments, booking-date changes, metadata-only preservation and duplicate-night refusal. Existing create/recovery tests remain covered.
- Verified locally: Iron Gate typecheck and full suite **284 passed / 9 environment-dependent skips**; authenticated frontend integration suites **47 passed**; form/calendar/payment-review DOM suites **11 passed**; frontend lint **0 errors / 7 existing warnings**; production Webpack build passed. The default local Turbopack build cannot follow this checkout’s shared dependency symlink, so the repository-supported Webpack build was used. Runtime deployment and authenticated live read-only acceptance are recorded below after completion.

## Release

Released October 25 at approximately 11:00 Taipei from `codex/sweetfun-full-booking-edit-20261025`, based on PR #80 / `ef84d009`. [Draft PR #81](https://github.com/nccu95208069/bnb-platform/pull/81) records the feature; no PR was merged.

- OS: runtime `e74158df1917aede1c7aff46d122dbb863c0e8ee`, READY deployment `dpl_DYta4oGk92JBrgSibafktigr9ECt`, `sweetfun-hs1wqpiyr-sweetfuns-projects.vercel.app`; primary `sweetfun-os.vercel.app` independently verified.
- Iron Gate: runtime `8b9b0f76431c06c31e455b2e07bffc889e00d6c7`, READY deployment `dpl_8vkDKBRaqPJy55dHdmsaobiieXAL`, `iron-gate-3w4l3rwef-sweetfuns-projects.vercel.app`; primary `iron-gate-green.vercel.app` independently verified. This includes the calendar-snapshot capability projection verified through the complete gateway/calendar chain.
- GitHub CI succeeded for both feature runtime `e74158d` (run `40156311311`) and final backend/runtime `8b9b0f7` (run `40156485324`), including frontend, backend, Iron Gate and customer isolation jobs. Final targeted service tests (97) and integrated frontend tests (47) also passed after the calendar projection correction.
- Candidate unauthenticated booking reads returned HTTP 401. Existing production settings/grants and the previous finance/OFFLAND changes were preserved.

## Authenticated live acceptance

An existing owner browser opened an imported LINE booking from the production calendar. **修改訂單** appeared and the real details populated all editable fields, including nightly prices and booking date. An unsaved, anonymized draft added a second room/stay segment, independently edited both nightly rates (3,900 and 4,800, total 8,700), and changed the booking date. Native date keyboard input persisted across other form changes. All draft changes were discarded by closing the form.

At 390 and 360 CSS-pixel widths, the dialog had no horizontal overflow and every input, select, button and section remained within its bounds. The temporary viewport was reset and the calendar left open. A screenshot of the anonymized, unsaved draft was saved outside Git; no guest data was committed. Browser error logs were empty.

Separate authenticated read-only detail queries verified the existing native LINE booking (`full`, confirmed, verified, version 2) and OS booking (`full`, confirmed, awaiting manual sync, version 1), each with nightly prices. The OS order remains the owner's original single saved order.

Independent database reads before and after acceptance matched booking fingerprints exactly for both properties: Sweetfun authority epoch 1 / inventory 80 / 1,625 bookings / 0 native payment events; OFFLAND epoch 0 / inventory 1 / 270 bookings / 0 events. No real booking, receipt, refund, cancellation or OwlNest synchronization was submitted during this acceptance. Actual write/readback and provider transition tests used isolated synthetic fixtures, not production guest orders. This is browser mobile-width acceptance, not a physical iPhone test.
