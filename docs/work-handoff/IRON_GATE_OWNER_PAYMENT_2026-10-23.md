# Sweetfun owner calendar: booking dates and payments (2026-10-23)

## Current change

The Iron Gate calendar now carries a validated booking date from the imported
source row. Gmail orders without an independently verified booking date retain
an empty booking date; the parser's processing day is not an order date.
Verified whole-order totals remain visible to price-enabled members. When a
multi-room price has no defensible split, each room price remains unknown while
the whole-order total is shown.

An active price-enabled member can open the OS payment panel from an Iron Gate
booking. The **登記收款** and **登記房費已收** actions read the exact live booking before
recording a receipt. The check binds the property, workspace, booking ID,
version, total, status, and complete room nights. The OS Redis receipt ledger
uses the previous `SF-` key only when Iron Gate exposes a reconciled, unchanged
version-one Sheet import. All other bookings use their `IG-` key. An imported
order whose source changes loses that alias; already saved receipts remain
recoverable by their original key and new payments are blocked pending review.

Iron Gate payments are durable in the existing OS receipt ledger, visible in
the calendar and finance income projection. They do not write the frozen Google
Sheet. The OS read grant remains read-only; Iron Gate has no payment mutation
credential. Price-hidden members receive no payment alias or amount fields.

## Release gate

Deploy Iron Gate's scoped projection before OS. Check the owner booking date,
whole-order total, and payment panel on an imported order, then on a new Gmail
order. Verify the `IG-` and legacy `SF-` ledger paths without making a real
payment. Roll back OS first, then Iron Gate, if the owner calendar or payment
preflight fails. No production payment was recorded as part of this change.

Local verification: Iron Gate `npm run check` and `npm test`; OS TypeScript,
ESLint, focused calendar/payment API and UI tests. Local `next build` needs a
physical `node_modules` directory for Turbopack and outbound Google Fonts for
webpack; CI validates the release build.
