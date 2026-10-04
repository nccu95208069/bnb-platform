# Calendar live acceptance — 2026-10-04

The desktop browser journey now has real-provider evidence: Google read-only consent, preview, explicit save, token refresh, revocation and reconnect; anonymous ICS/ZIP preview; actual email-link delivery and same-browser return; persisted bookings and two real sync-worker executions. This supersedes earlier statements that Google configuration and all browser acceptance were pending. It does **not** establish real-phone acceptance, automatic scheduler delivery or public release readiness.

## Environment and scope

- macOS Chrome; desktop and a 375 CSS-pixel responsive viewport. No physical iPhone/Android browser was available.
- Fixed protected origin: `https://sweetfun-os-sweetfuns-projects.vercel.app`. Final runtime candidate: `dpl_BZHBQAgmzjVoxnqJSAVbPDbXzTpc`, [deployment](https://sweetfun-kdd09622b-sweetfuns-projects.vercel.app). It includes the fixes below; its source was deployed before the documentation commit.
- Google Calendar API and a dedicated Web OAuth client are configured. The app remains External / Testing. OAuth credentials, token-encryption key and origin are deployment overrides; shared Production settings were not rotated.
- The owner explicitly approved one test account, up to three login messages, and a new synthetic-only Google calendar. Exactly one login email was sent and received.
- Shared Redis use was explicitly approved for one newly generated acceptance namespace only, capped at four workspaces and twelve bookings. Actual usage: three workspaces, nine synthetic bookings and one account. This is scoped use of shared storage, not a claim of a separate database.
- No unrelated Google calendar events, real guest records, payments or existing workspace records were read or changed. Calendar-list metadata was used for source selection.

## Observed results

| Scenario | Result and evidence |
| --- | --- |
| Google onboarding | Real account selection and both read-only Calendar permissions returned to the preview. Before save, scoped storage contained a temporary draft/preview and no durable workspace. Explicit confirmation created one workspace and batch. Reload preserved the preview and saved result. |
| Stay dates and money | A two-night all-day event became October 10–12, with exclusive checkout. A timed event from October 12 at 15:00 to October 14 at 11:00 became the expected two-night stay in Asia/Taipei. Room mapping matched. Missing totals stayed null; no payment transactions were invented. |
| Actual refresh | Only the approved test grant's stored access-token expiry was forced into the past. Reading the source succeeded through Google's token endpoint and authoritative encrypted-grant inspection confirmed a renewed expiry and retained refresh capability. No token values were emitted. |
| Sync source changes | The source's first stay shortened to one night, the second event was removed, and a third two-night event was added. The first worker execution updated A and added C; removed B remained held for review because received money was unknown. Availability stayed blocked. |
| Repeat worker execution | Two authenticated HTTP executions of the real cron handler, at 02:39:25 and 02:43:59 UTC, each processed one workspace with zero failures. The second left three orders and two batches, with no duplicates. These were manual invocations, **not observed Vercel scheduled deliveries**. |
| Revocation/reconnect | Removing the app's Google access produced the visible expired/insufficient-permission message. Existing bookings remained. Reauthorization returned to the same property; reading the two remaining source events showed both as already imported and the missing event as cancelled/pending review. |
| Cancel/partial consent | Cancelling new-customer consent retained the draft and showed recovery instructions. Partial workspace consent exposed a redirect defect, repaired below. The repaired deployment was verified with real cancellation returning to the original property; regression coverage also exercises partial-token responses and preserves the previous grant. |
| iOS-labelled ICS path | Three synthetic stays previewed anonymously. Login was requested only after save confirmation. One real email link arrived, used the fixed origin, and returned in the requesting browser with dates, room mapping and selection preserved. A second explicit confirmation saved three bookings. Reload and store readback matched. |
| Android-labelled ZIP path | A ZIP containing ICS previewed three stays; exact room names in event titles mapped all three to the intended room. Saving with the existing verified session created the third workspace. Reload and store readback matched, with no extra email. |
| Responsive layout | The onboarding/import page was inspected at desktop and 375-pixel width without page overflow after the layout fix. This does not verify phone file pickers, native Calendar data or mobile OAuth browser transitions. |

All nine saved bookings retained unknown totals and zero payment entries. Google had three records, including the held cancellation; each file-import workspace had three records. File dates included adjacent October 18–20 and October 20–22 stays and a one-night October 24–25 stay.

## Repairs and final verification

1. The persistent `/join` layout rendered the questionnaire above `/join/calendar`. It is now hidden outside `/join` and `/join/contact`, while retaining form state for back navigation.
2. An expired new-customer callback fell back to a page that did not show its error. It now returns to the draft recovery screen, or the sign-in error screen when no draft cookie is present.
3. A failed existing-workspace callback could follow an unrelated completed onboarding cookie to another workspace. Its failure destination now comes from server-stored OAuth state validated against nonce, actor, expiry and current property access before token exchange. The import page explicitly displays failure feedback. Cancelled/partial consent cannot overwrite the previous encrypted grant or booking data; invalid state proof cannot expose a workspace destination.

The final customer CI command set passed **132 service/API/auth tests and 20 DOM tests (152 total, zero failures/skips)**. The corrected unrelated-draft-cookie regression was rerun and passed. TypeScript passed. ESLint reported zero errors and seven existing warnings. The final Vercel cloud production build is READY; local webpack also passed earlier in this acceptance run, while local Turbopack encountered the environment's port-binding restriction.

Self-review rechecked callback state validation, protected redirects, property authorization, retained credentials, unchanged financials and cleanup boundaries. No unresolved critical defect was found in this scoped review. Remote GitHub CI status must be reported separately from these local and cloud checks.

## Completion boundaries

Continuous sync was disabled again before the final candidate. Test data, test grants and the temporary scheduler registration are cleaned only within the approved namespace; the created calendar is retained empty and synthetic events are recoverably deleted. Provider access is revoked after reconnect acceptance. Cleanup readback and final domain/protection checks are recorded in the completion note below.

Remaining before a broader rollout: real iOS Safari and Android Chrome consent/file selection and email-app return; actual Vercel scheduled delivery; a separately authorized multi-account live test and real-sample pilot. Account-switch, wrong-browser and duplicate-response protections have automated coverage, not additional live identities in this run. The Google app remains in Testing and sustained refresh beyond its testing-token lifetime is not established. The primary domain is not promoted, and PR #26 remains a draft.

## Completion readback

Cleanup deleted 38 remaining keys in the exact approved prefix and a bounded scan read back **zero** keys. The three workspaces, nine bookings, test account, encrypted grants and job registration were removed. Expiring draft records had already expired where absent. Only sanitized counts/date evidence is retained locally; the consumed email-link file and temporary local worker secret were removed.

The Google calendar month view contains no test events after recoverable deletion; the empty calendar itself remains. The exact application grant was revoked, and Google connection search no longer returns it. Final anonymous checks against both the fixed alias and deployment returned HTTP 302 to `vercel.com`, preserving authentication protection. The fixed alias resolves to `dpl_BZHBQAgmzjVoxnqJSAVbPDbXzTpc`; primary `sweetfun-os.vercel.app` still resolves to `dpl_4RtToxbsPMUWt1bw25Mn2cvUvg82`.
