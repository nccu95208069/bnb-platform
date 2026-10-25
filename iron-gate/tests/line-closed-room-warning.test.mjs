import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";

const id = (n) => `${n}`.repeat(8) + "-1111-4111-8111-111111111111";
const propertyId = id(2), roomId = id(3);
const closed = { roomId, date: "2026-11-10" };
async function setup() {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId: id(1), propertyId, roomIds: [roomId], version: 1,
    authorityEpoch: 7, readOnly: false, channel: { mode: "owlnest", ready: true,
      grantId: id(5), sourceReadbackEnabled: true, stockObservedFrom: "2026-11-01",
      stockObservedThrough: "2026-12-31" }, sourceGrants: [], bookings: [],
    sourceLinks: [], operations: [], fences: [], manualBlocks: [closed], receipts: [] });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = { clientId: "synthetic", subjectId: "staff", origin: "line",
    workspaceId: id(1), propertyIds: [propertyId], authorityEpoch: 7, grantId: id(6),
    actions: ["booking:read", "booking:create", "booking:amend", "booking:manage_all", "inventory:write"],
    fields: ["guest_name", "money", "contact", "notes"] };
  const input = { expectedInventoryVersion: 1, channelPolicy: "manual", source: "line",
    stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }],
    guestName: "Synthetic Guest", contact: null, notes: null, totalCents: 100000,
    bookedAt: "2026-10-25", acknowledgedClosedNights: [closed] };
  return { repository, service, actor, input };
}
const code = (expected) => (error) => error.code === expected;

test("acknowledged manual closure can be registered, remains closed and retry is idempotent", async () => {
  const { repository, service, actor, input } = await setup();
  const preview = await service.previewLineCreate(actor, propertyId, input);
  assert.deepEqual(preview.closedRoomNights, [closed]);
  assert.equal((await repository.read(propertyId)).bookings.length, 0);
  const request = crypto.randomUUID();
  const result = await service.createBooking(actor, propertyId, request, input, preview.previewToken);
  assert.equal(result.operationState, "action_required");
  assert.deepEqual(await service.createBooking(actor, propertyId, request, input, preview.previewToken), result);
  const state = await repository.read(propertyId);
  assert.equal(state.bookings.length, 1);
  assert.deepEqual(state.manualBlocks, [closed]);
  assert.equal(state.operations.length, 0);
  assert.deepEqual(repository.auditRecords(propertyId)[0].acknowledgedClosedNights, [closed]);
});

test("manual closure cannot be bypassed without exact acknowledged nights or manual policy", async () => {
  const { service, actor, input } = await setup();
  const { acknowledgedClosedNights, ...without } = input;
  await assert.rejects(service.previewLineCreate(actor, propertyId, without), code("ROOM_CONFLICT"));
  for (const nights of [[], [closed, closed], [{ ...closed, date: "2026-11-11" }]]) {
    await assert.rejects(service.previewLineCreate(actor, propertyId,
      { ...input, acknowledgedClosedNights: nights }), code("CLOSED_ROOM_ACK_MISMATCH"));
  }
  await assert.rejects(service.previewLineCreate(actor, propertyId,
    { ...input, channelPolicy: undefined }), code("FORBIDDEN"));
});

for (const conflict of ["booking", "fence"]) {
  test(`closure acknowledgement never bypasses ${conflict}`, async () => {
    const { repository, service, actor, input } = await setup();
    await repository.transact(propertyId, (state) => {
      if (conflict === "booking") state.bookings.push({ id: id(8), version: 1,
        status: "confirmed", stays: input.stays });
      else state.fences.push({ key: "pending", cells: [closed], reason: "channel_pending" });
    });
    await assert.rejects(service.previewLineCreate(actor, propertyId, input), code("ROOM_CONFLICT"));
  });
}

test("changed target closure and tampered acknowledgement invalidate the signed preview", async () => {
  const { repository, service, actor, input } = await setup();
  const preview = await service.previewLineCreate(actor, propertyId, input);
  await assert.rejects(service.createBooking(actor, propertyId, crypto.randomUUID(),
    { ...input, acknowledgedClosedNights: [] }, preview.previewToken), code("LINE_PREVIEW_REQUIRED"));
  await repository.transact(propertyId, (state) => { state.manualBlocks = []; state.version++; });
  await assert.rejects(service.createBooking(actor, propertyId, crypto.randomUUID(),
    input, preview.previewToken), code("LINE_PREVIEW_REQUIRED"));
  assert.equal((await repository.read(propertyId)).bookings.length, 0);
});

test("HTTP create and amendment carry the exact closed-room acknowledgement", async () => {
  const { createHandler } = await import("../src/http.ts");
  const { repository, service, actor, input } = await setup();
  const handle = createHandler(service, async () => actor);
  async function call(path, method, body, previewToken) {
    const response = await handle(new Request(`https://synthetic.invalid/v1/properties/${propertyId}/${path}`, {
      method, headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(),
        ...(previewToken ? { "x-iron-gate-line-preview": previewToken } : {}) }, body: JSON.stringify(body) }));
    const result = await response.json();
    assert.equal(response.status, method === "POST" && path === "bookings" ? 201 : 200, JSON.stringify(result));
    return result;
  }
  const preview = await call("line-create-previews", "POST", input);
  const created = await call("bookings", "POST", input, preview.previewToken);
  const nextClosed = { roomId, date: "2026-11-12" };
  await repository.transact(propertyId, (state) => { state.manualBlocks.push(nextClosed); state.version++; });
  const state = await repository.read(propertyId);
  const amend = { expectedInventoryVersion: state.version, expectedBookingVersion: 1,
    channelPolicy: "manual", acknowledgedClosedNights: [nextClosed],
    changes: { stays: [{ checkIn: "2026-11-12", checkOut: "2026-11-13", roomIds: [roomId] }] } };
  const action = await call(`bookings/${created.bookingId}/line-action-previews`, "POST",
    { action: "amend", input: amend });
  assert.deepEqual(action.closedRoomNights, [nextClosed]);
  await call(`bookings/${created.bookingId}`, "PATCH", amend, action.previewToken);
  const final = await repository.read(propertyId);
  assert.deepEqual(final.manualBlocks, [closed, nextClosed]);
  assert.deepEqual(final.bookings[0].stays, amend.changes.stays);
  assert.deepEqual(repository.auditRecords(propertyId).at(-1).acknowledgedClosedNights, [nextClosed]);
});
