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

Released on 2026-10-15: OS source `a0d8a2f` passed the production build and an unauthenticated Studio-auth request returned the expected 401. Guest Sites version 20 and Studio Sites version 65 were published successfully. The rollout enables the existing `stayform-studio-v1` client with a start timestamp; no individual new-site binding was added to environment configuration.

Real inbox and browser checks succeeded for an independent, previously unused Gmail plus-address: the Studio login message reached the inbox, same-browser verification created an empty Studio workspace, and the owner created a new property draft from blank data. The same address also received and consumed an OS login link; the new account has no earlier properties. No ChatGPT sign-in was needed for either application identity.

The owner explicitly approved publication of the synthetic text-only property. The new owner then completed the ordinary UI flow: blank draft, one double room, design selection, publication, new-calendar connection approval, inventory confirmation, and enabling both OS and website sales. The published site is `https://stay-8619511c2274.linlab.app/`; the separate owner workspace is `new-owner-a6237d16` and property ID is `69c1a837-956e-4b1b-bc52-43cba8d89ae1`.

At 21:27:35 Asia/Taipei, a different user-owned Gmail plus-address submitted the first synthetic guest hold through the public website: order `b442c50c-9403-4719-8aab-4e6fd240a547`, one double room for two adults, 2026-10-20 to 2026-10-21, total NT$1,800.50. The guest result and OS order detail showed the same order. The calendar showed one occupied room-night on October 20 and none on the checkout date. Payment remained zero; no deposit or financial transaction was recorded.

Live acceptance exposed a trailing newline in the configured rollout timestamp, which caused notification cron requests to return 503. The exact same cutoff was rewritten without whitespace (`2026-10-15T11:45:23.709Z`), read back as valid, and the existing source was redeployed as `dpl_GiehkSeih4aWiJzxJabvU9mCRNeV` / `https://sweetfun-qjznsb49v-sweetfuns-projects.vercel.app`. The deployment was aliased to the production hostname. Subsequent notification cron requests returned 200. When configuring this value, use an exact value argument or a file without a final newline. Production-sensitive registries are not returned by local `vercel env run`; missing local values must not be mistaken for absent deployed configuration.

At 21:35, Gmail contained both actual hold-created messages. Each was opened: one addressed the new owner and contained guest contact details; the other addressed the separate guest alias and contained the agreed no-payment and cancellation text. Both carried the same order number, dates, and TWD 1800.50 total. This verifies automatic notification activation for a newly approved site without per-site environment edits; provider acceptance alone was not used as the success criterion.

Cleanup completed through the normal UI: the hold was released/cancelled, no money was collected, October 20 returned to zero occupied room-nights, and both Studio and OS sales were paused. The original guest page read back the ended application and a fresh public booking tab showed that online bookings are paused. Gmail also received the two hold-released messages at 21:37. The published non-operational site and cancelled audit record remain available for review.
