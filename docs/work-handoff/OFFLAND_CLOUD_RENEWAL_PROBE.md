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

Deployment and real identity acceptance remain pending until recorded below.
