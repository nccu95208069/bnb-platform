import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/lib/customer-workspaces/auth.ts";
import { acceptTenantEvent, eventClient, eventReceipt } from "../src/lib/customer-events/contract.ts";

const ids = {
  a: {
    workspace: "11111111-1111-4111-8111-111111111111",
    property: "22222222-2222-4222-8222-222222222222",
    room: "33333333-3333-4333-8333-333333333333",
    order: "44444444-4444-4444-8444-444444444444",
  },
  b: {
    workspace: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    property: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    room: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    order: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  },
};
const tokenA = "synthetic-tenant-a-token-only-for-tests-123456";
const tokenB = "synthetic-tenant-b-token-only-for-tests-123456";

function fixture() {
  process.env.CUSTOMER_EVENTS_ENABLED = "true";
  process.env.CUSTOMER_EVENT_CLIENTS = JSON.stringify([
    { id: "tenant-a-writer", token_sha256: digest(tokenA), scopes: [{ workspace_id: ids.a.workspace, property_ids: [ids.a.property] }], sources: ["line", "gmail"] },
    { id: "tenant-b-writer", token_sha256: digest(tokenB), scopes: [{ workspace_id: ids.b.workspace, property_ids: [ids.b.property] }], sources: ["gmail"] },
  ]);
  const values = new Map();
  for (const tenant of ["a", "b"]) {
    const id = ids[tenant];
    const workspace = {
      id: id.workspace, slug: tenant, version: 1, properties: [{ id: id.property, rooms: [{ id: id.room }] }],
      bookings: [{ id: id.order, version: 2, propertyId: id.property, roomIds: [id.room], checkIn: "2026-10-20", checkOut: "2026-10-22", status: "confirmed" }],
    };
    values.set(`workspace:${id.workspace}`, JSON.stringify(workspace));
  }
  const store = {
    values,
    read: async (key) => ({ raw: values.get(key) ?? null, value: JSON.parse(values.get(key) ?? "null") }),
    commit: async (changes) => {
      if (changes.some((change) => (values.get(change.key) ?? null) !== change.before)) throw Error("VERSION_CONFLICT");
      for (const change of changes) values.set(change.key, JSON.stringify(change.after));
    },
    limit: async () => {},
  };
  const payload = (tenant, eventId) => ({
    schema: 1, event_id: eventId, workspace_id: ids[tenant].workspace,
    property_id: ids[tenant].property, order_id: ids[tenant].order, order_version: 2,
    source_version: "source-v2", source: "gmail", kind: "booking.changed",
    occurred_at: "2026-10-12T00:00:00Z", verified: true,
    check_in: "2026-10-20", check_out: "2026-10-22", room_ids: [ids[tenant].room],
  });
  return { store, payload, a: eventClient(`Bearer ${tokenA}`), b: eventClient(`Bearer ${tokenB}`) };
}

test("two tenant credentials cannot cross-read events or claim another property's order", async () => {
  const { store, payload, a, b } = fixture();
  const input = payload("a", "event-a-001");
  const saved = await acceptTenantEvent(store, a, input);
  assert.equal(saved.verified, true);
  assert.equal(saved.order_id, ids.a.order);
  assert.deepEqual(await acceptTenantEvent(store, a, input), saved);
  assert.deepEqual(await eventReceipt(store, a, input.event_id), saved);
  await assert.rejects(eventReceipt(store, b, input.event_id), /NOT_FOUND/);
  await assert.rejects(acceptTenantEvent(store, a, payload("b", "event-b-001")), /FORBIDDEN/);
  assert.equal((await acceptTenantEvent(store, b, payload("b", "event-b-001"))).verified, true);
  await assert.rejects(acceptTenantEvent(store, a, { ...input, source_version: "changed" }), /IDEMPOTENCY_CONFLICT/);
});

test("readback refuses stale state and accepts exact retry only after OS order matches", async () => {
  const { store, payload, a } = fixture();
  const input = payload("a", "event-a-002");
  const wrong = { ...input, order_version: 3 };
  await assert.rejects(acceptTenantEvent(store, a, wrong), /SOURCE_NOT_VERIFIED/);
  await assert.rejects(eventReceipt(store, a, input.event_id), /NOT_FOUND/);
  await assert.rejects(acceptTenantEvent(store, a, { ...input, room_ids: [ids.b.room] }), /SOURCE_NOT_VERIFIED/);
  const changed = (await store.read(`workspace:${ids.a.workspace}`)).value;
  changed.bookings[0].version = 3;
  changed.version++;
  store.values.set(`workspace:${ids.a.workspace}`, JSON.stringify(changed));
  assert.equal((await acceptTenantEvent(store, a, wrong)).order_version, 3);
  await assert.rejects(acceptTenantEvent(store, a, { ...wrong, source: "owlnest" }), /FORBIDDEN/);
});

test("malformed or unconfigured service credentials never access tenant receipts", async () => {
  const { store, payload } = fixture();
  assert.throws(() => eventClient("Bearer wrong"), /UNAUTHORIZED/);
  const a = eventClient(`Bearer ${tokenA}`);
  await assert.rejects(acceptTenantEvent(store, a, { ...payload("a", "event-a-003"), guest_name: "private" }), /INVALID_INPUT/);
  process.env.CUSTOMER_EVENTS_ENABLED = "false";
  assert.throws(() => eventClient(`Bearer ${tokenA}`), /EVENTS_UNAVAILABLE/);
});
