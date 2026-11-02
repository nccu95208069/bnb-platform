# Sweetfun OwlJourney Gmail booking boundary (2026-10-27)

Iron Gate accepts a new OwlJourney `L:OWJ...` source order only from the bound
Gmail source principal with a distinct `gmail-owljourney-dkim-v1` assertion.
The Gmail writer asserts that only after checking the exact sender and Gmail's
aligned Owlting DKIM/DMARC result. A new order needs platform `owljourney`, no
OTA alias, a nonempty guest, an explicit TWD total, and a valid stay. Existing
room, block, imported Sheet L-column, and review-fence collision checks remain
in force. A provider-managed event mirrors the reservation without asking
OwlNest to close stock again.
Later signed OwlJourney mail contains a masked guest name. If a controlled
provider readback has supplied a matching full name, a masked follow-up keeps
the full name; a mismatched visible prefix requires review.

An already-fenced 2026-10-26 notice required a controlled repair because its
original source receipt is immutable. The source-controlled reconciliation
script now accepts an exact OwlJourney notice without inventing an OTA alias.
It checks the original request hash, current provider confirmation and two
night amounts, the provider's full guest name against the masked email name,
the matching fence, all competing occupancy and operation
state, and the property version before appending one booking, source link,
receipt, audit event, outbox event, and occupied room nights. Dry-run must
roll back; apply requires a fresh provider check and independent readback.
That repair was applied and independently verified as one confirmed booking
covering two nights. The original review receipt remains for audit.

## Production release and verification

The automatic path was released on 2026-10-27 after the repair. The exact
published Iron Gate code is `d092ab1`; Vercel deployment
`dpl_7tJWuDisHtRb2H49JEqj4txN8y7y` became the target of
`iron-gate-green.vercel.app`. The prior deployment
`dpl_8M42pgEkUGYTxkFLxukN2JUZpfDZ` remains the rollback baseline. A blank
unauthenticated `POST /v1/source-events` returned `UNAUTHORIZED`. The candidate
had no warning, error, or fatal runtime log entries in the release observation
window.

The downstream Gmail producer was promoted only after the Iron Gate alias
readback. Its seven ingress paths were paused, drained, and restored by the
pinned release controller; production boundary checks and subsequent readback
passed. The previously repaired order still has exactly one confirmed booking,
two occupied room nights, its original source review receipt, and no target
review fence or provider operation. An unrelated manual review record was
preserved. No synthetic booking or provider action was sent during release.
No new live OwlJourney email arrived in this observation window, so first-mail
delivery remains a passive operational check rather than a claimed live test.
