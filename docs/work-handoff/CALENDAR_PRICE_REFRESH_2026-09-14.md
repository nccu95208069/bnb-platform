# Calendar price refresh and position repair — 2026-09-14

Status: deployed to production on 2026-09-14, code commit `1f30361`, PR #18. Based on the verified previous production commit `e1f34ee` on `codex/finance-summary-m1`, not the older `main` calendar baseline.

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

## Production activation and remaining owner acceptance

The owner directed completion through a testable production site. The existing OwlNest credential was added as sensitive, production-only `OWLNEST_AUTHORIZATION`. Never expose it as a `NEXT_PUBLIC_` variable, commit it, or place it in screenshots/logs. An expired session produces an explicit reconnect message; this change does not automate OwlNest login renewal.

Deployment `dpl_J8NCaZuV8X44yYWF6wTrv51RcAER` / `sweetfun-a2pmq7spn-sweetfuns-projects.vercel.app` was built successfully then promoted. `vercel inspect sweetfun-os.vercel.app` resolves to this READY deployment. Previous rollback target: `dpl_HTyTidpyH4kbfefQy6P2N1XvgGaC`.

Real three-month OwlNest data passed the same parser against the existing production snapshot: 2026-09-14 through 2026-12-13 inclusive, 546 room-nights x 5 channels. The same refresh service was executed with production storage credentials, and atomic publication/read-back returned verified at `2026-09-14T06:36:04.444Z`, version `240519c1516a0355cda7`. Example: 101 / 2026-09-16 / Booking read 2760 from OwlNest. No OwlNest, Sheet, booking or finance records were modified.

The live browser loads the sign-in page without a framework error; same-origin unauthenticated refresh correctly returns 401. The browser has no owner session, so the signed-in production button click and mobile visual acceptance remain for the owner; do not describe them as already end-to-end verified. Error-level deployment log query returned no entries (not evidence of comprehensive monitoring); drains were not inspected.
