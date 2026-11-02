# Personal calendar palettes — 2026-09-06

Owner requested five personal calendar color presets in Settings, including a
saturated premium option. Default is now 霧感莫蘭迪 (mist), with 暖杏大地 (earth),
海岸微光 (coast), 暮色石板 (slate), and 寶石濃彩 (jewel).

The sidebar/mobile menu now links to /settings. Each preset has a synthetic
platform preview; selecting previews the option and Apply saves it. Platform
tokens apply consistently to month/week/day, legend and order-dialog platform
badges. Payment status, property identity and conflict warning colors are unchanged.
The legacy Reply Copilot integration settings remain available in non-Sheet builds.

## Persistence and identity boundary

- GET /api/calendar-appearance returns scope, palette and all five preset definitions.
- PUT accepts only {palette: one of the five ids}, checks same origin and the
  current signed owner session against authoritative credentials, then writes and
  reads back. Responses are private/no-store; storage errors are explicit failures.
- Current production has exactly one real account identity, calendar-owner.
  Preferences use a separate Redis key sweetfun-os:appearance:v1:calendar-owner.
  They survive password changes and do not modify authentication records.
- The store accepts a server-verified account id for future separate member login;
  the API never accepts an account id from the client. Demo members are NOT real
  authenticated accounts. Multi-member account integration remains future work.
- Guests save to a distinct browser-only key sweetfun-calendar-device-palette-v1;
  guest preferences never overwrite the private account. No owner preference is
  cached in guest localStorage. Navigation/focus re-reads the account preference.
- CALENDAR_APPEARANCE_NAMESPACE is an optional isolated-test override only.
  No production env or database migration is required; existing Redis is reused.

## Validation

- Frontend lint/build passed.
- All 35 platform foreground/background combinations have contrast >= 4.5:1.
- Store tests cover account separation, new-store reads, invalid values, unavailable
  storage and unconfirmed writes. API tests cover unsigned/tampered sessions,
  cross-origin requests, injected account ids, invalid ids, independent-session
  reads and anonymous isolation. Existing owner-session/password tests passed.
- Mobile browser: menu -> Settings -> select -> Apply -> calendar works; browser
  reload preserves the choice. Jewel Booking color is rgb(18,90,128) in month,
  week and day. Desktop and mobile preset previews visually reviewed.

Run API tests with:
node --experimental-strip-types --loader ./frontend/tests/helpers/next-route-loader.mjs --test frontend/tests/calendar-appearance-route.test.mjs

## Production verification

Deployed commit 69b4353 to https://sweetfun-os.vercel.app via deployment
sweetfun-n99r166j4-sweetfuns-projects.vercel.app. In the existing authenticated
owner browser, Jewel saved successfully and survived a full reload; then Mist
was restored and confirmed saved. No console errors observed in local or
production verification. No credential or booking records changed.

## Distinct styles revision

Owner found the original five palettes too similar. Retain IDs/account preferences
but revise earth to 復古暖陽 (mustard/terracotta/coffee with mixed light and dark
bars), coast to 白瓷彩線 (white background, colored text, outline and inset side
stripe), and slate to 黑白編輯 (neutral grayscale). Mist and Jewel remain.
Preview and calendar now share platformAppearance tokens, including outlines
that remain visible on the compact month's borderless bars. All 35 text pairs
pass 4.5:1 contrast. No changes to persistence or account authentication.
