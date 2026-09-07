# Competitor Radar — URL Intake Slice v0.1

> Status: first implementation slice on `feat/competitor-radar-intake`  
> Owner decision: 2026-09-07  
> Product surface: `/competitor-radar`

## Goal

A hospitality operator pastes one public accommodation URL. The system creates an editable competitor draft consisting of:

1. a canonical property identity;
2. an evidence-based cross-platform identity plan;
3. canonical room drafts derived primarily from the official website;
4. Booking.com, Agoda, and Trip.com adapter states;
5. a fixed 14-day observation window for future price and availability collection.

This slice deliberately separates **property/room identity** from **OTA collection**. It does not fabricate OTA prices or availability before a provider adapter has returned verified data.

## Owner-approved decisions

### Dual-track property identity

Property identity uses two independent high-value tracks:

- **Registration track:** Taiwan B&B/hotel registration number or government HotelID when available.
- **Address track:** structured, fuzzy Taiwan address comparison when the registration number is absent.

Neither track is treated as universally present. A registration-number match is strong evidence, but its absence is not a failure. A high-quality address match can confirm identity when district, road, lane/alley, and house number agree.

The address parser currently normalizes:

- `台` and `臺`;
- full-width and half-width characters;
- whitespace and punctuation;
- `24-1`, `24之1`, and `24號之1`;
- city/county, district/township, village/里, neighborhood/鄰, road/street, section, lane, alley, house number, sub-number, and floor.

Village/里 and neighborhood/鄰 are optional. If one source omits them, the match is not penalized. Conflicting district or house number is a hard negative signal.

Supporting identity evidence includes phone, website domain, geolocation, and name similarity. The UI must explain the evidence instead of showing only an opaque confidence score.

### Room source precedence

- The official website creates the initial canonical room draft.
- OTA pages define the actual products, rate plans, prices, and availability sold on that OTA.
- An algorithm proposes mappings.
- A user-confirmed mapping becomes final truth and must persist across later collection runs.

Rate plans are not physical rooms. Whole-property bundles are not additional independent inventory. A room mapper must distinguish one-to-one rooms, pooled room types, and bundles.

### Data semantics

OTA inventory is presented as **reference availability / reference quantity**, not confirmed sales.

Allowed availability states include:

- `available_exact`
- `available_capped`
- `available_quantity_unknown`
- `sold_out`
- `room_not_listed`
- `fetch_failed`
- `identity_not_confirmed`
- `date_mismatch`
- `not_collected`

Daily changes may later create `observed_availability_change` and `possible_pickup`. They must never be stored as `confirmed_booking`.

## Implemented in v0.1

### Functional URL analysis

`POST /api/v1/competitor-radar/analyze`

- accepts a public HTTP/HTTPS URL;
- blocks localhost, private/reserved IPs, credentials, and non-standard ports;
- revalidates every redirect;
- limits each page to 2 MB;
- fetches only HTML;
- follows at most 12 likely room-detail links on the same hostname;
- limits room-page concurrency;
- extracts lodging JSON-LD, title/meta information, address, phone, registration information, room links, room detail headings, guest capacity, room number, bundle status, view, bathtub, balcony, skylight, and no-window features;
- returns explicit warnings for partial room-page failures.

The SSRF protection is a first boundary, not the final production boundary. A production crawler should additionally use a dedicated egress service with DNS pinning, rate limits, audit, and domain-level budgets.

### Sweetfun golden case

`https://www.sweetfuntw.com/` is the public-safe golden case. If a live response omits some known room pages, the analyzer supplements only missing rooms with a clearly marked golden fixture. It never substitutes prices or availability.

### Editable page

`/competitor-radar`

- URL input and analysis states;
- property identity summary;
- visible registration/address dual tracks;
- explainable identity evidence;
- editable canonical room name and capacity;
- add/remove room controls;
- source provenance per room;
- Booking, Agoda, and Trip.com tabs;
- fixed future 14-day date frame;
- explicit `not_collected` cells instead of fake data;
- browser-local draft save, clearly labeled as non-production persistence.

## Not implemented yet

1. Taiwan Tourism Administration registry adapter and government HotelID match.
2. Search-provider adapter for discovering official and OTA candidates from any seed URL.
3. Booking.com collection adapter.
4. Agoda collection adapter.
5. Trip.com collection adapter.
6. Cross-source property candidate scoring in the API flow.
7. OTA room extraction and editable room mapping UI.
8. Persistent database schema, tenant/property authorization, audit, and user-verified mappings.
9. Scheduled fixed-stay-date collection and change events.
10. Provider billing telemetry.

No UI element should imply that these items are already operational.

## Planned adapter contract

Every OTA adapter should normalize to a common offer shape while retaining the raw payload and provider identifiers:

```text
property_source_id
room_source_id
room_name_raw
check_in / check_out
occupancy
availability_state
quantity / quantity_cap
currency / total_price
refundable / breakfast_included
provider_run_id
requested_url / final_url
requested_date / returned_date
raw_payload_hash
parser_version
```

A successful HTTP response is not sufficient. Returned property identity and stay dates must match the request before data can enter the comparison table.

## Acceptance criteria for the next slice

Using Sweetfun as the golden case:

1. Discover the government registry record.
2. Discover Booking, Agoda, and Trip.com candidates.
3. Show registration-number and structured-address evidence for each candidate.
4. Reject a candidate with a conflicting house number even if its name is similar.
5. Extract OTA room products without turning rate plans into rooms.
6. Propose mappings to six canonical Sweetfun rooms.
7. Persist user corrections.
8. Collect one future stay date per platform with explicit price basis and availability state.
9. Preserve `unknown` and `fetch_failed`; never coerce them to sold out or zero inventory.
10. Record actual provider usage and billed units.

## Operational boundary

The existing public repository and Vercel deployment must remain free of guest PII, credentials, OTA cookies, account screenshots, and production tokens. Scraping/provider credentials belong in approved secret storage. Competitive collection must not reuse the browser profile, cookie jar, or egress identity used for owner OTA administration.
