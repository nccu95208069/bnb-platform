# Studio email onboarding and automatic new-property notifications

The owner requested automatic notification activation for newly onboarded properties and a full first-order acceptance using a new owner. They clarified that an ordinary Gmail/email identity must work without a ChatGPT account.

## Implemented behavior

- The public Studio offers email-link signup/login. The existing mail transport sends a 15-minute link to the configured Studio origin. A persisted browser proof binds the link to the initiating browser; the new account is created only after verification.
- The Studio's private guest-service bridge authenticates to OS with its existing service credential. Browser responses never contain the service credential or account session. The account session is stored only in a Secure, HttpOnly, host-only cookie and validated by OS on protected requests. Revoked or invalid email sessions never fall back to a different ChatGPT identity.
- Email users receive independent Studio ownership (`email:<account UUID>`), with existing project authorization unchanged. Existing signed-in legacy owners retain access to their original projects. No automatic email-based account merge is performed.
- Internal email delivery accepts a specifically configured Studio client that was admitted through the existing self-service origin setting. Approved UUID site bindings then join delivery without a per-property environment edit. External notification workers retain their exact scopes.
- `WEBSITE_BOOKING_STUDIO_EMAIL_START_AT` limits the initial automatic rollout to bindings approved at/after its timestamp. Existing explicit binding/site scopes remain unchanged; historical pilot outboxes are not automatically enabled.

## Source integration and validation

The active production source `d105454` contained newer calendar presentation changes but lacked the earlier `1ae8320` Studio booking additions. This branch integrates both histories, retaining the current calendar behavior and the previously accepted new-property flow.

Local validation: 122 website/passwordless checks, 5 HTTP/Redis concurrency checks, 52 UI/calendar checks, 8 Studio/guest/OS email-signup integration checks, 19 multi-property booking integration checks, 13 account-isolation checks and 12 self-service checks passed. TypeScript and the production Webpack build passed; frontend lint has zero errors and five pre-existing warnings. The normal local Turbopack build cannot follow the workspace's external `node_modules` symlink; the equivalent Webpack build completed.

The existing self-service test fixture was updated to read the current multimodal import input. The booking integration assertion now includes the visible UI error if its form is missing; its subsequent complete run passed.

## Production acceptance

Released on 2026-10-15: OS deployment `dpl_HxK4RR7zsDAVGUhQW69V5y8Sf9yJ` (source `a0d8a2f`) was promoted after the production build and an unauthenticated Studio-auth request returned the expected 401. Guest Sites version 20 and Studio Sites version 65 were published successfully. The rollout enables the existing `stayform-studio-v1` client with a start timestamp; no individual new-site binding was added to environment configuration.

Real inbox and browser checks succeeded for an independent, previously unused Gmail plus-address: the Studio login message reached the inbox, same-browser verification created an empty Studio workspace, and the owner created a new property draft from blank data. The same address also received and consumed an OS login link; the new account has no earlier properties. No ChatGPT sign-in was needed for either application identity.

The synthetic property has one double room, one room available on 2026-10-20, an initial nightly price of NT$1,800.50, and explicit non-operational/no-payment wording. It contains only newly authored test text and no photos. Its configuration is saved as an unsubmitted browser draft. Automated approval review rejected checking the material-rights/publication attestation without the owner's explicit authorization. The owner has been asked to approve that exact statement; the site remains unpublished and no connection or order has been created. Resume at this confirmation, then approve the new property in OS, activate its sales, create one synthetic guest hold, verify both actual notification inboxes, cancel the hold, and pause sales.

First-order and booking-notification inbox acceptance therefore remain pending. Do not treat local mail stubs or provider acceptance as inbox receipt. No real payment settlement is part of this test.
