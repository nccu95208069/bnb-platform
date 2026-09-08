import assert from "node:assert/strict";
import test from "node:test";
import { prioritizeRoomTitleCapacity } from "../src/lib/competitor-radar/preview-room-draft";
import { checkBooking, offerObservation, parseBookingImport, parseDraft, scenarioJson, syntheticDraft } from "../src/lib/competitor-radar/preview-contract";

test("quad title beats unrelated one-person number from page context", () => {
  const a = syntheticDraft().analysis;
  a.canonicalRooms[0].name = "101 河景四人房"; a.canonicalRooms[0].capacity = 1;
  const result = prioritizeRoomTitleCapacity(a);
  assert.equal(result.canonicalRooms[0].capacity, 4);
  assert.equal(a.canonicalRooms[0].capacity, 1);
  assert.match(result.warnings.join(""), /標題/);
});
test("double title beats unrelated page context and preserves six room definitions", () => {
  const a = syntheticDraft().analysis;
  a.canonicalRooms[0].name = "301 河景雙人房"; a.canonicalRooms[0].capacity = 1;
  const result = prioritizeRoomTitleCapacity(a);
  assert.equal(result.canonicalRooms[0].capacity, 2);
  assert.equal(result.canonicalRooms.length, a.canonicalRooms.length);
});
test("unknown occupancy stays unknown for generic suite without evidence", () => {
  const a = syntheticDraft().analysis;
  a.canonicalRooms[0].name = "花園套房"; a.canonicalRooms[0].capacity = undefined;
  assert.equal(prioritizeRoomTitleCapacity(a).canonicalRooms[0].capacity, undefined);
});
test("nested property address object is rejected before identity matching", () => {
  const d = syntheticDraft();
  (d.analysis.property as unknown as Record<string, unknown>).address = { poisoned: true };
  assert.throws(() => parseDraft(JSON.stringify(d)));
});
test("nested candidate evidence and conflicts must be safe renderable values", () => {
  const d = syntheticDraft();
  (d.analysis as unknown as Record<string, unknown>).tourismRegistry = { status: "review", message: "review", candidates: [{ hotelId: "x", name: "x", score: 1, status: "review", conflicts: [], evidence: [{ label: {}, detail: "x" }] }] };
  assert.throws(() => parseDraft(JSON.stringify(d)));
});
test("stored Booking numbers cannot be injected as strings or negative quantities", () => {
  const d = syntheticDraft(); d.booking = parseBookingImport(scenarioJson("normal"));
  (d.booking.offers[0] as unknown as Record<string, unknown>).price = "1000";
  assert.throws(() => parseDraft(JSON.stringify(d)));
  d.booking.offers[0].price = 1000; d.booking.offers[0].roomsLeft = -1;
  assert.throws(() => parseDraft(JSON.stringify(d)));
});
test("synthetic marker survives JSON import and cannot turn into a live-source badge", () => {
  assert.equal(parseBookingImport(scenarioJson("normal")).source, "synthetic");
});
test("multiple inconsistent scarcity labels never fall back to exact quantity", () => {
  const raw = JSON.parse(scenarioJson("normal"));
  raw.availability[0].policies = ["We have 1 left", "We have 3 left"];
  raw.availability[0].rooms_left = 2;
  const doc = parseBookingImport(JSON.stringify(raw));
  assert.equal(offerObservation(doc.offers[0], true).quantity, undefined);
});
test("root soldout contradicting bookable offers invalidates the observation", () => {
  const d = syntheticDraft(); d.booking = parseBookingImport(scenarioJson("normal")); d.booking.soldOut = true;
  assert.equal(checkBooking(d).accepted, false);
});
test("prototype-shaped room keys cannot be read as mappings", () => {
  const raw = JSON.parse(scenarioJson("normal")); raw.availability[0].room_id = "constructor";
  assert.throws(() => parseBookingImport(JSON.stringify(raw)));
});

test("changing a government candidate derives new evidence without retaining the old license", async () => {
  const { propertyForVerification } = await import("../src/lib/competitor-radar/preview-contract");
  const d = syntheticDraft();
  d.analysis.property.registrationNumber = undefined;
  d.analysis.tourismRegistry = { status: "review", sourceUrl: "https://example.com", message: "review", candidates: [
    { hotelId: "a", name: "A", matchedName: "A", registrationNumber: "新北市民宿1號", status: "review", score: .5, conflicts: [], evidence: [], platformUrls: {} },
    { hotelId: "b", name: "B", matchedName: "B", registrationNumber: "新北市民宿2號", status: "review", score: .5, conflicts: [], evidence: [], platformUrls: {} },
  ] };
  d.registryDecision = { hotelId: "a", action: "confirmed" };
  assert.equal(propertyForVerification(d).registrationNumber, "新北市民宿1號");
  d.registryDecision = { hotelId: "b", action: "confirmed" };
  assert.equal(propertyForVerification(d).registrationNumber, "新北市民宿2號");
  d.registryDecision = { hotelId: "b", action: "rejected" };
  assert.equal(propertyForVerification(d).registrationNumber, undefined);
});

