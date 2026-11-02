import test from "node:test";
import assert from "node:assert/strict";
import { createOwlNestWebReadback } from "../src/owlnest-web-readback.mjs";

const propertyId = "00000000-0000-4000-8000-000000000011";
const roomA = "00000000-0000-4000-8000-000000000021";
const roomB = "00000000-0000-4000-8000-000000000022";
const requested = [
  { roomId: roomA, date: "2026-11-10", desired: "closed" },
  { roomId: roomB, date: "2026-11-11", desired: "open" },
];
const token = "Bearer " + "a".repeat(48);
const raw = { status: 0, data: [
  { room_id: 101, stocks: [{ date: "2026-11-10", count: 0, is_lock: 1 }] },
  { room_id: 102, stocks: [{ date: "2026-11-11", count: 1, is_lock: false }] },
] };

function adapter({ payload = raw, status = 200, auth = token, fetchImpl } = {}) {
  const calls = [];
  const readback = createOwlNestWebReadback({
    propertyConfigs: { [propertyId]: { hotelId: 6188, roomIds: { [roomA]: 101, [roomB]: 102 } } },
    getAuthorization: async () => auth,
    fetchImpl: fetchImpl ?? (async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(payload), { status });
    }),
    now: () => new Date("2026-11-01T10:00:00.000Z"),
  });
  return { readback, calls };
}

test("login-backed calendar read maps every requested night without a write", async () => {
  const { readback, calls } = adapter();
  const result = await readback.observe(propertyId, requested);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].url.origin, "https://www.owlting.com");
  assert.equal(calls[0].url.pathname, "/booking/v2/admin/hotels/6188/calendars");
  assert.equal(calls[0].url.searchParams.get("during_start_date"), "2026-11-10");
  assert.equal(calls[0].url.searchParams.get("during_end_date"), "2026-11-11");
  assert.deepEqual(result.cells, [
    { roomId: roomA, date: "2026-11-10", count: 0, isLock: true },
    { roomId: roomB, date: "2026-11-11", count: 1, isLock: false },
  ]);
  assert.equal(result.observedAt, "2026-11-01T10:00:00.000Z");
  assert.match(result.providerVersion, /^[0-9a-f]{64}$/);
});

test("missing, duplicate, and unknown stock cannot become verified evidence", async () => {
  const missing = adapter({ payload: { status: 0, data: raw.data.slice(0, 1) } });
  await assert.rejects(missing.readback.observe(propertyId, requested),
    { message: "OWLNEST_RESPONSE_INCOMPLETE" });
  const duplicate = adapter({ payload: { status: 0, data: [raw.data[0], raw.data[0], raw.data[1]] } });
  await assert.rejects(duplicate.readback.observe(propertyId, requested),
    { message: "OWLNEST_RESPONSE_INVALID" });
  const unknown = adapter({ payload: { status: 0, data: [
    { room_id: 101, stocks: [{ date: "2026-11-10", count: null, is_lock: false }] },
    raw.data[1],
  ] } });
  await assert.rejects(unknown.readback.observe(propertyId, requested),
    { message: "OWLNEST_RESPONSE_INVALID" });
});

test("expired tokens and backend auth errors fail before readback", async () => {
  const badToken = adapter({ auth: "Bearer undefined" });
  await assert.rejects(badToken.readback.observe(propertyId, requested),
    { message: "OWLNEST_AUTH_EXPIRED" });
  assert.equal(badToken.calls.length, 0);
  const expired = adapter({ payload: { status: 30003, data: [] } });
  await assert.rejects(expired.readback.observe(propertyId, requested),
    { message: "OWLNEST_AUTH_EXPIRED" });
  const denied = adapter({ status: 401 });
  await assert.rejects(denied.readback.observe(propertyId, requested),
    { message: "OWLNEST_AUTH_EXPIRED" });
});

test("rejects cross-property requests, duplicate cells, and oversized responses", async () => {
  const { readback, calls } = adapter();
  await assert.rejects(readback.observe("00000000-0000-4000-8000-000000000099", requested),
    { message: "OWLNEST_NOT_CONFIGURED" });
  await assert.rejects(readback.observe(propertyId, [requested[0], requested[0]]),
    { message: "OWLNEST_INVALID_CELLS" });
  await assert.rejects(readback.observe(propertyId, [{ roomId: roomA, date: "2026-02-30" }]),
    { message: "OWLNEST_INVALID_DAY" });
  assert.equal(calls.length, 0);
  const huge = adapter({ fetchImpl: async () => new Response("{}", {
    headers: { "content-length": String(8 * 1024 * 1024 + 1) },
  }) });
  await assert.rejects(huge.readback.observe(propertyId, requested),
    { message: "OWLNEST_RESPONSE_TOO_LARGE" });
  const unannounced = adapter({ fetchImpl: async () =>
    new Response("x".repeat(8 * 1024 * 1024 + 1)) });
  await assert.rejects(unannounced.readback.observe(propertyId, requested),
    { message: "OWLNEST_RESPONSE_TOO_LARGE" });
});
