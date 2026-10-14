# Sweetfun OS settings and appearance — 2026-10-14

The local candidate reorganizes the left-sidebar `/settings` page. It groups display, account/security, and operations settings; moves calendar colors, login devices, and legacy integrations to dedicated routes; and keeps the advanced integration section collapsed on the hub. The workspace-specific `/w/[slug]/settings` page is unchanged.

The global display controls offer light, dark, and system themes through `next-themes`, persisted in this browser as `sweetfun-theme`. The font slider offers 85–130% in 5% steps, updates the root rem scale immediately, and persists as `sweetfun-font-scale`. Both preferences load before the page becomes interactive. Language retains its existing account/device behavior. Common fixed light colors on older OS screens receive dark-compatible overrides; detailed visual acceptance of every legacy screen remains open.

Verified locally: TypeScript, targeted ESLint, production Webpack build, light/dark settings screenshots, font-size change and reload persistence, and a narrow viewport check. This production release branch is based on live source `9f5cc13` and contains no OS beta integration commits. Record the final deployment and live readback here after release.
