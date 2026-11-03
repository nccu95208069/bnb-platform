# Calendar notification database bridge — 2026-10-30

2026-11-03 follow-up: the owner-authorized production migration and hosted
notification/access checks are complete. The application candidate remains
unpromoted pending authenticated browser acceptance. See the
[current release checkpoint](CALENDAR_REALTIME_2026-11-03.md).

The owner requested an immediate calendar refresh after LINE or OTA creates,
amends or cancels an order. The database bridge sends a private invalidation
after a committed Iron Gate outbox event. The browser still reads authoritative,
permission-filtered calendar data through Sweetfun OS. An invalidation does not
claim external room synchronization, a successful source import, or payment.

## Implementation

`iron-gate/sql/022_calendar_realtime_notifications.sql` adds a private
`calendar_realtime` schema and an outbox INSERT trigger. Each active property has
a separately provisioned 256-bit random topic capability. These capabilities
are secrets held by the OS server and the private mapping table; they must never
appear in browser responses, logs, source control or deployment descriptions.
Provisioning and rotation use parameters, not interpolated SQL.

The private Broadcast event is `calendar.changed`. Its complete payload is
`{property_id: string, cursor: string}`. The cursor is a positive decimal string
to preserve PostgreSQL bigint precision. No booking identity, guest, contact,
stay, price, payment or source message is sent. Listening to outbox inserts also
covers name-only amendments that do not advance the inventory version.

The anonymous Realtime role receives only broadcast rows whose topic equals
the requested channel and matches an active capability. It cannot read the
mapping, read Iron Gate tables, execute the trigger function, or publish. The
capability helper uses a fixed search path, returns only a boolean, and resides
outside the existing Iron Gate schema. No Iron Gate schema usage is granted.
The migration rejects existing public/anonymous/authenticated Realtime policies
until they are reviewed, since a permissive policy could bypass isolation.
Future Realtime policy changes require the same review.

Supabase stores the Broadcast insert in the same transaction as the outbox.
It therefore becomes visible only after commit and disappears on rollback.
Notification delivery errors produce a static warning and do not fail a valid
booking commit; the calendar's periodic reconciliation remains the fallback.
Missing or inactive mappings produce no notification and do not change writes.

## Validation and release boundary

An isolated PostgreSQL 15 test database passed all seven integration scenarios
(eight reported tests including the parent). These exercise actual signed LINE
create, name-only amendment, date amendment and cancellation; actual OTA
create/amend/cancel; precommit invisibility and rollback; notification outages;
cross-topic and guessed-topic reads, publish and mapping/table refusals;
unconfigured properties; and rejection of a conflicting broad policy. The
migration was applied repeatedly to verify idempotency. All records are
synthetic. Run with `IRON_GATE_REALTIME_PG_TEST_URL` pointing only to a local
database named `iron_gate_realtime_test` and Node's `--experimental-strip-types
--test tests/calendar-realtime.postgres.test.mjs` options from `iron-gate`.

The local fixture substitutes a transactional `realtime.send` implementation;
it does not prove hosted WebSocket authorization or delivery. Before enabling
the OS stream, independently verify a real anonymous private-channel join,
rejection of an unknown topic and client publication, and committed versus
rolled-back synthetic notification delivery. Verify event receipt through the
authenticated OS stream and an authoritative calendar refresh. Do not mutate
real bookings, occupancy, payments or external stock for these checks.

Apply the source-controlled SQL as a single administrative transaction only
after inspecting the target Supabase project, current Realtime table/function
definitions and policies. Provision only the explicitly active property/topic
mappings separately, then read back the schema, trigger, RLS, grants and mapping
count without revealing capabilities. The existing backend outbox already
covers this bridge; no booking-service runtime change is required.

For rollback, disable the OS stream and deactivate the targeted mappings. This
stops new broadcasts while preserving all orders and outbox events; it does not
require reverting the booking backend. Rotate a topic by replacing the mapping
and the corresponding server setting together, then reconnect and verify it.
Existing listeners on the old topic receive no future events. Periodic and
foreground reconciliation remain enabled throughout.

At the original October 30 checkpoint only source implementation and isolated
validation were complete. The November 3 follow-up above supersedes that
database-activation status; application release and browser acceptance remain
owned by the coordinating release task.
