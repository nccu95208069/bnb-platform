import assert from "node:assert/strict";
import test from "node:test";
import { addDays, checkBooking, offerObservation, parseBookingImport, parseDraft, roomCandidates, safeLink, scenarioJson, syntheticDraft, validateDraft, validDate, type Scenario } from "../src/lib/competitor-radar/preview-contract";
import { compareTaiwanAddresses } from "../src/lib/competitor-radar/address";
import { scorePropertyIdentity } from "../src/lib/competitor-radar/identity";

function fixture(scenario: Scenario = "normal") {
  const draft = syntheticDraft(); draft.booking = parseBookingImport(scenarioJson(scenario), "synthetic"); return draft;
}
function payload() { return JSON.parse(scenarioJson("normal")); }

test("valid scenario has independent passing gates", () => {
  const checks = checkBooking(fixture());
  assert.equal(checks.identity, "pass"); assert.equal(checks.dates, "pass"); assert.equal(checks.context, "pass"); assert.equal(checks.accepted, true);
});
test("rooms_left=0 plus one-left badge produces reference one", () => {
  const d = fixture(); const result = offerObservation(d.booking!.offers[0], true);
  assert.equal(result.quantity, 1); assert.equal(result.price, 2400);
});
test("zero alone stays unknown, not sold out", () => {
  const result = offerObservation(fixture("unknown").booking!.offers[0], true);
  assert.equal(result.quantity, undefined); assert.notEqual(result.status, "sold_out");
});
test("rate plans share a room key without summing quantities", () => {
  const offers = fixture().booking!.offers; assert.equal(offers[0].roomKey, offers[1].roomKey);
  assert.equal(new Set(offers.map(o => o.roomKey)).size, 3);
  assert.equal(offerObservation(offers[1], true).quantity, undefined);
});
test("webpage cap nine is not exact inventory", () => {
  const result = offerObservation(fixture().booking!.offers[3], true);
  assert.equal(result.status, "available_capped"); assert.equal(result.quantity, undefined);
});
test("date mismatch quarantines price and quantity", () => {
  const d = fixture("date_mismatch"); const c = checkBooking(d); assert.equal(c.dates, "fail");
  const result = offerObservation(d.booking!.offers[0], c.accepted);
  assert.equal(result.price, undefined); assert.equal(result.quantity, undefined);
});
test("conflicting property house number blocks observations", () => {
  const c = checkBooking(fixture("identity_mismatch")); assert.equal(c.identity, "fail"); assert.equal(c.accepted, false);
});
test("an empty availability array is not automatic sold-out", () => {
  const d = fixture("empty"); assert.equal(d.booking!.soldOut, false); assert.equal(d.booking!.offers.length, 0);
  assert.match(checkBooking(d).messages.join(""), /未知/);
});
test("input or URL dates cannot replace missing returned dates", () => {
  const raw = payload(); delete raw.check_in; delete raw.check_out;
  raw.input = { check_in: "2026-09-28", check_out: "2026-09-29" };
  raw.url += "?checkin=2026-09-28&checkout=2026-09-29";
  const d = fixture(); d.booking = parseBookingImport(JSON.stringify(raw));
  assert.equal(checkBooking(d).dates, "unknown");
});
test("correct check-in plus explicit nights can confirm dates", () => {
  const raw = payload(); delete raw.check_out; raw.price = { nights: 1 };
  const d = fixture(); d.booking = parseBookingImport(JSON.stringify(raw)); assert.equal(checkBooking(d).dates, "pass");
});
test("every returned rate-plan nights value must match", () => {
  const raw = payload(); raw.availability[1].price = { nights: 2 };
  const d = fixture(); d.booking = parseBookingImport(JSON.stringify(raw)); assert.equal(checkBooking(d).dates, "fail");
});
test("changed adult count invalidates comparison instead of relabeling data", () => {
  const d = fixture(); d.adults = 3; assert.equal(checkBooking(d).context, "fail");
});
test("missing occupancy is unknown, not copied from requested values", () => {
  const raw = payload(); delete raw.adults; const d = fixture(); d.booking = parseBookingImport(JSON.stringify(raw));
  assert.equal(checkBooking(d).context, "unknown"); assert.equal(checkBooking(d).accepted, false);
});
test("different Booking slug cannot masquerade as requested property", () => {
  const d = fixture(); d.booking!.url = "https://www.booking.com/hotel/tw/another-property.html";
  assert.equal(checkBooking(d).identity, "fail");
});
test("non-TWD prices are withheld rather than converted or mislabeled", () => {
  const offer = fixture().booking!.offers[0]; offer.currency = "USD";
  const result = offerObservation(offer, true); assert.equal(result.price, undefined); assert.equal(result.quantity, undefined);
});
test("explicit soldout conflicting with bookable price remains unknown", () => {
  const offer = fixture().booking!.offers[0]; offer.soldOut = true;
  assert.equal(offerObservation(offer, true).status, "conflicting_evidence");
});
test("invalid JSON, multiple properties and absent offers fail explicitly", () => {
  assert.throws(() => parseBookingImport("{")); assert.throws(() => parseBookingImport(JSON.stringify([payload(), payload()])));
  assert.throws(() => parseBookingImport('{"name":"hotel"}'));
});
test("link rendering rejects executable and credential-bearing URLs", () => {
  assert.equal(safeLink("javascript:alert(1)"), undefined); assert.equal(safeLink("https://secret:token@example.com"), undefined);
});
test("date-only validation rejects calendar rollover", () => {
  assert.equal(validDate("2026-02-30"), false); assert.equal(addDays("2026-09-30", 1), "2026-10-01");
});
test("draft save restore preserves edited rooms and choices", () => {
  const d = fixture(); d.analysis.canonicalRooms[0].name = "101 修改後的河景雙人房"; d.mappings["101"] = "sample-101";
  const restored = parseDraft(JSON.stringify(d)); assert.equal(restored.analysis.canonicalRooms[0].name, d.analysis.canonicalRooms[0].name); assert.equal(restored.mappings["101"], "sample-101");
});
test("draft validation rejects duplicate room numbers and fractional capacity", () => {
  const d = fixture(); d.analysis.canonicalRooms[1].roomNumber = "101"; assert.match(validateDraft(d)!, /重複/);
  d.analysis.canonicalRooms[1].roomNumber = "201"; d.analysis.canonicalRooms[0].capacity = 1.5; assert.match(validateDraft(d)!, /整數/);
});
test("malformed stored draft cannot crash the renderer", () => {
  assert.throws(() => parseDraft("null")); assert.throws(() => parseDraft('{"schemaVersion":1}'));
  const d = fixture(); (d.analysis.canonicalRooms[0] as unknown as Record<string, unknown>).features = null; assert.throws(() => parseDraft(JSON.stringify(d)));
});
test("room suggestions honor structured capacity conflicts", () => {
  const d = fixture(); const candidates = roomCandidates(d.booking!.offers[0], d.analysis.canonicalRooms);
  assert.equal(candidates.find(c => c.id === "sample-301")!.score, 0);
});
test("omitted village and hyphenated house number still match", () => {
  const result = compareTaiwanAddresses("新北市瑞芳區東和里中山路24-1號", "新北市瑞芳區中山路24之1號");
  assert.equal(result.conflicts.length, 0); assert.ok(result.score >= 0.88);
});
test("name alone never confirms identity", () => {
  assert.notEqual(scorePropertyIdentity({ name: "範例民宿" }, { name: "範例民宿" }).status, "confirmed");
});
