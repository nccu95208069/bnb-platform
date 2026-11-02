# Legacy calendar stock clarity — 2026-10-12

The Sheet remains the authority for whether a booking exists. A zero or locked OwlNest observation does not create a booking. For an unsold room-night, however, a stock observation made on the current Taipei day now changes the availability display to `unknown` (待確認) until the owner checks the discrepancy. It no longer contributes to the `available` (未售) count. Existing bookings and conflicts retain precedence. Older stock observations remain visible with their original timestamp and do not change the Sheet-unsold display.

This display rule supersedes the 2026-10-07 handoff's statement that even current-day zero/locked stock must remain Sheet-unsold. It is a fail-closed response to the 2026-10-12 owner report of a room shown as 未售 while OwlNest showed zero inventory. It does not establish sellable inventory or activate website sales. The underlying channel closure could be an OTA sale, a manual lock, or another cause, and requires readback from the actual source.

Focused Sweetfun/OFFLAND tests verify current zero and lock become unknown, older zero stays a separate observation, a newer open overlay wins, and an actual Sheet booking remains sold.
