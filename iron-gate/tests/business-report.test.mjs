import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";
import { createHandler } from "../src/http.ts";
import { createGrantAuthenticator } from "../src/authenticator.mjs";
import { validateGrantShape } from "../src/credential-grant.mjs";
import { createBusinessReport } from "../src/business-report.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const secondRoomId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-10-24T02:00:00.000Z");
const token = "a".repeat(43);
const url = `https://iron.invalid/v1/properties/${propertyId}/business-report`;
const actor = (overrides = {}) => ({ clientId: "dashboard-reporter", subjectId: "dashboard-reporter",
  origin: "service", workspaceId, propertyIds: [propertyId], authorityEpoch: 7,
  actions: ["booking:aggregate"], fields: [], ...overrides });
const grant = (overrides = {}) => ({ ...actor(), credentialId: crypto.randomUUID(),
  propertyId, ...overrides });
const state = (bookings = [], overrides = {}) => ({ workspaceId, propertyId,
  roomIds: [roomId, secondRoomId], version: 42, authorityEpoch: 7, readOnly: false,
  channel: { mode: "none", ready: false, websiteSalesEnabled: false,
    grantId: null, websiteBindingId: null }, sourceGrants: [], bookings,
  sourceLinks: [], operations: [], fences: [], manualBlocks: [], receipts: [], ...overrides });
const row = (room, checkIn, checkOut, amount, bookedAt = "2026-10-23") => ({
  room, checkIn, checkOut, bookedAt, roomFeeCents: amount,
  values: [room, "PRIVATE-GUEST", "Booking", checkIn, checkOut, bookedAt, amount / 100,
    "done", "", "PRIVATE-SOURCE-ROW", "PRIVATE-NOTE", "PRIVATE-PARENT-ALIAS", "", "PRIVATE-OTA-REF"],
});
const booking = (overrides = {}) => ({ id: crypto.randomUUID(), workspaceId, propertyId,
  version: 1, status: "confirmed", channelSyncState: "not_required", channelOperationKey: null,
  stays: [{ roomIds: [roomId], checkIn: "2026-10-24", checkOut: "2026-10-25" }],
  guestName: "PRIVATE-GUEST", contact: "private@example.test", notes: "PRIVATE-NOTE",
  totalCents: 100000, currency: "TWD", bookedAt: "2026/10/23", createdAt: now.toISOString(),
  source: "external", sourceKey: "PRIVATE-SOURCE-KEY", paymentEvents: [],
  sweetfunSnapshot: { groupKey: "PRIVATE-PARENT-ALIAS",
    rows: [row("101", "2026-10-24", "2026-10-25", 100000)] }, ...overrides });
const isError = (code) => (error) => error?.code === code;

test("aggregate grants are explicit, service-only, and contain no field scopes", () => {
  assert.doesNotThrow(() => validateGrantShape(grant()));
  for (const origin of ["os", "finance", "line", "website", "guest", "source", "channel"])
    assert.throws(() => validateGrantShape(grant({ origin })), /INVALID_BUSINESS_REPORT_SCOPE/);
  for (const field of ["money", "guest_name", "contact", "notes", "payment_status"])
    assert.throws(() => validateGrantShape(grant({ fields: [field] })), /INVALID_SERVICE_SCOPE/);
  assert.throws(() => validateGrantShape(grant({ actions: ["booking:aggregate", "booking:create"] })),
    /INVALID_SERVICE_SCOPE/);
});

test("service report is scoped to property, workspace, action and current authority", async () => {
  const repository = new MemoryPropertyRepository();
  repository.seed(state());
  const service = new IronGateService(repository);
  for (const overrides of [
    { workspaceId: crypto.randomUUID() }, { propertyIds: [crypto.randomUUID()] },
    { actions: ["booking:read"] }, { actions: ["occupancy:aggregate"] },
    { origin: "os" }, { fields: ["money"] },
  ]) await assert.rejects(service.businessReport(actor(overrides), propertyId), isError("FORBIDDEN"));
  await assert.rejects(service.businessReport(actor({ authorityEpoch: 6 }), propertyId), isError("AUTHORITY_MOVED"));
  await repository.transact(propertyId, (draft) => { draft.readOnly = true; });
  await assert.rejects(service.businessReport(actor(), propertyId), isError("PROPERTY_READ_ONLY"));
  await repository.transact(propertyId, (draft) => { draft.readOnly = false; draft.authorityEpoch = 0; });
  await assert.rejects(service.businessReport(actor({ authorityEpoch: 0 }), propertyId), isError("AUTHORITY_MOVED"));
});

