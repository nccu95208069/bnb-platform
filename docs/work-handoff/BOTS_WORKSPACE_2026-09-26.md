# Sweetfun Bot workspace

## Accepted scope

Owner selected `https://sweetfun-os.vercel.app/bots`, current Sweetfun orders read-only, sandbox transactions fully editable. Built from production commit `a0528b0` to preserve guest notification and OFFLAND reference features. Uses existing owner login; staff roles cannot access this first version.

## Roles

| Role | Live Sweetfun | Sandbox | Excluded |
| --- | --- | --- | --- |
| Concierge | Room-night overview; delegate fixed analysis | Operations documents/tasks | Booking/payment mutation on behalf of others |
| Finance | Anonymous room-night listing; recorded room charges | Finance documents, payment/reversal | Booking changes, inferred settlement or profit |
| Reservations | Anonymous room-night listing; recorded occupancy | Booking create/update/cancel, reservation documents | Payments, live inventory writes |
| Analyst | Fixed booking report | Analysis documents supplied by owner, fixed reports | Guest identity, arbitrary prose reports, source mutation |
| Market | Basic calculation/organization only | Evidence, comparable price reports, market documents | Live guest/financial data, price publication |

Role ceilings and per-bot narrowing are enforced by tools. Owner can edit bot policy and template fields. Archive preserves records; payments use reversal.

## Data and persistence

- Reads only existing Sweetfun monitor state. No seed fallback, raw Sheet fetch, private guest lookup, writer or cron changes.
- Requires healthy synchronization (under five minutes old). Conflict room-nights remain occupied, disputed prices unknown.
- `done` means guest marked paid; platform settlement, actual receipts and net profit remain unknown.
- Live rows and prior live chat results never return to Gemini. The provider receives the owner's instruction, role, tool schemas and date; server computes and renders the result.
- All sandbox changes, policy, templates, conversation results and audit are stored in Redis namespace `sweetfun-os:bots:v1`, separate from orders/auth/ledger.
- Request working copy, 240-second fenced lock, compare-and-swap, read-back verification. Aborted requests cannot commit a partial sandbox mutation. Chat request IDs and tool effect IDs prevent duplicates.
- 4 MiB state limit; 80 messages per conversation, newest 500 audit events retained. No real customer messaging or payment processing.
- Production Secret `GEMINI_API_KEY` is required for chat; deterministic tools work without a model key. No credentials or data exports are deployed in source.

## Validation

Run `node --experimental-strip-types --loader ./tests/bots/loader.mjs --test tests/bots/*.test.mjs` from frontend. Includes role ACL, all live writes denied, report calculations, privacy projections, no model round-trip for live results, sandbox persistence/idempotency, anonymous/expired/forged session denial, staff denial, CSRF, stale-source denial, concurrent lock and stale commit denial.

Run `npm run lint` and `npm run build`. Deployment and browser acceptance results will be appended after completion.

## Rollback

Previous production deployment: `dpl_5LfZVmDUCY1PRxyFHtqGFd6sFmZM` (`sweetfun-bcet1nfwl-sweetfuns-projects.vercel.app`). Promote previous deployment to roll back UI/API without touching live orders or sandbox records.
