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

The government dataset `HotelID` is a stable dataset identifier. It is stored separately from `HotelLicenseNumber`, the local lodging registration / license number.

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

Normalisation handles:

- `台` / `臺`;
- full-width and half-width characters;
- `24-1`, `24之1`, and `24號之1`;
- optional village / 里 / 鄰;
- section, lane, alley, and floor components.

Missing village / 里 / 鄰 is not a conflict. Conflicting district or house number is a hard negative signal.

## Government registry adapter

### Primary route: portal search plus per-property JSON

The production adapter first performs a bounded official-portal lookup:

1. build at most three exact search terms from phone, Chinese property name, and structured road/house number;
2. fetch the official search result HTML;
3. extract at most five official `HotelID` values;
4. fetch the official per-property JSON for those IDs;
5. score each record against the website seed.

This route is preferred because one property JSON is about 1 KB rather than downloading the complete national archive for every cold runtime.

### Fallback route: complete daily Hotel JSON archive

If portal search or per-property JSON is unavailable, the adapter may read the official daily Hotel JSON ZIP and filter the complete registry locally. The ZIP remains a fallback because cloud testing found that the official host sometimes returns a short WAF rejection page with HTTP 200 and `text/html` instead of a ZIP.

The adapter therefore does not trust HTTP 200 alone. It validates:

- response byte ceiling;
- expected content type;
- ZIP magic bytes before decompression;
- JSON prefix and parseability for individual records;
- known WAF rejection text;
- exact returned `HotelID` for the requested JSON record.

### Normalized fields

The adapter reads these fields when available:

- `HotelID`;
- `HotelLicenseNumber`;
- `HotelName` and `AlternateNames`;
- `PositionLat` / `PositionLon`;
- `PostalAddress`;
- `Telephones`;
- `WebsiteURL`;
- `ReservationURLs`;
- `SameAsURLs` / `SocialMediaURLs`;
- `TotalRooms`;
- `LowestPrice` / `CeilingPrice`;
- `UpdateTime`.

Operational controls:

- fixed official host and paths, never user-controlled;
- eight-second deadline per official resource;
- at most three searches and five property records;
- 512 KB ceiling for search HTML and individual JSON;
- 32 MB compressed ZIP ceiling;
- 96 MB decompressed JSON ceiling;
- encrypted and unsupported ZIP entries rejected;
- one-day in-memory search, record, and archive caches per runtime instance;
- concurrent full-archive loads share one in-flight request;
- registry failure degrades to the website draft rather than failing the whole analysis.

## Live Sweetfun validation

A GitHub Actions live smoke test ran the production adapter against the official portal and returned:

```text
HotelID: Hotel_A15010000H_035813
HotelLicenseNumber: 新北市民宿402號
HotelName: 水芳
Address: 新北市瑞芳區中山路24之1號
Phone: 0973400562
Identity status: confirmed
Identity score: 0.8461538462
Conflicts: none
```

The input address was `新北市瑞芳區東和里中山路24-1號`, confirming that omitted `東和里` and `24-1` versus `24之1` are treated as the same structured address.

The government record reports `TotalRooms = 5`, while the official website / operator-confirmed canonical inventory contains six rooms. Therefore government room count is evidence only and never overwrites the canonical room model. This is a concrete example of why one source cannot be treated as unquestioned truth for every field.

## Candidate semantics

Each government candidate returns:

- identity status: `confirmed`, `review`, or `rejected`;
- explainable evidence;
- explicit conflicts;
- matched alternate name;
- government `HotelID`;
- local lodging license number;
- government address, phone, coordinates, room count, and price range when present;
- Booking / Agoda / Trip.com URLs found in `ReservationURLs` or `SameAsURLs`.

A government-provided OTA URL is still a **candidate**. It remains `identity_review` until the OTA page itself is fetched and its property identity is independently checked.

Rules for using a candidate:

- exactly one `confirmed` candidate: canonical identity may be enriched and candidate OTA URLs may enter identity review;
- more than one `confirmed` candidate: no automatic selection, because one address may contain multiple lodging licenses;
- `review`: show evidence but do not mutate canonical identity or add OTA sources;
- `rejected`: show negative evidence only; never enrich property data or enter collection.

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

Verification-event triggers derive the actual competitor property from the referenced subject, reject nonexistent or cross-tenant subjects, and force the actor to `auth.uid()` so clients cannot spoof audit attribution.

## Authorization

All identity-graph tables have RLS enabled and explicit grants.

- Active workspace members with price visibility may read.
- Only Owner and Admin may insert, update, or delete identity records.
- Verification events are append-only for authenticated clients.
- `viewer_no_price` receives no competitor-radar rows.
- `anon` receives no table access.

The migrations were executed inside a real Supabase Postgres 17 transaction and rolled back after verification. A follow-up query confirmed that the production project still contains zero `competitor_%` tables. The schema is source-controlled but is **not applied to production** by this PR.

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
