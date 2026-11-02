# Sweetfun payment review after Iron Gate cutover — 2026-10-22

The payment review toggle kept its CSS, but the Iron Gate booking-only bridge
returned `payment_status=unknown` and `price_hidden=true` for every Sweetfun
booking. The imported Iron Gate state retains the original Sheet H flag as
restricted evidence; the calendar API omitted that flag. A read-only aggregate
of the production state found 1,011 active bookings with an unambiguous `done`
flag at this checkpoint. This is a guest-paid source claim, not a dated receipt,
OTA payout, or bank reconciliation.

The bridge now projects only `paid`, `deposit`, or `unknown` plus its provenance
from Iron Gate's one-state annual calendar snapshot. Exact current OS membership
and `viewPrices` gate the new `payment_status` proof field. Iron Gate's service
credential grants only this narrow field, not `money`; raw source rows, amounts,
notes, and receipt details never enter the browser response. No-price OS roles
request no payment field and the OS response projection clears all markers.
Imported H=`done` qualifies only while the booking still matches its imported
version and fee; changed-source orders fail closed. Later verified Iron Gate
payment events can supply current paid/deposit state, with refunds taking
precedence over the frozen flag. Unknown and mixed source flags stay unknown.

Month, week, and day cards use the same optional payment-review marker while
leaving `price_hidden=true`. The normal platform palette remains unchanged.
The snapshot call count remains one per annual read; month navigation uses the
existing in-memory annual cache. There is no per-month finance fetch.

The operational credential change is tracked in
`iron-gate/scripts/enable-sweetfun-payment-review-scope.sql` in the Iron Gate
PR. Release order: deploy Iron Gate, apply and read back the exact credential
field adjustment, deploy OS, then verify a known source-paid booking, an unknown
booking, no-price authorization, and cross-month navigation in production.

Local verification: Iron Gate 152 tests (143 pass, 9 database-dependent skips),
OS TypeScript, ESLint (0 errors, 5 existing warnings), focused calendar and
payment-review tests, and a Webpack production build passed. The first local
Turbopack build was blocked by this worktree's external node_modules symlink;
the first Webpack attempt could not reach Google Fonts in the sandbox. The
authorized network build completed successfully.

## Production release and verification

Both existing PR branches passed all GitHub checks before release. The Iron Gate
API was deployed first to `iron-gate-green.vercel.app` as deployment
`iron-gate-8wq42bjdg-sweetfuns-projects.vercel.app`. The guarded SQL above
updated only credential `48c51f52-f4b5-4d0d-a85f-7375715e548a`; a separate
readback showed `fields=["guest_name","payment_status"]`, active, with the
existing 2026-11-20 expiry. The OS deployment
`sweetfun-ou6f01246-sweetfuns-projects.vercel.app` was then aliased to
`sweetfun-os.vercel.app`.

An authenticated owner browser request to the production October 2026 calendar
API returned HTTP 200, `data_mode=iron_gate_booking_only`, snapshot version 17,
149 Sweetfun room nights: 50 marked `payment_review_status=paid`, 99 unknown,
zero source errors and zero source warnings. The normal OS response still had
`price_hidden=true` and zero room rates for Sweetfun. In the visible production
calendar, enabling **檢視付款狀態** changed known paid cards to gray while unknown
cards retained their channel colors. October to November navigation completed
in about 0.7 seconds in this desktop browser and did not show the loading state.
The calendar was returned to October with the review toggle on.

The live check confirms the legacy Sheet's paid flag is visible again, not that
the underlying payment has been reconciled to a bank or OTA payout. No real new
Iron Gate payment event was observed during this release; that path was covered
by the automated tests. A no-price account was covered by the authorization
tests, not a separate live account session.