test("authenticated reporting GET needs no OS proof, performs no writes, and grants no booking read", async () => {
  const repository = new MemoryPropertyRepository();
  repository.seed(state([booking()]));
  const before = await repository.read(propertyId);
  const issued = grant();
  const authenticate = createGrantAuthenticator({ lookup: async (value) => value === token ? issued : null }, repository);
  const handler = createHandler(new IronGateService(repository), authenticate);
  assert.equal((await handler(new Request(url))).status, 401);
  const request = (path = url, method = "GET") => new Request(path,
    { method, headers: { authorization: `Bearer ${token}` } });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const report = await response.json();
  assert.equal(report.meta.source, "iron-gate");
  assert.equal(report.meta.inventoryVersion, 42);
  assert.equal(report.meta.authorityEpoch, 7);
  assert.equal(report.meta.readOnly, false);
  assert.equal(report.meta.saleReady, false);
  assert.equal(report.meta.sourceUpdatedAt, null);
  assert.equal((await handler(request(url.replace("business-report", "bookings")))).status, 403);
  assert.equal((await handler(request(url, "POST"))).status, 404);
  assert.equal((await handler(request(url.replace(propertyId, crypto.randomUUID())))).status, 404);
  assert.deepEqual(await repository.read(propertyId), before);
});

