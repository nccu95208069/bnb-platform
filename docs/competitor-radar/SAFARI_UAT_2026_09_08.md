# Safari UAT work, 2026-09-08

Status: **in progress, not owner acceptance**.

Verified starting state:
- PR 16 HEAD `7f0afd30beb50b245454376bb845ee77f910bdd7`, open and stacked on PR 15.
- No Actions runs returned for that exact HEAD.
- Public alias points to `dpl_AuPu6FCZNCCa4B83SEjK1vzKyjeL`; health reports `ffd12bcf7e438d04dafdff9029480468a46187d3`.
- Deployment script already uses an exact-revision gate and current source paths. The handoff's claim that it still pins an old SHA is stale.
- Both PR 16 review findings already have code fixes and tests, but threads remain unresolved.
- PR 15 has additional unresolved findings. Partial portal searches/records must fall back instead of asserting uniqueness. Database attribution/timestamp findings remain outside this browser-only deployment and block merging those migrations; no migration has been applied by this task.

Changes under verification:
- Website draft appears before registry lookup completes; registry merges evidence into current edits.
- Browser-local save/restore includes a fixed date window, edited rooms, completed platform scans and pending job handles. Stored snapshots retain capture times.
- Short start request and polling use an isolated no-network Sandbox mailbox. Results can be recovered for 15 minutes across Function instances. No new service or database is provisioned. This does not provide permanent server storage or cross-device sync.
- Historical probe workflows are manual only.
- Mobile overview uses room cards; charts are hidden until prices exist.
- Agoda generic page price nodes are not accepted. Returned listing, room, dates, adults, children, room count and currency must match before a dated state is adopted. Unproven results stay unknown.
- Browser egress has a domain allowlist and private-address exclusions. A blocked response stops subsequent dates on that path.

Capability limits:
- Official website and registry: real public requests, independent failure states.
- Booking: property/catalog attempt only, no dated price or quantity.
- Agoda: five known Sweetfun room URLs, 102 unknown; full returned-context proof still requires live verification. No generic discovery or price claim.
- Trip: identity/date attempt only, no adopted room price or quantity.
- Public core OTA UAT requires at least one real accepted dated observation. Mocked browser tests do not satisfy that gate.

Acceptance evidence must name an exact commit. Working-tree build/test output is development evidence only.