test("returned context must independently match all stay fields", async () => {
  const { contextMatches, sameListing } = await import("../src/lib/competitor-radar/ota-evidence");
  const expected = { checkIn: "2026-09-10", checkOut: "2026-09-11", adults: 2, children: 0, rooms: 1, currency: "TWD" };
  assert.equal(contextMatches(expected, {}), false);
  for (const key of Object.keys(expected)) {
    const missing = { ...expected }; delete missing[key as keyof typeof missing];
    assert.equal(contextMatches(expected, missing), false);
  }
  assert.equal(contextMatches(expected, { ...expected, adults: 4 }), false);
  assert.equal(contextMatches(expected, expected), true);
  assert.equal(sameListing("https://www.agoda.com/sweetfun/hotel/taipei-tw.html", "https://www.agoda.com/nearby/hotel/taipei-tw.html"), false);
  assert.equal(sameListing("https://www.agoda.com/sweetfun/hotel/taipei-tw.html", "http://127.0.0.1"), false);
});

test("Chinese address numbers normalize without changing road names", async () => {
  const { compareTaiwanAddresses } = await import("../src/lib/competitor-radar/address");
  assert.equal(compareTaiwanAddresses("新北市瑞芳區東和里中山路二十四之一號", "新北市瑞芳區中山路24號之1").status, "match");
  assert.equal(compareTaiwanAddresses("臺北市信義區三民路一段二巷三號", "台北市信義區三民路1段2巷3號").status, "match");
  assert.equal(compareTaiwanAddresses("新北市瑞芳區中山路24號", "新北市瑞芳區中正路24號").status, "conflict");
});

test("omitted licensing jurisdiction does not invent a registration conflict", async () => {
  const { scorePropertyIdentity } = await import("../src/lib/competitor-radar/identity");
  const a = { registrationNumber: "Registration No: 402", address: "新北市瑞芳區中山路24-1號" };
  const b = { registrationNumber: "新北市民宿402號", address: "新北市瑞芳區中山路24之1號" };
  assert.equal(scorePropertyIdentity(a, b).status, "confirmed");
  assert.equal(scorePropertyIdentity({ registrationNumber: "宜蘭縣民宿402號" }, b).status, "rejected");
});

test("disputed legacy Agoda observations are quarantined without mutating stored evidence", async () => {
  const { currentScan, AGODA_EVIDENCE_VERSION } = await import("../src/lib/competitor-radar/ota-evidence");
  const old = { platform: "agoda" as const, state: "ready" as const, capturedAt: "2026-09-08T04:34:03.708Z", requestedDays: 14, completedDays: 14, identity: { platform: "agoda" as const, status: "confirmed" as const, evidence: [] }, observations: [{ stayDate: "2026-09-09", checkOut: "2026-09-10", state: "ready" as const, availability: "sold_out" as const, identityVerified: true, dateVerified: true, rooms: [] }], warnings: [], durationMs: 1 };
  assert.deepEqual(currentScan(old).observations, []);
  assert.equal(old.observations.length, 1);
  assert.equal(currentScan(old).capturedAt, old.capturedAt);
  assert.equal(currentScan({ ...old, evidenceVersion: AGODA_EVIDENCE_VERSION }).observations.length, 1);
});

test("Agoda final total keeps taxes and ignores sold-out display prices", async () => {
  const { acceptedQuote } = await import("../src/lib/competitor-radar/quote-evidence");
  const context = { checkIn: "2026-09-09", checkOut: "2026-09-10", adults: 2, children: 0, rooms: 1, currency: "TWD" };
  const expected = { propertyId: "reference-property", roomId: "201", ratePlanId: "pay-now", context };
  // Owner screenshot reference, not a live response or a production data fallback.
  const q = { ...expected, availability: "available" as const, preTaxAmount: 1815.10, taxesAndFees: 281.34, totalAmount: 2096.44, includesTaxesAndFees: true, priceBasis: "stay_total" as const, discountLabels: ["折扣碼減價"], source: "checkout_summary" as const };
  assert.equal(acceptedQuote(expected, q).amount, 2096.44);
  assert.equal(acceptedQuote(expected, { ...q, includesTaxesAndFees: false }).amount, undefined);
  assert.equal(acceptedQuote(expected, { ...q, totalAmount: 1815.10 }).amount, undefined);
  assert.equal(acceptedQuote(expected, { ...q, availability: "sold_out" }).amount, undefined);
  assert.equal(acceptedQuote(expected, { ...q, ratePlanId: "pay-at-property" }).availability, "unknown");
  assert.equal(acceptedQuote(expected, { ...q, context: { ...context, adults: 4 } }).amount, undefined);
});
