# Pricing-only OS release — 2026-10-07

Owner approved merge, deployment and the existing bnb-pricing client's
`pricing_decisions` permission. This does not authorize OwlNest price writes,
writer-freeze removal, live pricing acceptance, or the three-day schedule.

## Source and scope

Based on production source branch `codex/customer-onboarding` at `407a064`.
The deployed predecessor is `dpl_AQKkfJMux9RtrNxEejYgXkEEor5d` (`d291be1`;
the later base commit changes documentation only).

Includes only the 21 pricing-related frontend files from OS-11 `66cd7d8`
and INT-04 `378cc09`: scoped decision validation, independent merge timestamps,
atomic retained decision receipts, exact POST/GET readback, protected-date null
and fractional OTA bases, bounded 16 MiB snapshot readers, decision display,
and regression fixtures. HTTP request limit remains 2 MiB.

PR #29 also includes OS-10 native holds. Those customer-workspace, order,
payment and workbook changes are deliberately excluded from this release.
No cron definitions, hold settings, source mappings or pricing policies change.

## Verification before release

- 41 pricing/change/availability/quote/refresh/reference tests passed, no skips.
- One pricing-decision DOM test passed; null bases and skipped publication are
  explicit. React review found no new effects, requests or server-only imports
  in client code.
- TypeScript and optimized webpack build passed. Full lint: no errors, six
  existing unrelated warnings.
- Initial Redis tests lacked the local binary/network permission; retried with
  disposable loopback Redis. Parallel suites then conflicted on shared fixture
  keys; serial execution passed. Neither failed attempt counts as acceptance.
- Production verification is limited to authentication, scope and rejected
  malformed payloads; no real/synthetic pricing events will be stored during
  this deployment acceptance. Full live producer acceptance remains separate.

Permanent producer run history stays outside this repository. OS retains its
existing 30-day terminal receipt window. A saved receipt is historical evidence,
not a guarantee that no newer price observation exists.

Deployment and final scope verification are pending at this commit; report the
actual deployment ID and result after promotion, not merely build success.
