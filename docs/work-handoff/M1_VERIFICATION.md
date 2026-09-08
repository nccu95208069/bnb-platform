# M1 verification and code review

2026-09-08. Review performed by the implementing agent as a separate pass; no independent reviewer is claimed.

## Scope reviewed

New finance-summary projection, registry store, GET/POST route, summary UI and navigation, locale additions. Baseline calendar/payment/finance code was inspected for integration but is not represented as a comprehensive review of every earlier unmerged commit.

## Findings and fixes

- Cross-tenant and hidden-price access: server-side finance role and property authorization precede source reads. Same-origin checked for POST. Responses private/no-store. Anonymous and cross-origin route tests pass.
- Financial meaning: legacy H cannot fabricate receipts or verified totals. Agoda legacy claim interpretation limited to Sweetfun; Offland does not inherit that policy. UI labels incomplete evidence explicitly.
- Duplicate amounts: receipts deduplicated by event ID; inconsistent duplicates fail. Allocation/direct-link duplication, repeated allocations, invalid cents and over-allocation fail closed. Voids, other properties and service income do not affect lodging receipts.
- Identity: current-batch alias collisions and collisions with historical registry both block registration. Old ID/aliases retained; disappearance does not delete financial records or create a refund.
- Concurrency: source fingerprint + expected registry version + Redis CAS + readback; stale saves rejected. This protects OS registry, not arbitrary external Sheet edits. No Sheet write calls exist in new route.
- UI: request-key scoping and abort prevent late responses showing another property's result. At most 50 cards initially; load more on request. No financial mutation on GET. Errors do not falsely show saved.
- Operational safety: no migration of existing receipts, no TTL on registry, no new credentials, no source exports or customer data in source control. Provider backup/restore validation remains M2 gate.

No critical issue found within M1 scope after these fixes. Known boundaries: verified totals/events not editable yet; summary is not a replacement for the older estimate charts; identity registry stores observations, not an automatic merge engine. Corrupt state fails closed. No main-sheet writeback is enabled.

## Automated validation

- Full frontend test suite: 119 passed (includes 12 new summary/model/store/API tests).
- Finance/receipt focused regression: 36 passed before additional store/API tests.
- TypeScript noEmit passed.
- ESLint: zero errors; two pre-existing unused-symbol warnings in calendar views.
- Production Next.js build passed with network access for existing Google Fonts.
- Post-review summary tests and TypeScript rerun passed.

Live deployment/browser results and PR disposition appended after verification.
