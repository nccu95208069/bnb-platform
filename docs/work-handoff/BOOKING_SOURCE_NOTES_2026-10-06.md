# Main Sheet notes in sold-order details — 2026-10-06

The owner clarified that the requested notes are the **main Sheet 備註 column in the sold-order detail**, and explicitly asked to publish after fixing it. This supersedes the older private-projection behavior that exposed only recognized tags from notes.

## Behavior

- Authenticated, property-scoped calendar reads attach the complete note text only after the live Sheet row matches the published booking's identity, parent order, room, dates, channel and amount. Missing or conflicting matches remain unconfirmed and never attach another booking's notes.
- The detail opens with **主表備註**, preserving multiline and long source text. Every room and night in the same order is included, with room/date provenance. Identical text appears once with its source dates.
- Confirmed empty source cells display **主表未填寫備註**. Source mismatches display a sync-confirmation message; they are not reported as empty notes.
- Anonymous monitor snapshots remain free of source notes. The existing no-price-role boundary also strips raw source notes server-side because they can contain financial text. Notes are rendered as plain React text, never HTML or translated user content.
- The source Sheet is read only for this feature. It does not change guest notes, orders, payments or inventory, and does not change the earlier availability-state behavior.

## Verification

- 41 domain tests passed across private source projection, note-tag extraction, property/role projection and Sheet monitor.
- Five new DOM regressions passed for multiline/long text and HTML escaping; coalesced nights and multiple rooms; duplicate and foreign-order exclusion; empty vs. unconfirmed source; hidden-price access.
- Eight existing contiguous-stay/payment DOM regressions passed (54 total relevant tests). TypeScript and the full production Webpack build passed. Lint passed with zero errors and six pre-existing warnings. Production acceptance is recorded below after release.

Only synthetic note content is included in fixtures and source control.
