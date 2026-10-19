# Onboarding and Sheet release gates — 2026-10-19

## Why this gate exists

Four owner-visible regressions reached production during the first Sheet onboarding release: a verified email link returned to source selection, rows without an order number displayed false missing values, a today-based cutoff hid historical reservations, and the customer calendar did not use the established sold-month presentation. The old CI workflow only ran for a short list of PR base branches. PRs against the active release branch therefore had no GitHub checks.

## Required evidence before the next onboarding or calendar release

1. **Entry:** A verified first-property email link with an approved Sheet opens a read-only import preview. A missing room mapping goes to an explicit review step. No preview request commits bookings.
2. **Source shape:** Run the exact Sweetfun 12-column fixture with an old row and a future row. A blank order number plus a unique J-column row ID creates one candidate per row; duplicate or blank row IDs remain in review. Show mapped source values even when a row is invalid. Never infer one order from matching guest names.
3. **Scope and sale safety:** The default import scope includes the supported history. Import history and verified future sale coverage are separate. A Sheet property with unconfirmed coverage must not report blank dates as available or create a new booking.
4. **Calendar:** The customer sold-month view uses the existing month component, channel colors, room and channel filters, search, and day detail. Verify the UI with synthetic occupied rooms against the owner-provided `/calendar?mode=sold&view=month` reference. An empty calendar in an unimported workspace must state that blank dates are not proof of availability.

The source, import, onboarding, availability, and calendar tests in `frontend/tests/` cover the deterministic behavior above. The UI comparison remains a read-only browser check with synthetic records; no test should contain guest data or a private Sheet export.

## Release procedure

1. Open a PR against the actual release branch. **Stop if the PR has no CI checks**; do not treat an empty checks list as a pass. Wait for backend, frontend, and customer-workspace jobs to pass. Review and fix P1 or higher findings.
2. Build and stage the exact merged commit as a protected production candidate without changing the primary alias. Verify the start page, unauthenticated session boundary, and error logs.
3. With an authorized test workspace, inspect the real Sheet **preview only**: source row count, historical and future coverage, candidate/review counts, and mapped columns. Do not press final import. Inspect the sold-month page and compare it with the reference.
4. Promote only after the candidate checks pass; then confirm the primary alias points to the expected deployment and repeat the read-only checks. Record unresolved source conflicts separately from software errors.

Automated tests and staging reduce recurrence; they cannot prove arbitrary future Sheets are clean. Conflicting or overlapping source rows still need owner review before actual import or sale coverage is confirmed.

This workflow makes CI visible on every PR, but it does not itself configure GitHub branch protection. Until required checks are enabled for the release branch, a person with merge permission can still bypass the procedural stop rule. Configure required checks after verifying the first all-PR run and selecting the stable job names.
