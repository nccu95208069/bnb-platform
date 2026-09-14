# Calendar price refresh and position repair — 2026-09-14

Status: implemented locally on `codex/calendar-price-refresh`; not deployed or credential-enabled. Based on `codex/finance-summary-m1` at `e1f34ee`, not the older `main` calendar baseline.

## Owner request

- A button to read newest OwlNest prices after repricing every 3–5 days.
- Rename channel observation prices to `Owlnest (平台)價格`.
- Keep the calendar date when switching sold/unsold, month/week/day, or leaving and returning.

## Implemented

The administrator button calls authenticated, same-origin `POST /api/v1/availability/refresh`. Only price-visible owner/admin/god principals scoped to Sweetfun may refresh. The server reads OwlNest hotel 6188 with GET only, for Taipei today through three calendar months (exclusive endpoint, clamped at month end), covering rooms 101–302 and all five existing channel plans. It never changes OwlNest prices or inventory.

Publication requires every requested room/date/channel price. The current initialized private pricing snapshot is preserved on source failure. A 90-second ownership lock, compare-and-set publish, previous-version backup and exact read-back protect the shared snapshot from concurrent publishers. An uncertain write/read-back is explicitly reported as unconfirmed, not successful or preserved. Dates outside the refresh window retain their original observation time; rack/model/probability metadata is not recalculated.

Sold and unsold month scrollers share month-relative layout anchoring. Height changes from asynchronous data loading no longer become navigation events. Explicit toggles create history entries instead of invoking asynchronous Back. Today/history restoration uses a revision independent of month observation.

## Verification

- 149 frontend tests, including incomplete-source and uncertain-write regressions.
- Frontend lint: no errors; two existing unused-variable warnings.
- Production build passed (network permission needed for existing Google Fonts downloads).
- Synthetic browser test: 24 repeated view/mode toggles at September 14 remain on target; successful refresh reloads data, double click sends one write, source error is displayed, earlier month height change and Back/Forward retain target.
- Repeated the same 24 toggles at October 12 and verified leaving for Home then returning to Calendar retains October 12. Wait for the destination page to actually mount when testing route transitions.
- Existing local OwlNest credential was used for a read-only two-day probe: six rooms and five expected channel plans confirmed. No production pricing snapshot was changed.

## Activation remaining

Requires owner approval to store the existing OwlNest authorization credential as production-only server secret `OWLNEST_AUTHORIZATION` and deploy. Never expose it as a `NEXT_PUBLIC_` variable, commit it, or place it in screenshots/logs. An expired session produces an explicit reconnect message; this change does not automate OwlNest login renewal. Verify current production baseline before deployment, then perform a signed-in real button test and read back the new observation time and prices. Frontend fixture tests are not evidence of production activation.
