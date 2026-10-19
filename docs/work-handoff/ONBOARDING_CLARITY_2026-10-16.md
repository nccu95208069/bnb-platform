# Customer onboarding clarity and 3,000-row import — 2026-10-16

## Owner feedback addressed

The owner completed a Sweetfun test application and found five points to repair: the password rule was too long; the generic “format differs” disclosure gave no useful next step; the 501-row guard stopped a real Sheet; mixed room and whole-property inventory was unclear; and Sheet sharing needed an illustrated, separate help page. Submission alone does not create a calendar. The success copy now names the remaining email verification, field/room mapping, preview, and confirmation steps.

## Implemented on this branch

- Customer account creation, recovery, and new collaborator passwords accept 8–128 characters with an ASCII English letter, digit, and punctuation mark. The distinct internal calendar-owner password policy remains at 12–128 characters. Server validation and all relevant customer forms agree.
- The generic “表格格式不同、逐晚拆列或需要協助？” disclosure was removed. The mapping and preview stages offer a clearly labelled support request; previews show specific row issues before confirmation.
- Google Sheet reader, shared service-account reader, CSV/XLSX parser, normalizer, and commit selection share a 3,001-total-row ceiling (normally 3,000 data rows and one header). The 52-column and 2,000-character-per-cell guards remain. Decoded row JSON is limited to 3 MB, Google response bodies to 4 MB, uploads to 3 MB, and expanded XLSX to 8 MB. Room-night and workspace limits remain separate. The old 501-row boundary was a payload guard, not a booking-domain requirement.
- Google user-authorized reads request the whole selected tab instead of the first 53 columns, then reject an over-wide result rather than silently dropping columns.
- Preview renders 100 orders per page while preserving the cross-page selection; grid mappings also render 100 occupied cells per page. The server accepts up to 3,000 selected orders in one batch.
- Mixed-mode room setup says to enter only physical rooms: a whole-property booking occupies all of them and is not an extra room. More complex partial-property setups still use consultation.
- `/guides/share-google-sheet` explains four sharing steps with labelled schematic illustrations and the configured share address. Links in `/join` and the workspace import page open it in a new tab. It distinguishes Google Sheet from Google Calendar and points to Google's current sharing help.

## Verification and release boundary

Twenty-one relevant synthetic tests passed, including a 3,000-order preview, commit, and exact retry, and CSV row-boundary checks. TypeScript, full frontend lint (zero errors, five existing warnings), and the production Webpack build passed. The guide was visually checked at desktop and 390-pixel mobile width. No real Sheet was imported, no account password was changed, and no production deployment was performed on this branch.

The supported source size is bounded by both row and byte ceilings. Very wide or unusually text-heavy 3,000-row sources can still be rejected with a clear size error; do not advertise an unlimited import. The real Sweetfun source copy has 1,743 rows and 18 populated columns in the current snapshot, below these ceilings, but the actual authenticated production flow still needs owner acceptance after a release.

## Production release — 2026-10-16

The owner authorized merge and deployment. PR #45 merged into `codex/email-code-and-builder-fixes-20261016`; PR #44 then merged the standard-workbook v5 update on the same branch. Their resulting source commit is `c4ac224c96abada5e7738a941a395831bcb30544`. Vercel production deployment `dpl_4EEqMUY4hPNm3oXN1yzU5zt6Ha6d` was built from that checkout, tested at its deployment URL, and promoted to `https://sweetfun-os.vercel.app`.

Combined verification passed 98 relevant service tests, seven customer route tests, 20 customer UI tests, TypeScript, frontend lint (zero errors, five existing warnings), local Webpack build, and hosted Turbopack build. Unchanged backend tests passed 166 with 45 skips; backend app lint and format passed. Whole-backend lint still reports seven existing `F811` fixture redefinitions in `tests/test_availability.py`. The promoted deployment returned HTTP 200 for `/join` and `/guides/share-google-sheet`; an unauthenticated workspace read returned 401. The guide rendered its four steps on the primary domain, and the new deployment had zero error-level runtime log entries at verification.

No real customer Sheet was imported as part of this release, and no customer password was changed. The owner can now run the authenticated import flow and review its mapping, preview, and conflicts before confirmation.
