# Calendar browser acceptance check

Start the isolated preview using `docs/work-handoff/AGENT_PAYMENT_PLAYBOOK.md`.
Open `/calendar?mode=unsold&view=month&date=2026-09-05` in an agent-browser session,
then evaluate `calendar-navigation.js` using `agent-browser eval`. This is the
2026-09-05 synthetic fixture acceptance scenario; update the fixture dates when
running on a later day. It makes no payment or price writes.

Assertions cover inline overflow expansion, Back/Forward restoration, combined
date/view navigation as one entry, room detail overlays, next week, and sold/unsold.
The production API remains disabled; mobile preview needs an authenticated gateway
and an explicit `PAYMENT_SANDBOX_PREVIEW_ORIGIN` matching its HTTPS origin.

`calendar-mobile.js` additionally checks an authenticated external mobile viewport,
nightly quote, saving one synthetic pricing Mission, opening the Mission center,
and restoring the saved proposal/detail/calendar with Back. Run only against the
isolated synthetic preview. It intentionally creates one local demo Mission.
Never place preview access credentials or live origins in these scripts.
