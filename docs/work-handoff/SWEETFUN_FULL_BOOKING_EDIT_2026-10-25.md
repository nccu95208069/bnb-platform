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

Engineering implementation prepared on `codex/sweetfun-full-booking-edit-20261025`, based on PR #80 / `ef84d009`. The existing finance and OFFLAND changes remain included. Production release and live acceptance pending.
