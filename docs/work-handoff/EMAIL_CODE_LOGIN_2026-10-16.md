# Email code login — 2026-10-16

The owner's latest decision supersedes the previous device-v2 presentation: send a randomly derived six-digit code in the email and show six entry boxes on both the initiating page and the email-link page. Code-v3 is opt-in so earlier clients and still-valid v1/v2 links keep working during rollout.

Each v3 request has a fresh random seed, a 15-minute expiry and a proof-bound request ID. No code is returned in challenge JSON or stored by the browser. The original browser submits the emailed code with its HttpOnly proof; a second browser requires the unguessable email link plus the code. Current-device sign-in is the default. Explicit approval of both devices allows the original browser to poll and receive its own session. Closing the page does not open it automatically; public request metadata lets the original browser resume within the original expiry. Clearing browser storage or expiry requires a new request.

Resending from the same browser for the same email and service invalidates the earlier request; delivery retries retain the same request and email. An atomic latest-request comparison prevents a concurrent resend from approving an obsolete code. Code attempts, request rates, single-consumer replay binding, credential rotation, exact service scope, account isolation, and calendar-context checks remain enforced. A six-digit value is not a permanent user identifier and collisions across requests are possible; verification is scoped to its own request.

Validation: 24 backend/route tests, 25 passwordless/owner UI tests, and 10 Studio-to-guest-to-OS integration checks pass. These cover email-only code delivery, code-only original-browser login, explicit device selection, close/reopen continuation, old-link compatibility, resend races, expiry, attempt limits and account isolation. The production Webpack build passes. Lint has zero errors and five pre-existing warnings. Local default Turbopack cannot follow this checkout's external dependency symlink; the successful Webpack build uses the same sources.

Release status: prepared for staged production deployment; deployment evidence will be added after release verification.
