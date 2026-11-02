# Sweetfun OS Iron Gate calendar patch

This branch starts from `008ca1d` (four source file hashes and the commit time
match the current Sweetfun OS Production deployment). It adds only the guarded Sweetfun calendar
reader and its route integration. The production switch
`IRON_GATE_SWEETFUN_CALENDAR_ENABLED` remains absent, so normal Sheet reads are
unchanged until the separately verified cutover.

The reader requires an authenticated OS member, the Sweetfun property grant,
an epoch-1 read credential, a short-lived OS proof, and a version-consistent
booking/availability read. It fails closed on missing configuration, stale
inventory, or read-only Iron Gate state. Prices and payments remain unknown.

Verification: focused route and calendar tests, TypeScript, targeted lint, and
Next.js webpack production build passed locally. The first build attempt could
not reach Google Fonts in the sandbox; the same build then passed with network
access. No production calendar flag was enabled during this work.
