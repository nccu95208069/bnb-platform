# Sweetfun manual guest notification after Iron Gate calendar cutover

The Sweetfun calendar now projects Iron Gate booking IDs as `IG-<UUID>`, while
`/api/v1/guest-notification` accepted only the former Sheet-derived `SF-` IDs
and re-read the Sheet before every write. Every Iron Gate card therefore failed
the manual "已通知" action. Production logs on 2026-10-24 showed POST 400 while
GET still returned the existing `SF-` states.

The OS now accepts both identity formats. For an Iron Gate card, the client
sends its exact `IG-` booking ID alongside the status key. Before writing, the
server re-reads that booking with the signed OS member proof and checks the
property, workspace, active status, stay rooms, and derived status key. A
cancelled or changed booking fails closed. The former Sheet reader remains the
authority when the Sweetfun Iron Gate switch is disabled.

Unchanged imported Sheet orders reuse their `SF-` status key when the Iron Gate
projection provides a validated source order reference. This preserves prior
marks for members allowed to change them. Newly ingested orders use their
`IG-` key. The status store remains versioned, idempotent, and audited; this
change does not send a message to a guest.

The Iron Gate service currently includes an imported source order reference
only in the price-authorized projection of a version-one order. A
`viewer_no_price` account may therefore see an imported order under its `IG-`
identity rather than its former `SF-` mark. It cannot change the mark. A later
service-side opaque notification identity projection is needed for parity in
that read-only role and for imported orders whose source version has changed.

Verification: focused API, calendar, and UI tests; TypeScript; ESLint (zero
errors, five unrelated existing warnings); and a production webpack build
passed locally. This patch has not been released. Production behavior must be
checked separately after deployment with an authenticated authorized member
and a real readback.
