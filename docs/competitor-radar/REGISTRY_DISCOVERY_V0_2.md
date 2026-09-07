# Competitor Radar — Registry Discovery and Identity Graph v0.2

> Status: implementation slice on `feat/competitor-radar-registry-discovery`  
> Product surface: `/competitor-radar`  
> Source dataset: Taiwan Tourism Administration lodging open data (`https://data.gov.tw/dataset/7780`)

## Objective

Turn one pasted accommodation URL into an evidence-backed, editable cross-platform property identity without pretending that name similarity, a successful HTTP response, or an OTA search result proves identity.

This slice adds two foundations:

1. official Taiwan lodging-registry candidate discovery;
2. a tenant-scoped property / room identity graph that can later persist user verification.

It still does **not** collect live Booking, Agoda, or Trip.com prices or quantities.

## Identity decision

Property identity remains dual-track:

- **Registration track:** local lodging registration information when a source actually publishes a registration-shaped value.
- **Address track:** structured Taiwan address matching, used even when registration information is absent.

The government dataset `HotelID` is a stable dataset identifier. It is **not** silently relabeled as a local B&B/hotel registration number.

Supporting evidence:

- phone;
- official website domain;
- geolocation distance;
- alternate property names.

Name similarity alone never auto-confirms a property.

## Taiwan address rules

A strong address requires at least:

- district / township;
- road / street;
- house number.

Normalisation already handles:

- `台` / `臺`;
- full-width and half-width characters;
- `24-1`, `24之1`, and `24號之1`;
- optional village / 里 / 鄰;
- section, lane, alley, and floor components.

Missing village / 里 / 鄰 is not a conflict. Conflicting district or house number is a hard negative signal.

## Government dataset adapter

The adapter uses the official daily Hotel JSON archive and reads these fields when available:

- `HotelID`;
- `HotelName` and `AlternateNames`;
- `PositionLat` / `PositionLon`;
- `PostalAddress`;
- `Telephones`;
- `WebsiteURL`;
- `ReservationURLs`;
- `SameAsURLs`;
- `TotalRooms`;
- `LowestPrice` / `CeilingPrice`;
- `UpdateTime`.

Operational controls:

- fixed official archive URL, never user-controlled;
- eight-second fetch deadline;
- 32 MB compressed-size ceiling;
- 96 MB decompressed JSON ceiling;
- encrypted and unsupported ZIP entries rejected;
- one-day in-memory cache per runtime instance;
- concurrent loads share one in-flight request;
- registry failure degrades to the website draft rather than failing the whole analysis.

## Candidate semantics

Each government candidate returns:

- identity status: `confirmed`, `review`, or `rejected`;
- explainable evidence;
- explicit conflicts;
- matched alternate name;
- government HotelID;
- government address, phone, coordinates, room count, and price range when present;
- Booking / Agoda / Trip.com URLs found in `ReservationURLs` or `SameAsURLs`.

A government-provided OTA URL is still a **candidate**. It remains `identity_review` until the OTA page itself is fetched and its property identity is independently checked.

Rejected candidates may be shown to explain the negative evidence, but they must not enrich the canonical property, supply OTA links, or enter room/price collection.

## Persistence model

The migrations add:

- `competitor_property`;
- `competitor_property_source`;
- `competitor_canonical_room`;
- `competitor_source_room`;
- `competitor_room_mapping`;
- `competitor_room_mapping_target`;
- `competitor_verification_event`.

The model supports:

- one property across many web/OTA sources;
- canonical rooms primarily created from the official website;
- raw OTA rooms kept separate from rate plans;
- one-to-one, one-to-many-offers, pooled-room-type, bundle, and unmapped relationships;
- a bundle mapping to multiple canonical rooms;
- append-only user-verification evidence;
- optimistic `version` fields and update timestamps.

Composite foreign keys prevent a source room belonging to competitor A from being mapped to a canonical room belonging to competitor B, even when both belong to the same tenant.

## Authorization

All identity-graph tables have RLS enabled and explicit grants.

- Active workspace members with price visibility may read.
- Only Owner and Admin may insert, update, or delete identity records.
- Verification events are append-only for authenticated clients.
- `viewer_no_price` receives no competitor-radar rows.
- `anon` receives no table access.

The schema migration is source-controlled but is not applied to the production Supabase project by this PR.

## Still intentionally missing

1. User selection among government and OTA candidates in the UI.
2. Production-persisted save API for the editable draft.
3. Live Booking adapter.
4. Live Agoda adapter.
5. Live Trip.com adapter.
6. OTA room extraction and user-confirmed mapping UI.
7. Fixed-stay-date 14-day snapshots.
8. Reference availability changes and possible-pickup events.
9. Provider usage and billing telemetry.

## Next implementation order

1. Persist one edited property and canonical-room draft transactionally.
2. Display all registry candidates and let Owner/Admin confirm or reject one.
3. Store the resulting verification event.
4. Add one OTA candidate-fetch adapter with property/date validation.
5. Extract OTA room products without treating cancellation or meal rate plans as rooms.
6. Persist and reuse user-confirmed room mappings.
7. Only then begin 14-day price and reference-quantity snapshots.

## Non-negotiable data semantics

- Unknown inventory remains unknown.
- `fetch_failed` is never `sold_out`.
- A disappeared room is not automatically quantity zero.
- OTA quantity is reference availability, not confirmed inventory.
- A quantity decrease may later be labeled `possible_pickup`; it is never `confirmed_booking`.
- The requested and returned property and stay dates must match before an OTA observation is accepted.
