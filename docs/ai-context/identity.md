# Identity & Reservation Resolution

## Problem

A LINE user is not automatically the same thing as a reservation. The system must resolve that link safely before answering booking-specific questions.

## Evidence sources

Potential evidence includes:

- existing canonical `IdentityLink`
- OTA / booking order number
- guest name
- check-in / check-out date
- room number or room type
- phone/email when available
- recent conversation context
- owner-provided tag or note
- one or more booking screenshots

No single weak signal should be treated as truth by itself.

## Google Sheet contract

- Google Sheet is the Reservation SSOT.
- Sweetfun writes LINE User ID to column R.
- When a booking spans multiple stay rows, all related stay rows may receive the same LINE User ID.
- SaaS maintains one canonical `IdentityLink` internally.

## Matching principles

Strong signals:

- exact OTA / booking number
- exact phone/email where available
- owner-confirmed manual binding

Supporting signals:

- normalized guest name
- English/Chinese name variants
- reversed first/last name
- stay date
- room
- platform

Names alone are not enough for risky automatic matching.

## Screenshot / Vision flow

Guests may send multiple screenshots.

UI should:

- show recent relevant images as thumbnails
- allow selecting/deselecting each image
- optionally preselect likely booking screenshots
- display `已選 N / M`
- run Vision/OCR on the selected images
- extract structured candidate fields
- compare the evidence against Google Sheet reservations

Vision/OCR output is evidence only. The reservation source of truth remains Google Sheet.

## Candidate flow

- high-confidence candidate: rank first and show the evidence
- medium confidence: show ranked alternatives
- no good candidate: return to chat and ask only for the missing evidence that is actually needed

V1 default: owner confirmation before binding.

Primary action:

`確認綁定`

Permanent note:

`僅更新內部資料，不會自動傳訊給旅客`

Do not clutter V1 with large redundant actions like `改由人工確認` or `詢問客人資訊`.

## Room resolution is separate from identity

Identity can be confirmed while target room remains ambiguous.

Example:

- booking contains rooms 102 and 202
- guest asks: `床多大？`
- identity is confirmed
- target room is not

Correct behavior: ask which room, not silently choose one.

## Scope safety

Do not permanently attach a room to a person. Room/date/exception facts should normally be reservation-scoped.

A returning guest may have a different room on the next stay.

## Confidence and safety

Unknown or conflicting evidence must never cause the system to invent a reservation match.

When uncertain:

- show candidate(s)
- ask for missing evidence
- or go to Human Review

Do not guess.