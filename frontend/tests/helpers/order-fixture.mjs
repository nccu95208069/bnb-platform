import { orderMutation } from "../../src/lib/customer-workspaces/order-mutations.ts";
import { bookingOperation } from "../../src/lib/customer-workspaces/operations.ts";
import { loadWorkspace } from "../../src/lib/customer-workspaces/service.ts";
export const property = {
  id: "p1",
  name: "Synthetic inn",
  kind: "rooms",
  rooms: [
    { id: "101", name: "101" },
    { id: "102", name: "102" },
  ],
  villaRoomIds: [],
  sourceMode: "native",
};
export const booking = {
  id: "b1",
  propertyId: "p1",
  version: 1,
  guestName: "Test Guest",
  checkIn: "2027-01-31",
  checkOut: "2027-02-02",
  roomIds: ["101", "102"],
  total: 9000,
  payments: [],
  contact: null,
  notes: "需要收據",
  status: "confirmed",
  guestNotified: false,
  createdAt: "2026-10-01T00:00:00Z",
  actor: "owner",
  entry: "os",
  requestKey: "synthetic-booking-01",
  requestHash: "hash",
  platform: "Booking",
  bookedAt: "2026-09-30",
  imported: { externalId: "TEST-123", fingerprint: "synthetic" },
};
export function fixture() {
  let n = 0;
  const workspace = {
    id: "ws",
    slug: "test-orders",
    name: "Synthetic",
    version: 1,
    properties: [
      property,
      { ...property, id: "p2", rooms: [{ id: "201", name: "201" }] },
    ],
    bookings: [structuredClone(booking)],
    members: [
      {
        accountId: "owner",
        role: "owner",
        active: true,
        allProperties: true,
        propertyIds: [],
      },
      {
        accountId: "limited",
        role: "admin",
        active: true,
        allProperties: false,
        propertyIds: ["p2"],
      },
      {
        accountId: "hidden",
        role: "viewer_no_price",
        active: true,
        allProperties: true,
        propertyIds: [],
      },
    ],
    audit: [],
  };
  const values = new Map([
    ["slug:test-orders", JSON.stringify("ws")],
    ["workspace:ws", JSON.stringify(workspace)],
  ]);
  const store = {
    async read(key) {
      const raw = values.get(key) ?? null;
      return { raw, value: raw ? JSON.parse(raw) : null };
    },
    async commit(changes) {
      if (changes.some((c) => (values.get(c.key) ?? null) !== c.before))
        throw new Error("VERSION_CONFLICT");
      for (const c of changes) values.set(c.key, JSON.stringify(c.after));
    },
    async limit() {},
  };
  const current = async () =>
    (await loadWorkspace(store, "owner", "test-orders")).workspace;
  const input = async (fields) => {
    const w = await current();
    return {
      version: w.version,
      bookingVersion: w.bookings[0].version,
      bookingId: "b1",
      propertyId: "p1",
      requestKey: `order-test-request-${++n}`,
      ...fields,
    };
  };
  return {
    store,
    current,
    input,
    mutate: async (fields, actor = "owner") =>
      orderMutation(store, actor, "test-orders", await input(fields)),
    pay: async (fields) =>
      bookingOperation(
        store,
        "owner",
        "test-orders",
        await input({
          action: "payment",
          receivedAt: "2026-01-01T12:00:00+08:00",
          ...fields,
        }),
      ),
  };
}
