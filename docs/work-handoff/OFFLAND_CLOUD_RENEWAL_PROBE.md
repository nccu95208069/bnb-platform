# OFFLAND cloud renewal acceptance probe

Owner approved unattended calendar/Gmail renewal and deployment on 2026-11-02,
then explicitly approved the dedicated cloud runner identity and database role.
This branch extends the fully recovered, verified production source retained in
PR #127. No device cache or failed-read UI behavior is removed.

`GET /api/internal/offland-credential-health` verifies Google's RS256 identity
token, fixed issuer/audience, maximum age and exact maintenance service-account
email. It calls the existing OFFLAND calendar read adapter with fixed property
scope. No guest records, credential token, session, write operation or issuer
is exposed. The response contains credential ID, inventory/authority versions,
room-night totals and a digest for comparing old/new deployment reads.
Anonymous, wrong identity/audience and forged signature checks fail closed.

Deployment and real identity acceptance were completed on 2026-11-02; see below.


## Verified production acceptance

Source commit `dfa0c67088df40e3b84c8198afc7d782690ebbda` was exported from this
branch (PR #128, based on the actual recovered source in PR #127). Bootstrap
candidate `dpl_DTkS6Wx91RNadhVLWHNoAjbtxYzL` passed the real dedicated Google
cloud identity check before promotion. The cloud renewal job then redeployed
that exact source as `dpl_Rsnf6hgkJ6wUHirhG44z9Zny2fGz`, verified matching
calendar snapshots, promoted it, and confirmed live use of credential
`4f34e312-83ed-4542-94f3-805ccb196f15`, expiring
`2026-11-30T02:47:37.871Z`. Successful authenticated consumer acceptance was
recorded at `2026-11-02T02:57:37Z` after bounded edge-propagation verification.
Anonymous access remains denied; no guest records or secrets are returned.

Both calendar and Gmail completed their first automatic renewal in cloud
execution `offland-credential-renewal-vmzww` at 03:14 UTC. Daily 09:00 Asia/Taipei
Cloud Scheduler is enabled; manual dispatch through that scheduler completed as
`offland-credential-renewal-mzz4n` at 03:16 UTC and verified both consumers without
issuing duplicate credentials. Next natural run is 2026-11-03 09:00 Taipei; it
has not yet been observed. Failure notification was actually received through
the existing administrator email channel. The original ChatGPT reminder remains
unchanged; the owner approved this independent cloud execution replacement.

The coordinator and current operational source are in
[gmail-check-order PR #124](https://github.com/nccu95208069/gmail-check-order/pull/124),
with detailed accepted evidence in its `ops/offland_renewal/README.md`.
Runtime identities cannot issue credentials; the dedicated restricted maintenance
role does. The Vercel deployment token requires administrator replacement before
November 2027. The payment-only review and historical quarantines remain intact.

This PR is open/unmerged; production is deployed and verified independently.
Tests: calendar identity negative/positive groups, TypeScript, lint and full
Webpack build passed before publishing. Device cache and failed-read status
behavior from the recovered source were preserved.
