import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ironGateReadConfig, listIronGateRoomActions, readIronGateBooking, readIronGateTags } from
  "../src/lib/customer-workspaces/iron-gate-read.server.ts";

const secret = "synthetic-iron-gate-proof-secret-32-bytes";

function fixture(role = "viewer_no_price") {
  const workspaceId = randomUUID(), propertyId = randomUUID(), accountId = randomUUID(),
    bookingId = randomUUID(), slug = "synthetic-workspace";
  const workspace = { id: workspaceId, slug, version: 1,
    properties: [{ id: propertyId, rooms: [] }], bookings: [],
    members: [{ accountId, role, active: true, allProperties: false, propertyIds: [propertyId] }] };
  const entries = new Map([[`slug:${slug}`, workspaceId], [`workspace:${workspaceId}`, workspace]]);
  const store = { read: async (key) => ({ value: entries.get(key) ?? null, raw: null }) };
  const grant = { credentialId: randomUUID(), clientId: "synthetic-os-gateway",
    workspaceId, propertyId, origin: "os", token: randomBytes(32).toString("base64url") };
  const config = ironGateReadConfig({ IRON_GATE_SHADOW_ENABLED: "true",
    IRON_GATE_BASE_URL: "http://127.0.0.1:8787",
    IRON_GATE_OS_PROOF_SECRET: secret, IRON_GATE_OS_READ_GRANTS: JSON.stringify([grant]) });
  const booking = { id: bookingId, workspaceId, propertyId, version: 1, status: "confirmed",
    channelSyncState: "not_required", stays: [], createdAt: new Date().toISOString(),
    source: "os", guestName: "Synthetic Guest" };
  return { workspace, store, grant, config, accountId, slug, propertyId, bookingId, booking };
}

test("read-only OS gateway signs a fresh member and enforces the response field scope", async () => {
  const input = fixture();
  let seen = false;
  const send = async (url, options) => {
    seen = true;
    assert.match(url, new RegExp(input.bookingId + "$"));
    assert.equal(options.headers.authorization, `Bearer ${input.grant.token}`);
    assert.equal(options.redirect, "error");
    const claims = JSON.parse(Buffer.from(options.headers["x-iron-gate-os-proof"].split(".")[0],
      "base64url").toString("utf8"));
    assert.equal(claims.subjectId, input.accountId);
    assert.deepEqual(claims.fields, ["guest_name"]);
    return Response.json(input.booking);
  };
  assert.deepEqual(await readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config, send), input.booking);
  assert.equal(seen, true);
  await assert.rejects(readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config,
    async () => Response.json({ ...input.booking, totalCents: 100 })), /IRON_GATE_READ_FAILED/);
  for (const extra of [
    { guestName: { public: "Synthetic Guest", hiddenContact: "synthetic hidden value" } },
    { hold: { schema: 1, scope: "platform_only", state: "released",
      startedAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
      latePaymentReview: true } },
    { stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [randomUUID()],
      privateGuestContact: "synthetic hidden value" }] },
  ]) await assert.rejects(readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config,
    async () => Response.json({ ...input.booking, ...extra })), /IRON_GATE_READ_FAILED/);
});

test("OS reads a manual LINE room status without accepting malformed pending cells", async () => {
  const input = fixture("owner");
  const pending = [{ roomId: randomUUID(), date: "2026-11-10", desired: "closed" }];
  const booking = { ...input.booking, source: "line", channelSyncState: "action_required",
    lineChannelPending: pending };
  assert.deepEqual(await readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config,
    async () => Response.json(booking)), booking);
  await assert.rejects(readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config,
    async () => Response.json({ ...booking,
      lineChannelPending: [{ ...pending[0], guestName: "hidden" }] })),
  /IRON_GATE_READ_FAILED/);
});

test("room-action list is membership-scoped, paginated, and projects only safe fields", async () => {
  const input = fixture("viewer_no_price"), cursor = "synthetic_Cursor_1";
  const pending = [{ roomId: randomUUID(), date: "2026-11-10", desired: "closed" }];
  const booking = { ...input.booking, source: "line", channelSyncState: "action_required",
    lineChannelPending: pending, guestName: "Synthetic Guest" };
  const send = async (url, options) => {
    assert.match(url, /limit=50/);
    assert.match(url, /attention=true/);
    assert.match(url, /cursor=synthetic_Cursor_1/);
    const claims = JSON.parse(Buffer.from(options.headers["x-iron-gate-os-proof"].split(".")[0],
      "base64url").toString("utf8"));
    assert.equal(claims.subjectId, input.accountId);
    assert.equal(claims.pathAndQuery, new URL(url).pathname + new URL(url).search);
    return Response.json({ propertyId: input.propertyId, bookings: [booking,
      { ...input.booking, id: randomUUID() }], nextCursor: "next_Cursor_2" });
  };
  assert.deepEqual(await listIronGateRoomActions(input.store, input.accountId, input.slug,
    input.propertyId, cursor, input.config, send), { rows: [{
    id: input.bookingId, status: "confirmed", channelSyncState: "action_required",
    guestName: "Synthetic Guest", createdAt: booking.createdAt, stays: [],
    pendingClose: 1, pendingOpen: 0,
  }], nextCursor: "next_Cursor_2" });
  await assert.rejects(listIronGateRoomActions(input.store, input.accountId, input.slug,
    input.propertyId, "bad.cursor", input.config, send), /INVALID_INPUT/);
  await assert.rejects(listIronGateRoomActions(input.store, input.accountId, input.slug,
    input.propertyId, cursor, input.config,
    async () => Response.json({ propertyId: input.propertyId,
      bookings: [{ ...booking, propertyId: randomUUID() }], nextCursor: null })),
  /IRON_GATE_READ_FAILED/);
  input.workspace.members[0].active = false;
  await assert.rejects(listIronGateRoomActions(input.store, input.accountId, input.slug,
    input.propertyId, cursor, input.config, send), /NOT_FOUND/);
});

