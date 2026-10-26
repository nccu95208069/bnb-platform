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

An already-fenced 2026-10-26 notice requires a controlled repair because its
original source receipt is immutable. The source-controlled reconciliation
script now accepts an exact OwlJourney notice without inventing an OTA alias.
It checks the original request hash, current provider confirmation and two
night amounts, the provider's full guest name against the masked email name,
the matching fence, all competing occupancy and operation
state, and the property version before appending one booking, source link,
receipt, audit event, outbox event, and occupied room nights. Dry-run must
roll back; apply requires a fresh provider check and independent readback.

Code and repair preparation are separate from production deployment. Record
the final release and repair status only after each is verified.
