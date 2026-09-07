# Unsold calendar / bnb-pricing bridge — 2026-09-07

Owner requested real unsold calendar with existing price permissions. Hidden-price accounts see no switch and receive HTTP 403 from the data endpoint. Authentication and property scope are enforced before reading price storage. No OwlNest price writes or experiment execution are added.

## Verified source

GitHub `nccu95208069/bnb-pricing` master inspected on September 7. Local read-only checkout matches the GitHub blobs for rack_rates, rack_rates_overrides, build_panel and t39_baseline. Spec v0.5.0 blob `36e3e8f3becb0b05bf375a7d815c08db4f3154c8` supersedes the September 5 brief. Staged overrides are not active input. Rack prices are evaluated using the original `expected_base_price` and `daytype_for_date`, never a duplicated formula. They are distinct from the frozen experiment baseline and from observed channel prices.

Current prices come from a fresh OwlNest GET through the pricing project's existing reader, not a plan CSV, journal after-value, or model inference. Five channels are retained individually. No guest data or credentials are exported. Unsupported Trip.com and Offland pricing are not fabricated.

## Operational behavior and limits

- Existing month/week/day component, overflow expansion, date navigation and history are reused. Demo cycles, review missions and stay quotes stay disabled.
- `/api/v1/availability?property=sweetfun&start=YYYY-MM-DD&end=YYYY-MM-DD&channel=direct&rooms=101,102` returns structured room-nights; end is exclusive, maximum 93 days. The same authenticated API can be consumed by an authorized Agent client. It is a read-only projection, not a completed booking Tool or writable inventory contract.
- Sheet monitor supplies occupancy and conflicts. Checkout is not occupied. Unhealthy/confirming sources return unknown instead of available.
- `available` means Sheet-unsold, labelled 未售; `sellable_units` stays null. It is not authority to book. Last observed external locks/zero stock cannot silently become sellable as the snapshot ages. Other unbooked rooms still require external revalidation before booking.
- Actual capacity and minimum stay are unintegrated; zero sentinel fields are not displayed as real conditions. There is no invented recommendation or guest-pay price. Details show rack, observed channel price, limitations and timestamps. Older-than-four-days pricing is labelled stale.
- Browser polls the published snapshot every minute and on focus. **The price source itself is not yet automatically polled.** Each pricing round needs the publisher below; browser refresh does not perform a new OwlNest read. Source failures never substitute demo prices.

## Publish after each verified pricing round

1. In the operator's environment, run `python3 scripts/export-pricing-calendar.py --pricing-repo /path/to/bnb-pricing --output /private/path/prices.json` from bnb-platform. Existing OwlNest credentials remain in bnb-pricing; this performs only GET. Default coverage ends June 30, 2027; update `--end` explicitly for later supported windows.
2. With the existing calendar Redis environment already authorized and loaded, run from frontend: `node --experimental-strip-types --loader ./tests/helpers/next-route-loader.mjs scripts/publish-pricing-snapshot.mjs /private/path/prices.json`.
3. Publisher validates schema, dates, rooms, channels, positive prices and duplicates; requires export under 15 minutes old; rejects older/concurrent publication, preserves one previous snapshot and verifies the exact persisted value.
4. Read the calendar API using an authorized price-visible account to verify the new price version. No front-end deployment is necessary for subsequent data updates.

Storage: private compressed Redis key `sweetfun-os:pricing:v1:sweetfun`, previous key suffix `:previous`. No production pricing artifacts are committed. Rollback can restore the previous value through an authorized operator action or hide the unsold UI; never change the experiment to fix a calendar issue.

Initial export has 1,782 room/date cells, each with five channel prices, through 2027-06-30. Publication verified version `b1dae415a22200df26b7`. Price provenance is observed rather than guaranteed current.

Tests cover checkout, source outage, conflicts, channel-specific prices, missing prices, stock locks, stale data, malformed snapshots and real-route auth/property/hidden-price/reset-required denials. Frontend build passes; existing lint warnings unrelated to this change remain.

## Sales probability colors (owner request)

Month/week/day use red for p_sell ≥0.60, green for 0.40≤p_sell<0.60, blue below 0.40. Missing predictions stay gray, never inferred from rates. Percentage and model as-of date appear in the detail; percentages also appear in cells. Existing conflicts/unknown/blocked states retain their operational warnings. Hidden-price accounts still cannot read this endpoint.

Export with optional `--probability-plan /path/to/t39_plan_YYYYMMDD.csv`. The current integration reads the explicit September 7 plan p_sell keyed by exact room/date, validates finite 0..1 and duplicate keys, records the file hash and as-of date, and never executes the plan. No matching plan row means no prediction, including excluded dates; this is not evidence of zero probability. The values are the engine's model scores, not guaranteed future sales or proof a proposed price was applied.
