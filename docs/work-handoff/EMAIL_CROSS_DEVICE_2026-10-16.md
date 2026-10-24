# Email sign-in across devices — 2026-10-16

The owner requested computer-to-phone email verification, correction of the plus-address guidance, and removal of password/ChatGPT marketing text. This supersedes the same-browser requirement for newly issued Studio and OS login links. Existing short-lived links remain supported for their original lifetime.

## Behavior

- An email link may be opened in another browser or device. The verification page displays the intended account before the user confirms.
- A recipient may sign in only on the device opening the link. This does not authorize the initiating browser.
- To sign in on both devices, the recipient enters the six-digit code displayed on the initiating login page. The original page polls with its own HttpOnly proof and resumes after explicit confirmation. A link alone cannot silently authorize a third party who requested mail to someone else's address.
- Same-browser verification remains one confirmation click. Login links expire after 15 minutes. A consumed link is bound to the approved consumer proof; only that consumer and, if explicitly approved, the original browser may recover a lost response. Other-device replays and credential rotation are rejected.
- Confirmation-code attempts are bounded per request. Mail sends remain idempotent. Account creation, credential verification and link consumption use the existing atomic store transaction. Authentication and service credentials are never returned in public JSON.
- Studio opts into the new protocol so OS can deploy before the guest bridge and Studio without breaking the old live client. Exact Studio origin/client admission, account isolation and logout behavior remain enforced.
- OS calendar drafts retain their separate preview authorization and explicit save step. Mobile verification cannot claim another draft or transfer its source authorization. The original browser resumes its existing prepared draft after verification.
- Login accepts valid email addresses without a provider allowlist. Plus suffixes belong before `@`, for example `member+test@example.com`; a suffix after the domain is rejected with an actionable inline hint. The login page now says “請輸入可收信的電子信箱。”

## Verification

Implemented and locally verified: 28 backend/route checks; 23 relevant UI checks (including the cross-device UI flow); ten real Studio→guest→OS integration checks using isolated cookie jars and a mail stub; thirteen account-isolation checks. TypeScript passes. Frontend lint has zero errors and five existing warnings. The production Webpack build also passes. Production acceptance is recorded below after completion.

The cross-device integration exercises actual login form scripts, two independent browser cookie jars, the two built Workers, and OS account operations. The initiating page shows a code, the other page verifies the intended email, an empty code cannot grant both devices, and the correct code lets the original page obtain its server-set session. Additional checks cover phone-only sign-in, scope/proof swapping, replay, expiry, code attempt limits, concurrent consumption, non-Gmail domains and exact plus-address preservation. These are not claims of physical-phone or provider inbox acceptance.

## Release and live acceptance

Released on 2026-10-16 (Asia/Taipei). OS implementation commit `7ffba42f26d8a95a93c3bd404da24f704d39a21d` is deployed as Vercel `dpl_GQtWjSQ1Ux2ZBUUcWeJDeqpKBF5B` and promoted to `https://sweetfun-os.vercel.app`. Guest v21 (`appgdep_6ad105d0a32c8191b09bf5d3c13fd244`) and Studio v66 (`appgdep_6ad106a686c0819185f25c472a7dcdb2`) both completed successfully. Their existing public audience and environment revisions were preserved. PR #42 remains draft and unmerged.

Real production acceptance completed at approximately 01:08:

- A fresh Gmail plus-address requested a login link from the production Studio login form in Chrome. The real inbox received the new message, including the cross-device instructions.
- The link opened in Safari, with independent cookies. It displayed the correct account and offered both-device confirmation or current-device-only login.
- Entering the six-digit code from the original Chrome page and confirming signed Safari into the new account. The original Chrome page automatically resumed to `/studio/` with the same account, without opening the email link in Chrome.
- Both sessions showed an empty new-owner workspace; no website, customer order or AI request was created during this acceptance.
- Invalid `name@gmail.com+test` input shows the correction hint; the valid plus-address round trip preserved the complete address. The public login page has the neutral example and revised footer.
- The two temporary test sessions were signed out after verification.

This verifies a real delivered Gmail link and two independent desktop browsers. Physical-phone and other-provider inbox delivery were not exercised in this acceptance; non-Gmail addresses and phone-only behavior are covered by the automated checks above. Local screenshots are in the enclosing project workspace's `verification/cross-device-20261016/` directory and are intentionally excluded from this repository because they include the test email address.
