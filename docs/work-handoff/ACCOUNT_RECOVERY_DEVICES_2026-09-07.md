# Account recovery, devices and Today — 2026-09-07

## Explicit owner decisions

- Record browser/device IDs for logins and keep normal login credentials 30 days.
- Recovery must not depend on email or SMS.
- All members use ONE shared fixed temporary password. It remains unchanged between
  admin-assisted resets; do not rotate it per reset or silently replace this policy.
- The administrator must first enable recovery for a selected account. Temporary
  login must force a personal password change before calendar access.
- Add an explicit Today button to the mobile calendar header and locate today's row.

## Delivered behavior

Normal owner/member cookies and signed session expiry are 30 days from login.
Existing older cookies keep their original expiry; one fresh login starts the new
period and records the browser. sf_device_id is a random 128-bit HttpOnly browser
cookie retained 365 days, independent of authorization. It is not a hardware ID or
an authentication factor. Login history stores device ID, account ID, bounded UA,
last login and that session's original expiry in private Redis hashes; repeated
browser logins replace the record. Logout/password change may end a session before
its recorded expiry, so this is history rather than an active-session inventory.
Devices are visible to that account and the owner, not other members. Persistence
is read back before returning a successful login response. No IP/location captured.

/api/workspace-recovery is owner-only. It creates the fixed temporary password
once with SET NX and retains it encrypted in the existing private Redis. Only the
owner can reveal/copy it in /access. POST with member ID + expected version revokes
the old credential/sessions, sets a new credential for that shared password and
marks mustResetPassword. Suspended accounts cannot be reset through this action.
No mail/SMS calls occur; the administrator conveys the password manually. Existing
new-member email invitations remain available, but recovery uses the manual flow.

A temporary login receives a 30-minute restricted session. principalFor refuses
normal private authorization; the live calendar API returns 403 and the shared
layout redirects to /reset-password. PATCH revalidates the current session against
the latest member credential, requires a different 12–128 character personal
password, atomically clears the restriction and issues a new 30-day session. The
old temporary session/password then fails until the owner enables a new reset.
Normal account password changes still require the current password. The initial
owner credential is not changed; this owner-assisted flow targets member accounts,
not self-recovery of the sole initial owner.

Forgot password links to plain instructions for contacting the administrator.
Account settings list the current account's recorded browsers; owner member rows
also offer device history. The shared temporary password never enters logs, git,
localStorage or public API responses. No real account was reset during development.

Today is visible as text in the mobile header. Existing desktop Today is retained.
MonthScroller accepts a date + request revision, so even repeated Today presses in
the same month locate the current row instead of silently doing nothing. History
continues through the existing calendar navigation mechanism.

## Verification

Twelve targeted tests pass, covering 30-day expiry, device reuse, hidden recovery
secret access, expected versions, forced-reset calendar denial, rejecting reuse of
temporary password as personal password, successful completion, revoked sessions,
repeated recovery using the same fixed password, device scope and existing account
flows. Lint/build pass. Mobile 390x844 synthetic browser QA confirms Today returns
from July to September 7 and positions that row; attempting calendar while reset
is required redirects to /reset-password, and completing it returns to calendar.
Owner /access contains the fixed-password reveal and per-member recovery controls.
No real passwords/member data or production cookie was used in browser QA.