test("authority changes between authentication and reporting fail closed", async () => {
  let reads = 0;
  const repository = { read: async () => state([], { authorityEpoch: ++reads === 1 ? 7 : 8 }),
    transact: () => { throw Error("report must not write"); }, events: async () => [] };
  const authenticate = createGrantAuthenticator({ lookup: async () => grant() }, repository);
  const handler = createHandler(new IronGateService(repository), authenticate);
  const response = await handler(new Request(url, { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "AUTHORITY_MOVED");
});

test("reports all canonical confirmed bookings, including far-future stays, and preserves exact legacy room prices", () => {
  const first = booking({ totalCents: 300000,
    stays: [{ roomIds: [roomId], checkIn: "2026-10-23", checkOut: "2026-10-24" },
      { roomIds: [secondRoomId], checkIn: "2026-10-23", checkOut: "2026-10-24" }],
    sweetfunSnapshot: { rows: [row("101", "2026-10-23", "2026-10-24", 100000),
      row("102", "2026-10-23", "2026-10-24", 200000)] } });
  const distant = booking({ stays: [{ roomIds: [roomId, secondRoomId], checkIn: "2030-01-01", checkOut: "2030-01-03" }],
    sourceCalendar: { platform: "Agoda", externalOrderNo: "PRIVATE-OTA-REF" }, totalCents: 400001 });
  const report = createBusinessReport(state([first, distant, booking({ status: "held" }),
    booking({ status: "cancelled" })]), () => true, now);
  assert.equal(report.yesterday.orders, 2);
  assert.equal(report.yesterday.nights, 6);
  assert.equal(report.yesterday.amount, 7000.01);
  assert.equal(report.yesterday.lastNight.revenue, 3000);
  assert.deepEqual(report.yesterday.lastNight.occupied, ["101", "102"]);
  assert.equal(report.meta.excludedUnconfirmedOrders, 2);
  assert.equal(report.meta.estimatedNightRevenueOrders, 1);
  assert.equal(report.last7.daily30.length, 30);
  assert.equal(report.upcoming.orders, 1);
  assert.deepEqual(report.today.checkOuts, []);
  assert.equal(report.today.checkOutsCount, 2);
});

test("missing source dates and amounts stay unknown; import timestamps are never used", () => {
  const missing = booking({ bookedAt: null, totalCents: null, sweetfunSnapshot: undefined,
    sourceCalendar: { platform: "Booking", externalOrderNo: null } });
  const invalid = booking({ bookedAt: "2026-02-31", sweetfunSnapshot: undefined });
  const report = createBusinessReport(state([missing, invalid]), () => false, now);
  assert.equal(report.meta.orderCount, 2);
  assert.equal(report.meta.unknownBookingDateOrders, 2);
  assert.equal(report.meta.unpricedBookings, 1);
  assert.equal(report.today.orders, 0);
  assert.equal(report.yesterday.orders, 0);
  assert.equal(report.today.tonight.count, 1);
  assert.equal(report.meta.warnings.length >= 2, true);
  assert.equal(report.verdict.level, "flat");
});

test("new source metadata never reuses stale imported labels, booking dates or per-night amounts", () => {
  const changed = booking({ bookedAt: null, version: 2, totalCents: 300000,
    stays: [{ roomIds: [roomId], checkIn: "2026-10-23", checkOut: "2026-10-24" },
      { roomIds: [roomId], checkIn: "2026-10-24", checkOut: "2026-10-25" }],
    sourceCalendar: { platform: null, externalOrderNo: "PRIVATE-OTA-REF" },
    sweetfunSnapshot: { rows: [row("101", "2026-10-23", "2026-10-24", 100000),
      row("101", "2026-10-24", "2026-10-25", 200000)] } });
  const report = createBusinessReport(state([changed]), () => false, now);
  assert.equal(report.meta.unknownBookingDateOrders, 1);
  assert.equal(report.meta.unknownPlatformBookings, 1);
  assert.equal(report.meta.estimatedNightRevenueOrders, 1);
  assert.equal(report.yesterday.lastNight.revenue, 1500);
  assert.equal(report.today.checkIns.length, 0);
});

test("response contains only public room labels and fixed guest placeholders, never raw source strings or canonical IDs", () => {
  const first = booking();
  const second = booking({ sourceCalendar: { platform: "private@example.test", externalOrderNo: "PRIVATE-OTA-REF" } });
  const third = booking({ sourceCalendar: { platform: "constructor", externalOrderNo: null } });
  const report = createBusinessReport(state([first, second, third]), () => false, now);
  const encoded = JSON.stringify(report);
  for (const secret of [workspaceId, propertyId, roomId, secondRoomId, first.id, second.id, third.id,
    "PRIVATE-GUEST", "private@example.test", "PRIVATE-NOTE", "PRIVATE-SOURCE-ROW",
    "PRIVATE-PARENT-ALIAS", "PRIVATE-OTA-REF", "PRIVATE-SOURCE-KEY", "constructor"])
    assert.equal(encoded.includes(secret), false, secret);
  assert.equal(report.yesterday.detail.every((item) => item.guestName === "旅客"), true);
  assert.equal(report.today.checkIns.every((item) => item.guestName === "旅客"), true);
  assert.equal(report.meta.unknownPlatformBookings, 2);
});

test("a room amendment cannot relabel the new canonical room using a stale imported snapshot", () => {
  const original = booking();
  const moved = booking({ version: 2,
    stays: [{ roomIds: [secondRoomId], checkIn: "2026-10-24", checkOut: "2026-10-25" }] });
  const report = createBusinessReport(state([original, moved]), () => false, now);
  assert.deepEqual(report.today.tonight.occupied, ["101", "房間 2"]);
  assert.equal(report.yesterday.detail.some((detail) => detail.room === "101"), true);
  assert.equal(report.yesterday.detail.some((detail) => detail.room === "房間 2"), true);
});

test("current LINE room-night prices are used exactly, with safe fallback for stale prices", async () => {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const shift = (offset) => new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const line = booking({ source: "line", bookedAt: shift(-1), sweetfunSnapshot: undefined,
    totalCents: 300000,
    stays: [{ roomIds: [roomId], checkIn: shift(-1), checkOut: shift(1) }],
    roomNightPrices: [{ roomId, date: shift(-1), amountCents: 100000 },
      { roomId, date: day, amountCents: 200000 }] });
  const repository = new MemoryPropertyRepository();
  repository.seed(state([line]));
  const service = new IronGateService(repository);
  const exact = await service.businessReport(actor(), propertyId);
  assert.equal(exact.yesterday.lastNight.revenue, 1000);
  assert.equal(exact.meta.estimatedNightRevenueOrders, 0);
  assert.equal(exact.yesterday.amount, 3000);
  await repository.transact(propertyId, (draft) => {
    draft.bookings[0].roomNightPrices[0].amountCents = 1;
  });
  const fallback = await service.businessReport(actor(), propertyId);
  assert.equal(fallback.yesterday.lastNight.revenue, 1500);
  assert.equal(fallback.meta.estimatedNightRevenueOrders, 1);
  assert.equal(fallback.yesterday.amount, 3000);
});

test("inconsistent tenant or currency data is rejected before any payload is returned", () => {
  for (const bad of [{ workspaceId: crypto.randomUUID() }, { propertyId: crypto.randomUUID() }, { currency: "USD" }])
    assert.throws(() => createBusinessReport(state([booking(bad)]), () => false, now), isError("REPORT_DATA_INVALID"));
});
