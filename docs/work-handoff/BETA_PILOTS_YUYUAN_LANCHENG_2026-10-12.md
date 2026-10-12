# BETA-02/03 pilot intake: 愉園 and 蘭城輕旅 — 2026-10-12

These are two separately authorized friend pilots. This note records public
Booking.com **display options to verify**, not imported OS rooms, live
availability, prices, owner-approved content, or permission to sell. Direct
automated page opening reached Booking.com's verification screen; the option
lists below come from recent indexed copies of the exact property pages and
can be stale or date-dependent. Do not create a booking from them.

| Pilot | Exact single-property source | Indexed display options requiring owner confirmation |
| --- | --- | --- |
| 愉園 / Happy House B&B, 瑞芳 | <https://www.booking.com/hotel/tw/yu-yuan-happy-house-b-amp-b.zh-tw.html> | 標準雙人房、高級雙人房、豪華四人房、四人房－附浴缸、園景雙人房 (5 labels) |
| 蘭城輕旅 / LanCheng Le Petit Voy, 冬山 | <https://www.booking.com/hotel/tw/lancheng-le-petit-voy-lan-cheng-qing-lu.zh-tw.html> | 高級雙人房、豪華雙人房、山景特大雙人床房、小型雙人房、豪華四人房、經濟雙人房、Villa、豪華 Villa、園景 Villa (9 labels) |

Indexed source evidence: [愉園 listing](https://www.booking.com/hotel/tw/yu-yuan-happy-house-b-amp-b.zh-tw.html?came_from_hotel_review=1&keep_landing=1), [蘭城 listing](https://www.booking.com/hotel/tw/lancheng-le-petit-voy-lan-cheng-qing-lu.zh-tw.html). The Booking availability widgets and "rooms left" messages for an arbitrary date are not a physical inventory census. Pricing and booking policies in those widgets are also date/offer dependent and must not seed OS-approved terms.

## Owner readback required before calendar or website binding

For **each pilot independently**, the owner must verify the current displayed
room types, stable names for every physical room/unit, how many physical units
each type contains, occupancy/capacity, and whether any sale of one option
blocks another. In particular, 蘭城's three Villa offers may be packages over
the same physical rooms as its six individual-room offers. Ask the owner for
their precise constituent rooms and mutual-exclusion rule; never allocate nine
physical room IDs just because Booking lists nine offers. 愉園 must likewise
confirm whether each of the five labels is a distinct physical room or a type
with multiple units. Keep the published label separate from the canonical OS
physical-room ID.

For each property, identify the **authoritative source and coverage period**
before marking nights available: selected Google Sheet, Excel/CSV, ICS/ZIP,
Google Calendar, and/or another channel, plus the source timezone, room labels,
booked stays, owner blocks, cancellations and unresolved conflicts. The owner
reviews the preview, maps source rows/events to the verified physical units,
confirms every relevant existing booking and block, then checks saved OS
calendar readback. Reimport the same sample and a revised sample to verify
deduplication and preservation of manual corrections. Sheet/Google/ICS are in
the deployed onboarding; Excel/CSV import is still draft PR #36. Google OAuth
testing-audience and real mobile behavior remain separate acceptance gates.

愉園 has OwlNest according to the user's pilot information. Its **own** OwlNest property and
room identifiers must be matched to its OS units through the secure owner
setup and verified by readback. Existing Sweetfun/OFFLAND OwlNest credentials,
IDs and overlays are not valid for this tenant. Ask whether OwlNest has its own
bookings/blocks and how those affect authoritative occupancy. 蘭城 has no
confirmed OwlNest connection; do not assume one.

Create each tenant/workspace and property from that owner's verified account;
only then allocate canonical OS UUIDs and the new Studio UUID site ID. Do not
derive tenant, property, room, site or order IDs from a similar display name.
In particular, the similar **Happy House B&B** display name does not establish
identity with the existing Happy House synthetic/native trial binding. Never
copy a prior site ID, binding token, room mapping, order, source connection or
client credential without separate owner and property verification. Keep website
connection approval distinct from sales enablement; a new approved binding
remains sales-disabled until the two-owner inventory and notification acceptance
is complete.

## Safe next acceptance sequence

1. Obtain each owner's review of physical rooms, offer overlap, current
   policies/content rights, and a sample of the actual calendar source. Use a
   secure setup screen for credentials; do not put passwords or OwlNest secrets
   in a chat, this note or a commit.
2. In separate workspaces, preview and confirm source-to-room mappings and
   coverage, then read back orders, blocks, conflicts and incomplete periods.
   Do not infer a free night from missing source data.
3. With synthetic dates only, check cross-tenant denial, a last-room race, an
   already-sold OTA night, repeat import, revised source and interrupted retry.
4. Display each new stable Studio site UUID, submit the scoped OS connection,
   obtain the correct owner's approval and verify the physical-room mapping.
   Preserve the sales-off default. Real reservations, payment confirmation,
   guest/owner emails and OTA/OwlNest writes require their separate pilot gates.

Current boundary: the new Studio site admission, Excel/CSV upload and tenant
event readback remain in [draft PR #36](https://github.com/nccu95208069/bnb-platform/pull/36), not in production. External tenant LINE commands, multi-customer OwlNest writes, and OTA mail authorization/senders are not completed by this OS branch. Two real owner accounts, source samples and mobile/email readback are still required for BETA-02/03 acceptance.
