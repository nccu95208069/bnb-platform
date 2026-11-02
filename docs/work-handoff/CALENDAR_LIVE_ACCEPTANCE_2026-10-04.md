# Calendar live acceptance — 2026-10-04

**Latest state:** the later [primary-domain owner pilot](#primary-domain-owner-pilot) supersedes the protected-only, primary-unchanged and sync-off completion state in the original acceptance record below.

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


## Primary-domain owner pilot

After the protected acceptance run, the owner explicitly requested completion through direct testing with their own data. They approved production configuration, the primary callback URL, durable customer storage, five-minute opt-in synchronization, promotion, one login email and one synthetic workspace with up to three bookings followed by guarded undo. This authorization supersedes the earlier no-production-mutation boundary. It does not authorize publishing the Google app to all accounts or merging PR #26.

### Released state

- Entry: `https://sweetfun-os.vercel.app/join`; returning users use `/start`.
- Runtime source: `fcbb05c525a40e381cf0ce95aa5652aa20d69e34`. Vercel production deployment `dpl_GRkexAWJq8Toyj5cyTh1ZEaXQNX2`, `https://sweetfun-byrqds9oh-sweetfuns-projects.vercel.app`, is READY. The primary hostname was read back against that exact deployment after promotion.
- Previous primary `dpl_4RtToxbsPMUWt1bw25Mn2cvUvg82` remains available for rollback. No PR merge was performed.
- Existing Google client credentials and stable token-encryption key are sensitive Production settings. The primary callback is registered alongside the prior acceptance callback. The existing session and cron secrets were retained. No secret values appear in this report.
- Customer data uses the existing durable `bnb:customers:v1` namespace. No acceptance-prefix cleanup may target this namespace. User accounts and future imports must remain intact.
- The Google Calendar worker is enabled at `*/5 * * * *`; the three existing minute schedules are unchanged. It reads only sources explicitly selected and confirmed for continuous mode. ICS/ZIP remains a file import with no automatic device polling. Google events are never written.
- The legacy public calendar remains anonymized; customer workspace reads and writes still require server-side account/property authorization.

### Primary-domain acceptance

One clearly named synthetic verification workspace was created through the public UI. Three ICS stays previewed before login. Exactly one email login link was requested, delivered from the existing transport, and opened in the requesting browser. Its destination used the primary origin. Login restored dates, room mapping and selected records; saving still required an explicit account confirmation.

The three bookings saved and remained visible after a full reload: October 18–20, October 20–22 and October 24–25 in the intended room. Missing money remained unknown. The import page reported three orders and zero blocks. Its guarded undo then reported **three undone, zero retained due to modification/payment**. The calendar readback showed no imported bookings and correctly removed the ability to treat unverified dates as available. The account and empty, clearly labelled verification workspace remain; neither is deleted. The consumed local login-link file was removed. No other customer bookings or source events were changed.

Anonymous requests to the new workspace returned **401**; `/join` and `/start` returned **200**. The uncredentialed cron request returned **401**. These checks verify application authorization without weakening Vercel deployment protection. The new deployment's post-release error-level log scan returned zero entries in the observed window; this is a bounded check, not ongoing monitoring.

### Actual scheduled delivery

Vercel's enabled Cron Jobs screen lists `/api/cron/customer-calendars` every five minutes. The production logs contain two automatic requests:

| UTC time, October 4 | Taipei time | Status | Platform user agent |
| --- | --- | --- | --- |
| 06:45:25.142 | 14:45:25 | 200 | `vercel-cron/1.0` |
| 06:50:25.181 | 14:50:25 | 200 | `vercel-cron/1.0` |

Both identify the released deployment and show the worker's Redis call. No authenticated manual invocation or dashboard Run button was used in this pilot. The production calendar-job registry contained zero jobs before release; the file-only verification workspace registers no Google sync job. This proves automatic platform delivery and worker/store availability, not processing of an already-connected real customer source. Real-provider refresh/source updates were exercised separately in the protected acceptance above; a user's future selected-source synchronization remains subject to their grant and explicit opt-in.

### Verification and remaining limits

The release also repairs Google refresh HTTP 400 `invalid_grant` handling: expired/revoked grants now ask the user to reconnect, while other refresh errors stay generic and existing bookings/grants remain unchanged. **133 service/API/auth and 20 DOM tests pass (153 total, no failures/skips)**; TypeScript and local webpack build pass; lint has zero errors and seven existing warnings; the cloud production build is READY. GitHub CI run `37183490218` on the runtime source was not started because the GitHub account is locked for billing; this is separate from local/cloud checks.

Google remains External / Testing with the approved owner account on its test-user list. Other Google accounts require a separately approved audience change or test-user setup. Google states that refresh tokens for External apps in Testing expire after seven days for these scopes; the user may need to reconnect. See [Google's token-expiration documentation](https://developers.google.com/identity/protocols/oauth2#expiration). Physical iOS/Android file pickers and OAuth/mail-app transitions, broader multi-account and collaborator flows, and real booking samples remain unverified. The pilot is ready for the owner to supply their own data; it is not a claim of general-availability acceptance.

To begin, open `/join`, choose **申請使用**, enter the real property and room names, then choose Google Calendar or the iOS/Android file path. Review room/date mapping and the selected period before saving. Google users can choose continuous mode explicitly; files must be reimported when their source changes. Start a fresh real-property workspace rather than reuse the clearly labelled verification workspace.
