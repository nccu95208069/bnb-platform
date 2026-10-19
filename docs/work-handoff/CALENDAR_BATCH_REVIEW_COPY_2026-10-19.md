# Calendar batch review and copy controls — 2026-10-19

## Status

Implemented on an isolated branch with synthetic verification. This is **not live on the primary domain**. The batch review UI is opt-in with `CALENDAR_BATCH_REVIEW_ENABLED=true`; it reads the live source but never changes it. No live booking rows were deleted during development or verification.

On 2026-10-19, the reviewed PR tree was staged as production-target deployment `dpl_H5zG26r2UM4Moa5XqsfYwwdHCcQF` at `https://sweetfun-6hl919dt9-sweetfuns-projects.vercel.app` with `--skip-domain` and a deployment-only `CALENDAR_BATCH_REVIEW_ENABLED=true`. The cloud build and TypeScript passed. The unique URL and project alias require Vercel Authentication. Through the authenticated Vercel test path, `/start` returned 200, anonymous `/calendar` redirected, both calendar and preview APIs returned 401, and a batch `confirm` request returned 405. No staged runtime error was recorded. The primary hostname remained on prior deployment `dpl_gw3LHkEMc2WL9mrbiTkKJ55bnZYs` after staging. Authenticated calendar/UI acceptance remains pending: Google login on the staged host redirects to the configured primary-domain callback, so acceptance needs a direct email-code or existing-password sign-in on the staged host. Do not promote until that check passes and the primary alias is checked again.

## Behavior

- The sold calendar offers date and guest-name filters plus explicit room-night checkboxes. A review can span separate source order numbers. The server reads the current Sheet and returns every selected date, room, guest, and formal source order number, along with room-night and distinct-order counts.
- If another room night shares a formal source order number, the review shows that omitted night. A quarantined or conflicted night sharing the order blocks the review. A missing formal number stays an independent source row, never grouped by guest name.
- The server enforces owner/admin property authorization and checks OS payment and finance links so the preview can warn about reconciliation work. Paid source rows are labeled. The endpoint accepts `preview` only; a `confirm` request returns 405, and there is no Sheet mutation code in this batch flow.
- Order details expose copy controls for the displayed real guest name, OTA number, and formal source order number, with success/failure feedback. The hashed internal identifier is never substituted for a missing formal number.

## Critical deletion finding

The original implementation sent `DeleteDimension` requests using row indices read just beforehand. If an external Sheet editor inserted or moved a row after that read, the request could remove a different booking. The subsequent readback would report an error but could not restore the wrong row. The OS property lock does not constrain direct Sheet edits. Google Sheets API v4 documents row deletion by numeric `startIndex`/`endIndex`, without a source-ID compare condition: [migration guide](https://developers.google.com/workspace/sheets/api/guides/migration#delete_a_row), [batchUpdate reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate).

The hard-delete route, writer service, confirmation button, and optimistic removal have therefore been removed. Operators must manually inspect and change the source Sheet after using the review list, then separately handle OTA cancellation and refund/reconciliation. A future automatic deletion feature needs a source-side operation that can atomically identify and remove the intended record, or a change to an exclusively controlled source of truth. Do not re-enable index-based deletion with a longer delay, more reads, or only an OS lock.

## Verification

Synthetic tests cover 12 separate room nights across two dates, distinct source order numbers, partial and conflicted parent orders, stale/duplicate identities, the read-only route boundary, the selection dialog, and copy feedback. TypeScript, full frontend ESLint, and a production build passed locally. The build used a local cached Geist font because the build environment could not reach Google Fonts; no font or dependency files changed.
