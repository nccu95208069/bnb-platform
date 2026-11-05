# Desk Center calendar booking notes

Owner request: show current Iron Gate notes in calendar details, test and release.

The calendar snapshot intentionally omits notes. The detail now reads the exact booking through a private, no-store GET endpoint using the existing property-scoped booking credential, signing only booking:read and notes. Response identity and version are validated; only bookingId, property, version and notes are returned. No backend, grant, environment or booking mutation is introduced.

Current membership, password-reset restrictions, property scope and price visibility remain server-enforced. Missing notes is an error, explicit null is empty. The UI renders plain multiline text, distinguishes loading/error/empty states, offers retry and discards late responses after order changes. Legacy Sheet/conflict/snapshot behavior remains unchanged.

Validation: both-property route authorization matrix and response identity/error checks pass; ten UI tests cover multiline/XSS, empty/error/retry, stale responses, hidden-price denial and legacy behavior. TypeScript and lint pass (seven existing warnings). Claude independent review round one: PASS, no findings. Production candidate and read-only acceptance are recorded separately in the private project release report. Preserve any newer release before promotion.
