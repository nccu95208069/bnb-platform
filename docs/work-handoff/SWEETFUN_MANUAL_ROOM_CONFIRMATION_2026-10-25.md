# Sweetfun manual room confirmation — 2026-10-25

The owner confirmed that two native OS/LINE bookings had already been handled manually in OwlNest and explicitly requested an **已手動關房** confirmation action that clears their pending indicators without changing OwlNest stock.

## Behavior and boundaries

Eligible unsynchronized native OS/LINE orders now offer **已手動關房** in OS details. The dialog lists the exact rooms and stay dates and requires an affirmative checkbox. The authenticated OS gateway submits the existing booking/inventory versions and a durable request key, then independently reads the booking back. Successful confirmation displays **已手動關房（人工確認）** and the Taipei confirmation time.

This is an owner attestation, represented by `manually_confirmed`, never `verified`. No OwlNest observation, stock write, channel operation, grant change, schema migration or notification is initiated. The existing OS owner/admin/god, property and price permissions remain required. Iron Gate checks native source, source conflicts, versions, explicit confirmation, room conflicts, absence of provider operations and exact pending scope. Requests are idempotent; uncertain browser responses retain the request key for receipt recovery. Audit records retain the actor, reason, exact handled room-nights and resulting closed-night baseline.

The baseline is explicitly manual. Metadata and price changes preserve it. OS room/date changes save locally, show the exact pending opens/closes, and keep removed nights blocked until another explicit **已手動處理房況** confirmation. Cancellation likewise records pending manual opening without scheduling OwlNest writes. The usual provider-sync endpoint rejects manually handled bookings. Existing LINE mutation/channel-action paths reject these bookings and direct staff to OS rather than interpreting owner attestation as provider proof. Initial acknowledgement is intentionally unavailable for imported/source orders, prior provider operations, source conflicts or an existing uncompleted OS room move.

## Verification

Authenticated gateway → Iron Gate HTTP handler → repository → independent detail/calendar readback checks cover both native OS and LINE bookings. They verify audit provenance, repeat-request recovery, cleared pending indicators, preserved occupancy and no provider reads/writes. Future move/cancel/reconfirm scenarios assert the worker remains idle and removed room-nights stay blocked until owner confirmation. Invalid acknowledgement, stale versions, unauthorized roles, conflicts and already-dispatched operations are rejected. DOM checks cover the exact room/date scope, required checkbox, dedicated local-only endpoint and subsequent open/close scope.

Local verification passed: Iron Gate typecheck and 284 tests (nine environment-dependent skips), 47 gateway/calendar/integration tests, 13 UI/request-identity tests, frontend typecheck, lint (zero errors; seven existing warnings), and production build. All four CI jobs passed for the implementation.

Release details, live booking acknowledgements and operational verification evidence are retained privately. This public report describes the implementation and isolated checks only.
