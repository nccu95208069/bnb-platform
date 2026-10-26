# STAYFORM password authentication — 2026-10-27

Issues: #88, #89, #90, #91. Implementation and isolated verification are complete. Deployment identifiers and public readback are recorded in issue #91 after publication.

## Behavior

STAYFORM single-site building, batch building, Studio and management use the existing verified Email account and seven-day HttpOnly session. Ordinary password login sends no email. First password setup verifies email possession before account creation; existing accounts retain their ID, workspace memberships and ownership. Forgotten-password links expire in 15 minutes, are single-use, carry a fixed Studio origin and safe return path, and cannot create a login session. Completing setup/reset requires explicit password login and invalidates prior customer/Studio sessions by rotating the credential revision.

Passwords are 15–128 characters for this flow, allow spaces and use the existing salted scrypt implementation. Unknown and passwordless accounts use dummy password verification. Login and mail requests are rate limited. Recovery replies do not disclose whether an account exists; both cases persist the same outbox shape and mail work runs after the HTTP response. The existing minute scheduler recovers unstarted outbox jobs. A provider result that may already have sent is never blindly retried; the user may request a fresh link.

The Guest bridge forwards only scoped authentication actions and approved response fields. The Studio stores credentials in Secure, HttpOnly, SameSite=Lax host-only cookies. Passwords and reset tokens are never persisted in browser storage; link fragments are removed immediately. Single and batch source drafts are session-local and keyed to their owner. Restoring a draft does not submit a job or grant publication authorization.

## Legacy accounts

The companion Studio migration adds `studio_account_links` with unique Email and legacy owners. Linking requires a verified Email session, the platform-provided original ChatGPT identity, an expiring session-bound proof, explicit confirmation and fresh target-password authentication. The original site's owner ID is retained. Linked users can switch between the Email scope and original legacy scope. Administrator privilege is checked against the Email authentication identity and is not inherited from the linked owner.

No production legacy account has been linked during this task. The existing ten-property batch remains under its original owner until that owner completes the verified binding flow. Matching display emails, guessed owner IDs and administrator access are not ownership proof.

## Review and verification

Self code review covered account takeover, CSRF, redirect validation, token expiry/replay/races, session revocation, provider failure, mail enumeration, privilege inheritance and cross-owner reads/writes. No open P0/P1 findings remain in the reviewed changes.

- OS: 42 tests across password auth, mail/error mapping, legacy email auth, passwordless/device flows, Gmail MIME and email cron. Real network/mail are stubbed in tests.
- Studio → Guest → actual OS operations: 9 password/account integration and UI checks, plus 10 legacy email checks.
- Existing behavior: 13 isolation checks, 16 batch integration and 5 batch UI checks, 14 management integration and 7 management UI checks.
- Frontend lint: no errors; seven existing warnings outside changed code. Changed files also pass targeted lint and TypeScript checks.
- Production build passes with Webpack. Local Turbopack encountered host subprocess/port restrictions; remote production build must pass before publication.
- Real browser: desktop login/setup and captured local mail → reset page; 390px viewport (375px content), no horizontal overflow or console errors. Full credential mutations are exercised with isolated automated fixtures.
- No real emails, user password changes, legacy bindings, booking writes or paid generation jobs were used for acceptance.

## Release safety

Baseline `4f5b35ea6a7b6d892b9c0c6eff3cd80eeb28fff7` matches all 694 tracked source files uploaded in production deployment `dpl_ErAZ5RVcgRGcxi8kDuAXV91XQMEz`; only generated next-env and build cache files are untracked. Preserve existing production environment variables and all booking/notification feature flags. Release OS first, then the Guest bridge, then Studio with its generated migration. Each layer retains the previous email protocol for compatibility.

The registered email transport is reused, but actual recipient inbox delivery remains a user acceptance boundary; mock delivery is not proof of live delivery. Rollback should keep the additive account-link table. Do not revert the backend while the password UI is active.
