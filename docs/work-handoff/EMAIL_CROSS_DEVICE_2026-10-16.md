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

Pending deployment and real inbox/browser acceptance.
