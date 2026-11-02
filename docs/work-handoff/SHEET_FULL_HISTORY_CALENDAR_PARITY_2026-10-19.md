# Full-history Sheet import and customer calendar parity

Owner decision, 2026-10-19: the first import should inspect the complete readable Sheet history. For Sweetfun's operational Sheet, a row with no L-column order number should become its own booking when its J-column unique ID is present and unique. The desired customer calendar is the existing Sweetfun OS sold-order month calendar at `/calendar?mode=sold&view=month`.

## Behavior

- The import wizard defaults to 2000-01-01, the earliest supported booking date, so historical rows are visible and eligible for preview. The source is still read-only; preview never confirms an import.
- Sweetfun's exact operational header maps J as the source row ID and L as the order number. Rows with L are grouped by that order number. Rows without L use `source-row:<J>` as a stable, separate source identity. Empty or duplicate J values, invalid dates, room mapping failures, and overlapping room nights stay blocked for review. No name-based grouping occurs.
- The verified inventory coverage interval is separate from the historical import start. A historical import without explicit complete source-coverage confirmation does not open website sales or mark blank dates as known available.
- The customer month view reuses the existing sold-order calendar renderer, including channel colors, stay bars and overflow behavior. A property-scoped adapter exposes only the current workspace's bookings. Imported cumulative paid summaries are not treated as confirmed cash receipts. The old room/day list remains available for selected dates, and empty days are not presented as sale-ready without coverage.
- The wizard keeps a separate final selection and confirmation. Nothing in this change imports a real Sheet, changes an original Sheet, migrates existing customer data, or deploys a site.

## Review and release

Synthetic acceptance covers a historical Sweetfun row and a future row imported together, duplicate J rejection, payment status not invented by the calendar adapter, and property/price isolation. After review, an unconfirmed Sheet interval also blocks manual availability and new booking creation; an earlier version could have shown blank dates as available after a full-history import. The import summary and date controls keep the historical cutoff separate from the owner-confirmed sale interval.

Local verification: 33 relevant service tests and 4 import UI tests passed. TypeScript and Webpack production build (78 pages) passed. Full frontend lint had zero errors and five existing warnings. Backend pytest reported 166 passed/45 skipped; Ruff check and format on `app` passed. A temporary local page using only synthetic bookings showed the reused colored month grid, metrics, channel filter and day selection in a browser; the page was removed before the final build. No actual Sheet import or live deployment occurred. This branch is local until a reviewed PR and release authorization.