test("cancelled history has its own server-filtered page", async () => {
  const input = fixture("owner");
  const cancelled = { ...input.booking, status: "cancelled", channelSyncState: "verified" };
  const send = async (url) => {
    assert.match(url, /status=cancelled/);
    assert.doesNotMatch(url, /attention=true/);
    return Response.json({ propertyId: input.propertyId,
      bookings: [cancelled], nextCursor: null });
  };
  const result = await listIronGateRoomActions(input.store, input.accountId, input.slug,
    input.propertyId, null, input.config, send, "cancelled");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, "cancelled");
});

test("revoked membership, wrong IDs, and unsafe configuration fail closed", async () => {
  const input = fixture("owner");
  input.workspace.members[0].active = false;
  await assert.rejects(readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config, async () => Response.json(input.booking)),
  /NOT_FOUND/);
  input.workspace.members[0].active = true;
  await assert.rejects(readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config,
    async () => Response.json({ ...input.booking, id: randomUUID() })), /IRON_GATE_READ_FAILED/);
  await assert.rejects(readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config,
    async () => { throw new Error("token leaked in transport failure"); }), /IRON_GATE_READ_FAILED/);
  assert.throws(() => ironGateReadConfig({ IRON_GATE_BASE_URL: "https://gate.invalid",
    IRON_GATE_OS_PROOF_SECRET: secret,
    IRON_GATE_OS_READ_GRANTS: JSON.stringify([input.grant]) }), /IRON_GATE_READ_CONFIG_INVALID/);
  assert.throws(() => ironGateReadConfig({ IRON_GATE_SHADOW_ENABLED: "true",
    IRON_GATE_BASE_URL: "http://example.com",
    IRON_GATE_OS_PROOF_SECRET: secret,
    IRON_GATE_OS_READ_GRANTS: JSON.stringify([input.grant]) }), /IRON_GATE_READ_CONFIG_INVALID/);
  assert.throws(() => ironGateReadConfig({ IRON_GATE_SHADOW_ENABLED: "true",
    IRON_GATE_BASE_URL: "https://gate.invalid",
    IRON_GATE_OS_PROOF_SECRET: secret,
    IRON_GATE_OS_READ_GRANTS: JSON.stringify([input.grant, input.grant]) }), /IRON_GATE_READ_CONFIG_INVALID/);
});

test("tag shadow read uses current property membership and rejects extra upstream fields", async () => {
  const input = fixture("housekeeper");
  const projection = { bookingId: input.bookingId, workspaceId: input.workspace.id,
    propertyId: input.propertyId, bookingVersion: 2,
    inventoryVersion: 1, tagCatalogVersion: 3, tagIds: ["pet"],
    tags: [{ id: "pet", name: "寵物" }] };
  const send = async (url, options) => {
    assert.match(url, new RegExp(input.bookingId + "/tags$"));
    assert.equal(options.headers.authorization, `Bearer ${input.grant.token}`);
    const claims = JSON.parse(Buffer.from(options.headers["x-iron-gate-os-proof"].split(".")[0],
      "base64url").toString("utf8"));
    assert.ok(claims.actions.includes("tag:read"));
    assert.equal(claims.propertyId, input.propertyId);
    return Response.json(projection);
  };
  assert.deepEqual(await readIronGateTags(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config, send), projection);
  for (const bad of [
    { ...projection, guestName: "Synthetic Guest" },
    { ...projection, propertyId: randomUUID() },
    { ...projection, tags: [{ id: "wrong", name: "寵物" }] },
    { ...projection, tagIds: ["pet", "pet"], tags: [projection.tags[0], projection.tags[0]] },
  ]) await assert.rejects(readIronGateTags(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config, async () => Response.json(bad)),
  /IRON_GATE_READ_FAILED/);
  input.workspace.members[0].active = false;
  await assert.rejects(readIronGateTags(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config, send), /NOT_FOUND/);
});
