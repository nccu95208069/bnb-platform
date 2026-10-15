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

Pending release and a real, independent email owner's first-order and inbox readback. Do not treat local mail stubs or provider acceptance as inbox receipt. No real payment settlement is part of this test.
