# Legacy calendar email recovery — 2026-10-19

The owner's latest request adds self-service email recovery for the existing two-property calendar member accounts. This supplements the earlier administrator-assisted shared temporary password flow; it does not change that flow or the separate new-customer workspace sign-in.

`/forgot-password` accepts the legacy member's login email. An active, unambiguous member with an existing personal credential receives a 30-minute link to `/recover-calendar-password`, including an active `god` member. The link contains a 256-bit random secret in a URL fragment; Redis stores only its SHA-256 digest. A new request invalidates the previous link. Suspended and unknown member records do not receive links. The initial owner credential remains outside this member recovery path.

The request endpoint uses same-origin checks, email and global rate limits, a generic response, deferred email delivery and a minimum response time. It does not reveal whether an account exists. The link is bound to the member ID, credential and current member version. Password completion requires a valid unused link and a 12–128 character password, writes with a compare-and-swap, checks the saved state, clears the token and invalidates the member's earlier sessions. A successful change sends an alert email without exposing the password. The browser removes the secret fragment from its address before making the verification request. The email links back to the current site only when its origin is the fixed primary OS host or a validated deployment under the Sweetfun Vercel team.

Local synthetic verification covers eligible and ineligible accounts, generic responses, deferred email, one-time use, expiry, replacement by a newer request, credential/member changes, old-session revocation, active `god` member recovery, and the API flow. Eight targeted tests, TypeScript, lint and production Webpack build pass. No real password was changed during local verification.

## Production release and remaining acceptance

The first staged build excluded `god` members. A narrow read-only lookup after the generic request and absent email confirmed the recipient is one active `god` member with a credential. The tested correction is commit `0b45f3b`; production-configured deployment `dpl_82LqW6ft8UQjsG6Hz1VNH7zPJmRh` was built with no domain assignment, then promoted to both Sweetfun OS aliases after the recovery page returned HTTP 200. The earlier staged deployment was not promoted again.

One corrected reset request was submitted through the primary URL. The recipient's Gmail inbox contained the new message from the configured Sweetfun OS sender with the expected subject and primary-domain recovery link; the member record showed a pending recovery token. The token and password were not read into documentation or committed. A runtime error-log scan found no errors. PR #54 remains draft and unmerged.

The recipient still needs to open the emailed link, choose a new password, and confirm a fresh login to the legacy two-property calendar. The agent did not consume the link, change the password, or claim that final login acceptance.
