# OFFLAND reference-only first release

Owner approved displaying reference probability and rule-based suggestions in the
existing unsold calendar. This supersedes the prior no-prediction UI boundary,
but does not authorize automatic pricing. Baseline is verified production commit
38b04bb, deployment dpl_DFguY2WDb9gU4Rj9F4i3AhUVtQfF.

## Separation

- Dedicated private Redis key `sweetfun-os:research:v1:offland`, with CAS and one
  previous version. No writes to the authoritative pricing key, OwlNest or Sheets.
- Auth and property/price permissions run before research reads. Optional research
  failure does not break current price availability. Sweetfun takes its old path.
- Four/six-person plans share a villa-level pooled probability. The UI says
  試算中; historical cancellations/closures remain incompletely reconstructed.
- Rule suggestions are independent of probability and appear only on the matching
  direct plan, matching current price and available date. They remain a separate
  `offland_reference` field, never an executable `pricing.suggested_price` or Daili
  official quote. Owner floors, Friday weekday handling and holiday exclusions
  originate in the isolated research export.
- No predictions beyond the 90-day research horizon or on protected holidays;
  missing research stays blank. References older than three calendar days expire.
- No dependency on browser storage and no guest data in reference snapshots.

## Refresh

Run `frontend/scripts/publish-offland-reference.mjs <daily-ledger> <research-report>`
with existing production Redis environment, using Node type stripping and the
existing route loader. Both files must be OFFLAND, collected on the current Taipei
date, publication-disabled, and have matching input hashes. Trial report comes
from `offland-pricing/scripts/offland_research.py` using the same daily input files.
Only the research cache is published; no rate publication is implemented here.

## Verification

166 frontend tests pass; TypeScript and production build pass. Lint has zero errors
and two pre-existing unused-variable warnings. Targeted cases cover isolation,
permissions, future/stale/missing values, occupied nights, changed current prices,
OTA exclusion and four-person matching. The first cache is readback-verified:
version 8048a7656370cfbd9fb8, 26 villa dates, research date 2026-09-22.
Browser and deployment verification are still pending at this commit.

Rollback: return domain to the prior verified production deployment. Research data
can remain because prior code does not read this key. Do not roll back live prices.
