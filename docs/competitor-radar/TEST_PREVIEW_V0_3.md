# Daili Competitor Radar — isolated test preview v0.3

Updated: 2026-09-07. Branch: `feat/competitor-radar-testable-preview`.

## Purpose

Deliver a testable owner workflow without requiring a paid provider key. This is an isolated test application, not a production inventory or sales-monitoring system.

## Corrected implementation record

At the start of this slice, GitHub returned 404 for the previously claimed `bnb-competitor-radar` repository and PR #16. PR #13 had already merged. PR #15 was open and contained government discovery and proposed identity-graph migrations, not a persisted save UI or a live Booking adapter. Previous claims of a standalone repository, completed Booking live adapter, persisted transactional UI saves, PostgreSQL 16 double-run verification and a browser screenshot were not supported by the actual repository state. They must not be used as acceptance evidence.

This slice adds actual source-controlled files and reproducible acceptance commands. A successful build is not browser acceptance. An uploaded artifact is not a public deployment. Each is recorded separately by the workflows.

## Test workflow

1. Open `/radar-test` (enabled only with `RADAR_PREVIEW_MODE=true`).
2. Analyze a public official website, or select `載入完整範例` for synthetic data.
3. Review property details, edit/add/remove canonical rooms, and inspect government candidates. Recheck government data after editing identity fields.
4. Confirm or reject a government candidate locally; government room counts never overwrite canonical rooms.
5. Import one Booking-format JSON document locally, or test the five synthetic scenarios.
6. Inspect independent identity/date/occupancy gates. Unverified observations expose no accepted price or quantity.
7. Select a room mapping explicitly. Rate plans stay separate offers sharing one source room key.
8. Save, reload, export and reimport browser-local drafts.

## What is real and what is not

| Capability | Contract |
|---|---|
| Public official website analysis | Real outbound request through existing SSRF-hardened, bounded crawler |
| Government matching | Independent real official-portal lookup, with explicit unavailable state |
| Synthetic example | Entirely fictional property, room products and prices, visibly labeled |
| Booking JSON import | Browser-only parser for the documented shape; not a live provider adapter or independently verified source |
| Persistence | Browser localStorage plus downloadable JSON; no production database writes, no cross-device sync |
| Candidate confirmation and room mappings | Local user decisions only; no production audit event claimed |
| Live Booking/Agoda/Trip.com collection | Not enabled; no paid provider request, token or billing claim |
| Daily snapshots, pickup or market insights | Not implemented by this slice |

## Import contract

One root object (or a one-element array) with `name` / `hotel_name` / `title` and `availability` / `offers`. Each offer requires `room_name` / `room_type` / `name`. Examples contain no real provider credentials or guest information.

Observed metadata must be returned explicitly: `check_in`, `check_out` or positive `price.nights`, `adults`, `children`, `rooms`, and currency. The parser never promotes `input.check_in` or URL query parameters to returned-date proof. Missing metadata remains unknown and prevents acceptance. All per-offer nights values must also agree.

Quantity order: unique scarcity badge first, then positive `rooms_left`; zero or absent remains unknown. Conflicting quantities remain unknown. Webpage values at or above nine are capped/unknown rather than exact physical inventory. Contradictory bookable-price and sold-out evidence is quarantined. An empty offer array without explicit sold-out proof remains unknown.

Import size is capped at 1 MB, 500 offers and 100 canonical rooms. Draft loading validates rendered nested values, including candidate evidence and optional identity fields. Malformed storage is not silently erased. Failed persistence prompts export; failed analysis retains the old draft.

## Isolation and operational limits

`prepare-radar-preview.mjs` packages only `/`, `/radar-test`, and `/api/radar-preview`. Calendar, bookings, auth, payment, sheet and cron routes are absent. It rejects environment files. No production Supabase, Sheets, Redis, owner-code or provider secret is copied.

`deploy-radar-preview.mjs` is restricted to the dedicated `daili-radar-test` project and explicitly refuses the existing Sweetfun OS production project ID. Public authentication protection is disabled only for this public-safe test project. No merge, production migration or production Vercel project update is part of this slice.

Website requests have a 48-second total crawler budget. Government lookup is a separate call, so its failure cannot discard website results. The test endpoint has a same-origin check, bounded request bodies, a capped in-memory IP budget and one active request per IP. The memory limiter is a prototype abuse baseline, not durable global rate limiting. This preview is not a hardened public SaaS release.

The uploaded survey's frozen claims remain frozen. No accurate-sales, actual-inventory, safe-scraping-frequency, provider-cost or broad-market-coverage claims are reinstated here. No existing owner scanner/account/browser session is used.

## Reproducible verification

`Radar Preview Check` compiles and runs `frontend/tests/competitor-radar-preview.test.ts`, runs frontend ESLint and Next production build, then runs agent-browser and Playwright acceptance on Chromium and WebKit mobile viewport. Artifacts contain exact source, test logs, screenshots and observed live website results.

`frontend/tests/radar-preview-browser.cjs` can also run against the public test URL via `RADAR_TEST_URL`; its output must contain `BROWSER_ACCEPTANCE_PASS` before public acceptance is claimed. Mobile WebKit verification is not a claim of testing every physical iPhone or Safari version.

Deployment evidence independently records the public URL, build SHA, runtime capability flags and the absence of unrelated private routes. See the corresponding successful workflow run and artifact for actual execution results.
