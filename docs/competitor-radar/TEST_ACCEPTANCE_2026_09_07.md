# Competitor Radar test acceptance — 2026-09-07

## Owner test entry

- Public test site: https://daili-radar-test.vercel.app
- Direct workbench route: https://daili-radar-test.vercel.app/radar-test
- Deployed source revision: `ffd12bcf7e438d04dafdff9029480468a46187d3`
- Frontend acceptance revision: `d8819f8efc61bcfba1b6b8b7d844ae1dc650bfa3` (identical frontend tree)
- Vercel project: `daili-radar-test` / `prj_5a6ilBSvneWYIDTGoCFFZhAjWYeM`
- Existing Sweetfun OS project was not modified.
- PR: https://github.com/nccu95208069/bnb-platform/pull/16 (stacked on #15, not merged)

## Executed gates, not inferred status

1. `Radar Preview Check` run https://github.com/nccu95208069/bnb-platform/actions/runs/34130000597 completed successfully: strict unit compilation, **35 tests passed / zero failed**, frontend ESLint, Next.js production build, agent-browser smoke, Chromium desktop and WebKit mobile browser acceptance.
2. `Radar Preview Deploy` run https://github.com/nccu95208069/bnb-platform/actions/runs/34130561698 completed successfully: identical-source acceptance gate, isolated Next build, dedicated Vercel deployment, public health checks, and the same full browser acceptance against the public URL.
3. Public tests used ordinary browser contexts, without Vercel credentials or protection-bypass headers. The site does not require the owner to sign in or supply a provider key to test.
4. `/calendar`, `/api/v1/bookings`, and `/api/v1/calendar` returned 404 on the isolated test site.
5. Runtime health returned the exact deployed revision, `liveBooking: false`, and `persistence: browser-only`.

## Browser scenarios that passed

- Synthetic example renders four offers for three source rooms, with clear synthetic/non-live labels.
- A modified room name and explicitly selected mapping survive save and reload.
- Wrong dates and wrong property identity quarantine every price and quantity.
- `rooms_left=0` alone remains unknown; a unique `We have 1 left` badge gives reference quantity one.
- Webpage quantity nine remains capped/unknown, never exact stock.
- Empty availability does not become sold out.
- Fractional room capacity blocks valid-draft save.
- Malformed JSON shows an error without replacing the current result.
- Valid JSON imports correctly and preserves synthetic provenance.
- Changing adult count invalidates the current comparison rather than relabeling its data.
- WebKit mobile viewport 390×844 has no document-level horizontal overflow; added rooms survive reload.
- No JavaScript page errors were observed in the desktop and mobile scenario suites.
- Real Sweetfun official website analysis succeeded on the public test deployment.
- Real government matching returned `水芳`, `Hotel_A15010000H_035813`, confirmed candidate.
- Localhost crawler requests returned 422; cross-origin requests returned 403.

## Live official-site result observed

Six canonical drafts, all with `website_detail` provenance:

| Room title | Standard occupancy shown after correction |
|---|---:|
| 101 河景四人房 | 4 |
| 102 侘寂雙人房 | 2 |
| 201 河景雙人房 | 2 |
| 202 侘寂四人房 | 4 |
| 301 河景雙人房 | 2 |
| 302 天窗雙人房 | 2 |

These are **website-derived editable drafts**, not independently audited physical inventory. Screenshot inspection confirmed that explicit double/quad room titles take precedence over unrelated page-wide one-person text. Government room count five is displayed as a discrepancy against six drafts; it does not overwrite them.

## Evidence artifacts

Public deployment workflow artifact `radar-public-test-evidence` (artifact ID `10021998769`) contains:

- `deployment.json`
- `browser-result.json` with `passed: true`
- `live-website-evidence.json`
- `public-browser.log` ending in `BROWSER_ACCEPTANCE_PASS`
- desktop, mobile WebKit, real-website and initial-page screenshots
- agent-browser snapshot and isolated build record

The corresponding source package is `radar-isolated-source` (artifact ID `10021999579`). Workflow artifacts have a seven-day retention period; this document records the durable source revision, run IDs and executed results.

## Explicit limits

This is a testable intake/verification workbench, **not completed live OTA monitoring**. Booking is synthetic demonstration or user-provided JSON import only. No paid Booking/Agoda/Trip.com provider request was issued. No actual provider bill, physical inventory, confirmed booking, sales/pickup accuracy, or broad market coverage claim was verified.

Drafts and candidate/mapping decisions remain browser-local. There is no cross-device sync, production database write, applied Supabase migration, daily snapshot schedule, or production verification audit. WebKit mobile simulation is not a claim that every physical iPhone or Safari release was tested. Existing survey claims marked frozen remain frozen.
