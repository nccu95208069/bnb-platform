# Calendar batch deletion and copy controls — 2026-10-19

## Status

Implemented on an isolated branch and verified with synthetic data. This is **not deployed**. The production write path is disabled unless `CALENDAR_BATCH_CANCEL_ENABLED=true` is explicitly configured. No live booking rows were deleted during development or verification.

## Behavior

- The sold calendar offers a date and guest-name filter plus explicit room-night checkboxes. Selection can span separate source order numbers. The preview lists every selected date, room, guest, and formal source order number and reports room-night and distinct-order counts.
- A source order is indivisible: if another room night shares its formal source order number, confirmation is blocked until that night is included. A quarantined or conflicted night sharing the order blocks deletion. A missing formal order number is treated as its own source row, never grouped by guest name.
- The server authorizes the property and owner/admin role, reads the complete current Sheet, verifies source-row identities, checks OS payment and finance links, and requires explicit acknowledgment for rows marked paid in the source. Confirmation re-reads the Sheet, requires an unchanged preview digest, takes the same property lock as payment and finance writes, deletes selected rows in descending order, and compares an authoritative readback with the expected remaining rows. A request journal prevents a replay from deleting a different set of rows.
- Order details expose copy controls for the displayed real guest name, OTA number, and formal source order number, with success/failure feedback. The hashed internal identifier is never substituted for a missing formal number.

## Release boundary and limitations

The Sheet has no atomic compare-and-delete primitive. An external human edit in the small interval between the final read and `deleteDimension` could race with deletion; the OS lock only coordinates OS writes. The full readback detects a mismatch and reports an unconfirmed outcome, but cannot undo a row deletion. Coordinate a pause of direct Sheet editing and take a backup before enabling the flag for live use. This is a release decision, not a claim of production acceptance.

Deleting a Sheet row does not cancel an OTA booking, issue a refund, or erase an OS receipt. Rows with OS payment or finance links are blocked, and paid source rows require acknowledgment. Calendar snapshot sync can lag the verified Sheet write. Operators should reload and check the source if any write returns an unconfirmed result.

## Verification

Synthetic tests cover 12 separate room nights across two dates, distinct source order numbers, partial and conflicted parent orders, stale/duplicate identities, paid and finance guards, write/readback behavior, the selection dialog, and copy feedback. TypeScript, ESLint, and a production build passed locally. The build used a local cached Geist font because the build environment could not reach Google Fonts; no font or dependency files changed.
