# Sheet import handoff — 2026-10-20

The owner wants the primary path to be: paste a Google Sheet link, let the OS check it, then open the calendar. The previous wizard exposed mapping, row-selection, and a post-import success message on the import page. That made a completed import look unfinished, and returning to the preview repeated technical choices.

The latest owner decision supersedes the separate final-selection step described in `SHEET_FULL_HISTORY_CALENDAR_PARITY_2026-10-19.md` for a fully validated Sheet. The explicit **檢查並匯入訂房** click now authorizes checking and importing if every normalized order is valid. An approved onboarding link may still open a read-only preview automatically; merely opening that link never commits bookings.

- A clean, unambiguous source is committed through the existing versioned, idempotent preview/commit API and then opens the property calendar. The calendar reads the committed batch before showing the imported count.
- An ambiguous format, unknown room, overlap, duplicate, or invalid row stops the one-click path. The page shows how many orders are safe and how many remain out. The owner can import the safe subset or inspect and repair details. Problem rows are never imported implicitly.
- Previously imported batches open a calendar handoff instead of re-reading the Sheet and displaying the row table. Detailed source records, retry, and undo remain available in a collapsed management section.
- Historical import still does not assert complete future inventory coverage or enable website sales. The source Sheet remains read-only, and later changes are not continuously mirrored by this one-time import.

Focused UI tests cover the clean one-click path, ambiguous money, missing room mapping, partial selection, lost-response retry, existing-batch handoff, and read-only onboarding preview. Production release should verify the import page and calendar navigation with an authorized workspace; synthetic tests cannot establish that every real source row is correct.
