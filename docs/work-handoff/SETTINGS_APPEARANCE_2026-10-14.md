# Sweetfun OS settings and appearance — 2026-10-14

The local candidate reorganizes the left-sidebar `/settings` page. It groups display, account/security, and operations settings; moves calendar colors, login devices, and legacy integrations to dedicated routes; and keeps the advanced integration section collapsed on the hub. The workspace-specific `/w/[slug]/settings` page is unchanged.

The global display controls offer light, dark, and system themes through `next-themes`, persisted in this browser as `sweetfun-theme`. The font slider offers 85–130% in 5% steps, updates the root rem scale immediately, and persists as `sweetfun-font-scale`. Both preferences load before the page becomes interactive. Language retains its existing account/device behavior. Common fixed light colors on older OS screens receive dark-compatible overrides; detailed visual acceptance of every legacy screen remains open.

Verified locally: TypeScript, targeted ESLint, production Webpack build, light/dark settings screenshots, font-size change and reload persistence, and a narrow viewport check. This production release branch is based on live source `9f5cc13` and contains no OS beta integration commits. Record the final deployment and live readback here after release.

## Calendar week spacing and unsold layout follow-up

The left-sidebar `/settings` appearance card now has a browser-persisted month-calendar week-spacing slider. Automatic preserves the previous density. Steps 1–5 increase the visible booking rows and unsold-room cards; the final step fits all rows for each week, so the overflow control disappears. This changes only the month views; existing per-week manual expansion still works. The control states that a taller setting makes the month longer, and it can be reset to automatic.

The unsold availability page keeps period navigation, room/channel filters, the availability toggle, and key counts in a compact top card. Search, price-refresh and preview actions, timestamps, demo-cycle controls, secondary counts, and the probability legend are under “More options and details.” Error and sandbox notices remain visible outside the foldout.

Local verification used synthetic bookings and room nights only: the slider retained its value after reload; mobile and desktop month views showed additional items as the value rose; the all-items setting removed the overflow control; and the unsold foldout opened without browser errors. TypeScript, targeted lint, month-layout tests, and the production Webpack build passed. The local Turbopack build cannot complete in the restricted host because it cannot fetch Google Fonts or spawn its CSS worker; Webpack build verified the production bundle. This follow-up is local until its own release is recorded.
