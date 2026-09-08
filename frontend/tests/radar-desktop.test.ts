import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopScan, type DesktopCapture } from "../src/lib/competitor-radar/desktop-evidence";
import { enqueueDesktop, claimDesktop, finishDesktop, readDesktop } from "../src/lib/competitor-radar/desktop-queue";
import type { OtaScanRequest } from "../src/lib/competitor-radar/ota-types";
import { radarSameOrigin } from "../src/lib/competitor-radar/request-origin";

const request: OtaScanRequest = { platform: "agoda", startDate: "2026-09-09", days: 1, adults: 2, property: { name: "水芳 Sweetfun", address: "新北市瑞芳區中山路24-1號", registrationNumber: "新北市民宿402號" }, canonicalRooms: [{ id: "201", name: "201", sourceName: "201", origin: "manual", editable: true, bundle: false, features: [] }] };
function capture(): DesktopCapture {
  const context = { checkIn: request.startDate, checkOut: "2026-09-10", adults: 2, children: 0, rooms: 1, currency: "TWD" };
  return { capturedAt: new Date().toISOString(), identity: { propertyId: "59714054", url: "https://www.agoda.com/zh-tw/sweetfun-102/hotel/taipei-tw.html", name: "水芳 Sweetfun", address: request.property.address!, registrationNumber: request.property.registrationNumber! }, days: [{ context, rooms: [{ name: "201", canonicalRoomId: "201", quote: { propertyId: "59714054", roomId: "201", ratePlanId: "offer-1", context, availability: "available", preTaxAmount: 1815.10, taxesAndFees: 281.34, totalAmount: 2096.44, includesTaxesAndFees: true, priceBasis: "stay_total", discountLabels: [], source: "checkout_summary" } }] }], warnings: [] };
}
test("desktop accepts a reconciled checkout, strips query tokens, and retains cents", () => {
  const c = capture(); c.identity.url += "?roomToken=DO-NOT-STORE";
  const result = desktopScan(request, c, Date.now() - 1000);
  assert.equal(result.state, "ready"); assert.equal(result.observations[0].rooms[0].amount, 2096.44);
  assert.ok(!JSON.stringify(result).includes("DO-NOT-STORE"));
});
test("desktop rejects list price, wrong context, wrong property, and invalid tax arithmetic", () => {
  for (const change of [
    (c: DesktopCapture) => { c.days[0].rooms[0].quote.source = "property_offer"; },
    (c: DesktopCapture) => { c.days[0].context.adults = 4; },
    (c: DesktopCapture) => { c.identity.registrationNumber = "新北市民宿999號"; },
    (c: DesktopCapture) => { c.days[0].rooms[0].quote.totalAmount = 1815.10; },
  ]) { const c = capture(); change(c); const result = desktopScan(request, c, Date.now() - 1000); assert.equal(result.observations[0].rooms[0].amount, undefined); assert.equal(result.state, "partial"); }
});
test("desktop sold-out display prices cannot be persisted", () => {
  const c = capture(); c.days[0].rooms[0].quote.availability = "sold_out";
  const room = desktopScan(request, c, Date.now() - 1000).observations[0].rooms[0];
  assert.equal(room.availability, "sold_out"); assert.equal(room.amount, undefined); assert.equal(room.quantity, undefined);
});
test("desktop rejects duplicate dates and historical captures", () => {
  const c = capture(); c.days.push(c.days[0]); assert.throws(() => desktopScan({ ...request, days: 2 }, c, Date.now() - 1000));
  assert.throws(() => desktopScan(request, capture(), Date.now() + 1000), /stale_capture/);
});
test("queue deduplicates, authorizes polling, serializes the desktop and completes once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radar-queue-test-"));
  process.env.RADAR_DESKTOP_QUEUE_DIR = directory;
  try {
    assert.equal(radarSameOrigin("https://attacker.example", "http://localhost:43118", "127.0.0.1:43118"), false);
    assert.equal(radarSameOrigin("http://127.0.0.1:43118", "http://localhost:43118", "127.0.0.1:43118"), true);
    assert.equal(radarSameOrigin("http://127.0.0.1:43118", "http://localhost:43118", "attacker.example:43118"), false);
    const [a, duplicate] = await Promise.all([enqueueDesktop(request), enqueueDesktop(request)]); assert.equal(a.id, duplicate.id);
    await assert.rejects(readDesktop(a.id, "0".repeat(64)), /invalid_job/);
    assert.equal((await readDesktop(a.id, a.token)).state, "queued");
    const claimed = await claimDesktop(); assert.ok(claimed); assert.equal(await claimDesktop(), null);
    await assert.rejects(finishDesktop(a.id, "wrong", capture()), /invalid_claim/);
    await finishDesktop(a.id, claimed.claim, capture());
    assert.equal((await readDesktop(a.id, a.token)).state, "done");
    await assert.rejects(finishDesktop(a.id, claimed.claim, capture()), /invalid_claim/);
    await assert.rejects(enqueueDesktop({ ...request, platform: "booking" }));
  } finally { delete process.env.RADAR_DESKTOP_QUEUE_DIR; await rm(directory, { recursive: true, force: true }); }
});
