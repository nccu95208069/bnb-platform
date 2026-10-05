# Reception form and whole-villa analytics — 2026-10-05

## Owner decision

The owner confirmed that this property hosts one group at a time and approved a
whole-villa analysis framework. Onboarding must ask whether the property accepts
whole-villa bookings, individual room bookings, or both. This supersedes the
earlier room-only analytics assumption.

## Implemented

- `/join` and `/start` share three choices: 包棟, 散客（分房出租）, 兩者都有.
  `/start` no longer preselects room operation.
- The existing onboarding `Property.kind` persists the choice and now supplies
  the default analysis mode. Legacy workspaces confirm the form on first use.
- An encrypted property-scoped analysis setting supports corrections. It does
  not silently modify the operational calendar inventory model. Onboarding
  supplies the operational model for new customers.
- Owner/admin permissions, same-origin writes, rate limiting and CAS protection
  apply. The saved mode and active job are checked after writing.
- Jobs/reports capture reception form. Changing form creates a new job from
  retained source data and clears unit/money answers for explicit confirmation.
  Old reports remain immutable. Expired source data requires a new import;
  old totals are never merely relabeled.
- Source-format confirmation stays within five questions. Reception is a
  property-onboarding question before source import.

## Calculation rules

### Whole villa

- One booking occupies one unit per night, excluding checkout. An internal
  room-count column never multiplies sold villa nights.
- Separate options cover one booking per row, one night per row, and explicitly
  confirmed room-split rows. The example card shows a whole-villa group stay.
- Split room rows require shared order ID, identical stay/channel/booking-date
  metadata, and distinct room identifiers. The money choice explicitly confirms
  that row prices add to the villa price. Missing/contradictory groups are
  excluded. No merge uses guest names or guessed identity.
- Whole-villa overlaps, including individual-room orders on the same dates, are
  excluded. Conflict/uncertain dates are retained for review, not called vacant.
- Arrival groups and full-stay length use reconstructable stays only. Nightly
  rows do not claim group counts or reconstructed full-stay length.
- Average price retains the disclosed positive-price denominator, excluding
  zero/unknown-price nights. Charges are not receipts, net profit or a
  standardized tax-adjusted ADR.

### Both forms

- Recognized `接客形式` (or supported equivalent) must explicitly label each
  row as villa or rooms. Unknown values are excluded; a missing column blocks
  analysis with instructions to add it and refresh.
- The dashboard switches segments. Aggregates, trends, channels, average price
  and chat carry the selected form. No combined average is displayed.
- One confirmed row convention applies to the source. Unrelated conventions
  must be normalized. Room-split villa rows are currently supported in
  villa-only analysis, not the mixed-source path.
- Villa and rooms share one building. Independent buildings should be separate
  properties.

## Presentation and Xiaofang

Villa defaults to this month: performance, next 30 days, and suggested actions.
Trend/channel/weekday/booking-behavior detail is collapsed. Metrics include sold
villa nights, known charges, average villa nightly price and arrival groups when
reconstructable.

Forward dates show villa booked, rooms booked, review needed or unknown. Unknown
never means sellable vacancy. Single-night gaps between occupied periods are
candidates to verify; official occupancy, saleable gaps and minimum-stay
eligibility still need complete coverage and closures/personal-use/maintenance
records. No rate publishing or operational inventory mutation is performed.

Xiaofang uses the same deterministic segmented aggregates. It explains group
counts/villa nights, compares both forms separately, and suggests dates to check.
It does not infer net profit or verified occupancy. AI option suggestions only
receive derived statistics.

## Verification and delivery boundaries

- TypeScript passed. Changed-feature ESLint: zero errors, two pre-existing
  internal-navigation warnings in workspace onboarding.
- No tests were added or run for this change.
- Production build/deployment is recorded in the task delivery.
- Browser access to this site was previously rejected by browser security policy.
  No alternative browser or direct DOM/network route bypassed the denial. Live
  UI, real-sheet regrouping and real chat acceptance are not claimed.
- No production credentials, private source rows or guest information committed.
  Source sheets remain read-only.
