# Offland parity — code review and acceptance

## Review
Reviewed the complete diff against 956d2b3. No critical issue remaining.
- Separate property keys, refresh locks, backups and compare-and-swap; initial cache publication verifies readback.
- Fixed hotel and room mappings verified against OwlNest GET; no caller-supplied external URL or hotel ID.
- Availability and refresh authenticate, enforce price visibility and property scope before source access.
- Snapshot validator rejects wrong-property snapshots and unsupported room/channel IDs.
- Four/six person prices share one inventory unit; no invented predictions, rack prices or channel mappings.
- Pending asynchronous reads ignored on property change; remount clears local detail/refresh state; property-specific room/channel filtering prevents stale selection.
- Finance ledger/audit remain scoped; navigation and browser history preserve selected property.
- No external price/inventory writes; no production expense/receipt test writes.

## Verification
- 161 frontend tests passed (including new Offland parser, initial publish, availability, finance and API permission cases).
- TypeScript and production Next.js build passed.
- Full lint: no errors; two existing unused-variable warnings in calendar-views/week-carousel (new unused test import removed).
- Live Offland source: hotel 7180 / room 34789 / plans 42385,42387,42391,42392,42393,42394.
- Initialized isolated OS pricing snapshot: 2026-09-22 through 2026-12-21; version 71976c2cf7728c919405; one villa, six rate channels.
- Read-only live finance check: 2 entries, 244 projected orders, 7 audit records, all scoped to Offland.
- Mobile 390x844: week dates mm/dd, one villa row, sold days excluded; day four-person plan shows actual source amount.

## Deployment status
Candidate deployment was blocked by automatic approval review pending explicit approval to send this code to existing Vercel sweetfun-os project. No domain promotion performed. User approval question pending. Local browser verification uses a separate local signing key; no production auth setting changed. Production price snapshot is derived cached data only.

## Final local visual check
- Mobile month screenshot inspected after loading: October Offland, Booking prices, four available villa nights, compact controls and no browser errors.
- Mobile finance screenshot inspected: Offland selected; bookkeeping, order receipts and audit navigation present. No production financial mutation performed.
- Desktop month and mobile month/week/day checked locally; physical iPhone Safari and production candidate acceptance remain deployment-stage checks.
