# Sweetfun 訂單明細收款與主表回寫

## Owner decision

2026-10-05: The owner requested one receipt entry point in the existing Sweetfun OS order detail, with either explicit paid confirmation or a received amount, method and account. The follow-up explicitly requires writing back to the main Sheet. This decision supersedes the earlier OS-only / source-read-only boundary for this narrowly scoped payment operation. Calendar imports, customer workspaces, OFFLAND and other source fields retain their existing behavior.

## Behavior

- One **登記收款** button opens two choices: **登記本次收款** and **直接標示已付清**.
- Paid confirmation is a zero-amount status event and does not create finance income. A receipt records the actual amount once, and the existing finance projection includes its account snapshot.
- Bank/card payments can select the property's existing finance account or enter an account name and last five/four digits. Other-account entry is a snapshot for this receipt, not a new shared finance account.
- Sweetfun main Sheet H (`全額支付狀態`) becomes `done` when the whole order is confirmed paid or known recorded room payments cover its total. A partial/other receipt preserves the existing status. All room-night rows belonging to the order are handled together.
- The receipt's amount, method, masked account, time, actor, optional note and idempotency marker are appended to the H cell's **note**. Existing cell notes and all unrelated cell values, formatting and columns remain intact. These are notes on the existing payment cell, not new amount columns.
- An authenticated server-side empty Sheets write batch checks permission when the form opens. Service credentials remain on the server. The existing monitor keeps its read-only OAuth scope.

## Persistence and recovery

The shared property lock serializes OS receipts and finance allocations. The receipt plus pending Mission is committed and read back before external synchronization. A newly resolved set of stable source UIDs and booking fingerprints must match the saved plan before every Sheet write. The writer uses a fixed allowlist for the Sweetfun spreadsheet and tab, then reads back every target and the exact receipt note before marking both the receipt and Mission verified.

A lost response, write rejection or failed readback leaves the same receipt pending. Retrying reuses it and its note marker. The detail can resume this pending operation after refresh; another receipt for the order is blocked until recovery. A source change or ambiguous order fails closed; the writer does not guess another row. Internal source IDs and fingerprints are not exposed in the detail response.

Google Sheets does not offer compare-and-swap with human edits. Fresh identity checks, a single batch for the entire order, and authoritative readback detect conflicts; they cannot make the Sheet and Redis one atomic transaction or prevent a simultaneous manual edit between the read and write. No real guest payment was changed for development verification.

## Verification and release

Implementation verification covers receipt validation, status-only finance behavior, scoped accounts, multi-room/night writes, row relocation, source conflicts, formula preservation, lost responses, failed readback, retries after refresh, and UI submission behavior. Release results and deployment references are recorded below after verification.

Local TypeScript and ESLint pass (six unchanged warnings). Webpack production build passes. The default local Turbopack build is blocked by the environment’s denied internal port binding; no application build error was reported by the successful Webpack build. The integrated customer/API/DOM and analytics checks retain the newly deployed reception-type onboarding requirement. Test fixtures were updated for the already-live labels and report context, without reverting that behavior.

### Current handoff boundary

- Local payment/finance/Sheet checks: 94 service/domain checks plus 5 UI checks pass. The integrated 142 customer/API checks, 26 analytics checks and 26 other UI checks pass after adjusting three onboarding fixtures to the already-live reception labels. TypeScript, lint and Webpack production build pass.
- Implementation commits: `ea28672`; current-production preservation merge: `d52d242` (includes `6179335`); regression/verification follow-up: `7d1224a`.
- GitHub push was rejected by automatic approval review: the request was deemed insufficiently explicit for disclosure of this new code to the external repository. An explicit permission question names `nccu95208069/bnb-platform` and `sweetfun-os.vercel.app`. No alternate push or deployment was attempted after rejection.
- A full production environment download was also rejected because it would retrieve unrelated secrets. No secrets were downloaded; the replacement is the application's authenticated server-side capability probe. Its actual live result remains unverified until the new application can be deployed.
- The currently observed primary deployment remains `dpl_CsvRTNQ1jj9rtFnkHfZn5vveehKG` / source `6179335`. No real guest payment, main-Sheet cell, financial ledger or production setting was changed.
- A synthetic static local preview was generated from the tested component. The browser disallowed local `file:` URLs; no alternative browser access was attempted. This is not a completed browser/phone visual acceptance.
