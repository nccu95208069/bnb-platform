# Calendar palette revision 3 — 2026-09-06

Owner rejected the four alternative palettes and explicitly requested redesign.
Keep mist / 霧感莫蘭迪 byte-for-byte unchanged. Existing stable account preference
IDs continue to resolve, with redesigned alternatives:

- earth / 奶油花園: light cream, peach and spring green.
- coast / 海島晴空: medium ocean blue, mint and coral; filled cards replace outlines.
- slate / 午夜絲絨: deep tinted surfaces with light text, replacing grayscale.
- jewel / 皇家琉璃: saturated cobalt, emerald and ruby, with white text.

Shared platformAppearance/paletteCss still drives month/week/day views and the
settings previews. No account data or stored preference IDs were rewritten. The
previous jewel selection now displays the redesigned saturated palette.

Settings adds a synthetic seven-day calendar example with guest placeholders and
continuous stays, plus a sticky apply panel showing draft vs saved selection. It
does not write until Apply is pressed. No real guest data is used in previews.

Validation: existing palette contrast and preference persistence tests pass (all
35 platform/text pairs >=4.5 contrast); frontend lint and production build pass.
Isolated agent-browser QA at 390x844 and 1280x900 verified layout, updated preview,
Apply + reload retention, no horizontal overflow and no browser runtime errors.
This QA used a fresh device-only session; no user account preference was changed.
