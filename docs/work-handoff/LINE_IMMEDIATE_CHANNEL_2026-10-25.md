# Immediate execution after a LINE room-action confirmation

## Accepted behavior

The owner's October 25 clarification supersedes the old interaction that replied
with `processing` immediately and required another query-button click. A valid
confirmation must start its room operation promptly; GCO should reply with the
verified outcome using the same event token whenever it finishes within the
bounded reply window. Queue acceptance alone is not room-action success.

## Implementation

After `requestLineChannelAction` validates the operator, signed preview, booking
version and exact cells and commits the operation, the HTTP adapter invokes an
injected scheduler with only its property ID and operation key. No dispatch occurs
after an authorization, validation or transaction failure.

The Vercel adapter immediately starts the existing channel worker and registers
its promise with `waitUntil`. Both the API and cron functions have a 300-second
maximum duration. The worker can now target an exact operation; it cannot consume
an unrelated queue entry, bypass a held claim or reapply a terminal operation.
The same property-claim transaction guards concurrent confirmation/cron calls.
Existing provider verification, unknown-outcome fences and failure reporting
remain authoritative. Cron is retained for jobs whose startup fails before claim.

The runtime uses the existing configured property, channel grant and authentication
broker. There is no new externally callable trigger, shared cron credential, or
client-supplied channel principal. Database CA/transport validation moved to one
shared source module to avoid a circular API import. `@vercel/functions` is pinned
to 3.6.1, which provides `waitUntil` and passes the installation security audit with
zero known vulnerabilities.

GCO's paired change establishes a 50-second budget at webhook receipt, waits on the
same operation and replies once after verified completion or review. Only an
exhausted budget or unresolved transport result produces the recovery query card.
No success push or reply token storage is added.

## Validation and publication status

The old worker failed both targeted regressions: it selected an unrelated oldest
job and failed to reject an unknown target. The revised worker passes these tests.
Synthetic HTTP-to-worker tests cover immediate startup, exact readback, same-key
replay, denied confirmation, startup failure preserving the committed job, and
wrong-property rejection. Explicit overlap tests ensure cron and immediate
dispatch cannot cause a second provider write. Type checking and targeted runtime
tests pass. Final `npm run check` and `npm test` pass: 304 tests passed,
9 database-environment tests skipped, zero failures. No database integration
acceptance is claimed by those skipped tests.

This branch starts at `d48b3fa`, preserving the released signed OwlNest notification
and closed-room registration changes. No production deployment, real provider
write or test notification has occurred for this fix. It requires the paired GCO
release and the normal coordinated deployment checks. A currently held review
claim is a separate real incident; this implementation deliberately preserves it.
Do not remove that claim or blindly repeat the original operation to enable release.

Reference: [Vercel waitUntil lifecycle](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil).

## Candidate verification after release approval

The owner approved coordinated staging/cutover/restoration/rollback. A staged
production-environment candidate was built from exact `fa338c7` using
`--skip-domain`. It is READY, has no production alias, and all 62 runtime,
configuration and certificate source hashes match the commit. Unauthenticated
availability and channel-action requests both return application `401
UNAUTHORIZED`. Deployment protection was preserved.

The production alias still points to the prior deployment. Coordinated GCO
preflight found unresolved real operation/notification records, so promotion
remains blocked. No property claim, operation, booking, provider stock or notice
was modified as a deployment test. A real confirmation-to-provider-to-reply
acceptance test has not been completed. The same release approval is retained;
uncertain business-write recovery needs its own reviewed scope.
