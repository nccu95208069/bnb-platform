# 訂單收款簡化 — 2026-09-08

Owner accepted M1 and requested a direct operational screen. `/finance/summary` now displays current check-in month, with global historical search by booking IDs, room or date. Main cards contain order, verified receivable, recorded receipt, outstanding and one Record receipt CTA. Unknown totals remain unknown; no receipt record is shown as 未登記 rather than zero. Agoda claim is a small badge with legacy provenance explained in details. Other platforms do not show an irrelevant claim panel.

Removed user-facing capture/version/registry diagnostics controls. Existing registry and authorized API remain intact; this change does not implement background registry capture or Sheet writeback. Technical identities are no longer the main user task.

Record receipt opens a single-order form: amount, received date, method, optional note. Uses the existing finance POST, live source checks, financial permission scope, projection version, idempotency and verification. Empty note uses a generated lodging description because the existing income API requires one. No amount is automatically inferred/prefilled, no stage is silently set to full. Same existing server-side maximum applies; an unavailable/full/conflicted order is not bypassed. For platform orders, the form explicitly asks for actual property receipt, not a claim request. OS-only persistence remains unchanged.

Review: request-key fetch isolation, abort on unmount, selected order ID binding, pending replay payload, disabled uncertain form, permission reuse and optional-note compatibility checked. No critical issue found. No real payments generated for testing. Focused model/route/receipt contract tests and TypeScript passed. Browser/deploy result appended below.

Verification: full frontend suite 121 passed; TypeScript passed; ESLint zero errors (two existing calendar warnings). Vercel production `sweetfun-33wmppmk1-sweetfuns-projects.vercel.app` aliased successfully. Mobile 390x844 verified global search finds the accepted Agoda order and shows the unclaimed badge. Record receipt opens the matching single-order modal with empty amount, date, method and optional note. Browser errors empty. No real receipt submitted. Existing PR #17 updated; main merge remains deferred because of the separate baseline integration dependency.

## Whole-booking prefill

Owner requested automatic full room-charge amount. Receipt form now prefills existing order receivable (sum of all linked room-night charges, less OS-recorded receipts), remains editable, and shows all linked room numbers, check-in through checkout, whole-booking room-charge total and any recorded receipts. This is based on current source amounts, not new verification of platform settlement basis. Independent order IDs are not merged by name or date. Added two-room/two-night regression with a single deposit deducted once; TypeScript, lint and focused tests passed. Review found no critical issue; no real receipt was submitted.
