import { scorePropertyIdentity } from "./identity";
import { scoreRoomMatch } from "./rooms";
import type { CanonicalRoomDraft, CompetitorRadarAnalysis, PropertyIdentityInput } from "./types";

export type PreviewMode = "live_website" | "synthetic";
export type Gate = "pass" | "fail" | "unknown";
export interface BookingDocument {
  source: "synthetic" | "user_import";
  name: string;
  address?: string;
  registrationNumber?: string;
  url?: string;
  checkIn?: string;
  checkOut?: string;
  nights?: number;
  adults?: number;
  children?: number;
  rooms?: number;
  currency?: string;
  soldOut: boolean;
  offers: BookingOffer[];
}
export interface BookingOffer {
  key: string;
  roomKey: string;
  name: string;
  plan: string;
  capacity?: number;
  price?: number;
  currency?: string;
  nights?: number;
  roomsLeft?: number;
  badgeQuantity?: number;
  quantityConflict?: boolean;
  soldOut: boolean;
}
export interface PreviewDraft {
  schemaVersion: 1;
  mode: PreviewMode;
  analysis: CompetitorRadarAnalysis;
  bookingUrl: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  booking?: BookingDocument;
  mappings: Record<string, string>;
  registryDecision?: { hotelId: string; action: "confirmed" | "rejected" };
  savedAt?: string;
}
export const STORAGE_KEY = "daili-radar-preview:v1";
export const MAX_IMPORT_BYTES = 1_000_000;
export const SYNTHETIC_NOTICE = "合成測試資料，不是真實旅宿、即時價格或實際庫存。";
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, max = 500): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}
function number(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function integer(value: unknown): number | undefined {
  const n = number(value);
  return n !== undefined && Number.isSafeInteger(n) ? n : undefined;
}
export function safeLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return undefined;
    return u.href;
  } catch { return undefined; }
}
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === value;
}
export function addDays(day: string, n: number): string {
  if (!validDate(day)) throw new Error("日期格式不正確。");
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function stayNights(start: string, end: string): number {
  if (!validDate(start) || !validDate(end)) return 0;
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}
export function bookingSlug(value: string | undefined): string | undefined {
  const link = safeLink(value);
  if (!link) return undefined;
  const u = new URL(link);
  if (!/(^|\.)booking\.com$/i.test(u.hostname)) return undefined;
  const m = u.pathname.match(/^\/hotel\/([a-z]{2})\/([^/]+?)\.html$/i);
  return m ? `${m[1]}/${m[2].replace(/\.[a-z]{2}(?:-[a-z]{2})?$/i, "")}`.toLowerCase() : undefined;
}
export function validateDraft(draft: PreviewDraft): string | null {
  if (!draft.analysis.property.name.trim()) return "住宿名稱不可空白。";
  if (!safeLink(draft.analysis.requestedUrl)) return "請提供有效的 HTTP/HTTPS 住宿網址。";
  const nights = stayNights(draft.checkIn, draft.checkOut);
  if (nights < 1 || nights > 30) return "請選擇 1 至 30 晚的入住區間。";
  if (!Number.isInteger(draft.adults) || draft.adults < 1 || draft.adults > 30) return "成人數需為 1 至 30 的整數。";
  if (draft.analysis.canonicalRooms.length > 100) return "測試版最多保存 100 個房型。";
  const ids = new Set<string>();
  const roomNumbers = new Set<string>();
  for (const r of draft.analysis.canonicalRooms) {
    if (!r.id || ids.has(r.id)) return "房型 ID 重複。";
    ids.add(r.id);
    if (!r.name.trim()) return "房型名稱不可空白。";
    if (r.capacity !== undefined && (!Number.isInteger(r.capacity) || r.capacity < 1 || r.capacity > 100)) return "房型人數需為 1 至 100 的整數，或留空。";
    if (r.roomNumber?.trim()) {
      const key = r.roomNumber.trim().normalize("NFKC");
      if (roomNumbers.has(key)) return `房號 ${key} 重複，請先修正。`;
      roomNumbers.add(key);
    }
  }
  return null;
}

/** Input URLs and input.check_in are never treated as observed returned dates. */
export function parseBookingImport(raw: string, source: BookingDocument["source"] = "user_import"): BookingDocument {
  if (new TextEncoder().encode(raw).length > MAX_IMPORT_BYTES) throw new Error("JSON 超過 1 MB 上限。");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("JSON 格式錯誤，請檢查括號與引號。"); }
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error("請一次匯入一間住宿的一筆結果，避免把其他住宿混入。");
    value = value[0];
  }
  const root = record(value);
  const rows = root.availability ?? root.offers;
  if (!Array.isArray(rows) || rows.length > 500) throw new Error("需要 availability 或 offers 陣列（最多 500 筆）。未知格式不會猜測解析。");
  const name = text(root.name ?? root.hotel_name ?? root.title);
  if (!name) throw new Error("缺少住宿 name / hotel_name / title。");
  const rootPrice = record(root.price);
  const currency = text(root.currency ?? rootPrice.currency, 12)?.toUpperCase();
  const offers: BookingOffer[] = rows.map((item, index) => {
    const row = record(item);
    const price = record(row.price);
    const roomName = text(row.room_name ?? row.room_type ?? row.name);
    if (!roomName) throw new Error(`第 ${index + 1} 筆缺少 room_name / room_type / name。`);
    const policies = Array.isArray(row.policies) ? row.policies.filter((p): p is string => typeof p === "string").slice(0, 30) : [];
    const quantities = policies.flatMap(p => {
      const match = p.match(/(?:we\s+have\s+(\d+)\s+left|(?:只剩|還有|仅剩)\s*(\d+)\s*間)/i);
      const n = match ? integer(match[1] ?? match[2]) : undefined;
      return n !== undefined && n > 0 ? [n] : [];
    });
    const uniqueQuantities = [...new Set(quantities)];
    const roomKey = text(row.room_id ?? row.source_room_id, 120) ?? roomName.normalize("NFKC").toLowerCase();
    if (RESERVED_KEYS.has(roomKey)) throw new Error("來源房型 ID 使用了保留字。");
    const roomsLeft = integer(row.rooms_left);
    const badgeQuantity = uniqueQuantities.length === 1 ? uniqueQuantities[0] : undefined;
    return {
      key: `offer-${index}`, roomKey, name: roomName,
      plan: text(row.rate_plan, 1000) ?? (policies.map(p => p.slice(0, 300)).join(" · ").slice(0, 1000) || "方案未提供"),
      capacity: integer(row.capacity),
      price: number(row.total_price ?? price.total ?? price.value ?? row.price),
      currency: text(row.currency ?? price.currency, 12)?.toUpperCase() ?? currency,
      nights: integer(row.nights ?? price.nights), roomsLeft, badgeQuantity,
      quantityConflict: uniqueQuantities.length > 1 || Boolean(badgeQuantity && roomsLeft && badgeQuantity !== roomsLeft),
      soldOut: row.sold_out === true || row.available === false,
    };
  });
  return {
    source: root.synthetic === true ? "synthetic" : source,
    name, address: text(root.address), registrationNumber: text(root.registration_number),
    url: safeLink(root.url), checkIn: validDate(root.check_in) ? root.check_in : undefined,
    checkOut: validDate(root.check_out) ? root.check_out : undefined,
    nights: integer(root.nights ?? rootPrice.nights),
    adults: integer(root.adults), children: integer(root.children), rooms: integer(root.rooms), currency,
    soldOut: root.sold_out === true || root.available === false, offers,
  };
}

export function checkBooking(draft: PreviewDraft) {
  const doc = draft.booking;
  const unknown = { identity: "unknown" as Gate, dates: "unknown" as Gate, context: "unknown" as Gate };
  if (!doc) return { ...unknown, accepted: false, messages: ["尚未匯入 Booking 資料。"] };
  const messages: string[] = [];
  const identityInput: PropertyIdentityInput = { name: doc.name, address: doc.address, registrationNumber: doc.registrationNumber };
  const match = scorePropertyIdentity(draft.analysis.property, identityInput);
  let identity: Gate = match.status === "confirmed" ? "pass" : match.status === "rejected" ? "fail" : "unknown";
  const expectedSlug = bookingSlug(draft.bookingUrl);
  const returnedSlug = bookingSlug(doc.url);
  if (!expectedSlug || !returnedSlug) {
    identity = identity === "fail" ? "fail" : "unknown";
    messages.push("缺少可核對的 Booking 房源網址。");
  } else if (expectedSlug !== returnedSlug) {
    identity = "fail"; messages.push("回傳 Booking 房源網址不是指定的住宿；不接受附近推薦住宿。");
  }
  if (identity !== "pass") messages.push(...match.conflicts, "住宿身分證據不足或有衝突，房價與參考數量不會採用。");
  const nights = stayNights(draft.checkIn, draft.checkOut);
  const observedNights = [doc.nights, ...doc.offers.map(o => o.nights)].filter((n): n is number => n !== undefined);
  let dates: Gate = "unknown";
  if (nights < 1 || nights > 30 || (doc.checkIn && doc.checkIn !== draft.checkIn) || (doc.checkOut && doc.checkOut !== draft.checkOut) || observedNights.some(n => n !== nights)) {
    dates = "fail";
  } else if (doc.checkIn && (doc.checkOut || (observedNights.length > 0 && observedNights.every(n => n === nights)))) {
    dates = "pass";
  }
  if (dates !== "pass") messages.push(dates === "fail" ? "回傳入住／退房日期或晚數不符；數值已隔離。" : "回傳資料缺少日期證據；不會使用輸入網址的日期補造。");
  let context: Gate = "pass";
  if (doc.adults === undefined || doc.children === undefined || doc.rooms === undefined) context = "unknown";
  if ((doc.adults !== undefined && doc.adults !== draft.adults) || (doc.children !== undefined && doc.children !== 0) || (doc.rooms !== undefined && doc.rooms !== 1)) context = "fail";
  if (context !== "pass") messages.push("回傳成人數／兒童數／房數缺漏或不符；不能確認相同比價條件。");
  if (doc.soldOut && doc.offers.some(o => !o.soldOut && (o.price || o.badgeQuantity || o.roomsLeft))) {
    context = "fail"; messages.push("住宿層級無房旗標與可訂方案互相矛盾，隔離本筆資料。");
  }
  if (!doc.offers.length) messages.push(doc.soldOut ? "來源明確標示無房；只記錄本次來源狀態，不推導成交。" : "回傳空陣列：售罄與未取得資料無法區分，維持未知。");
  return { identity, dates, context, accepted: identity === "pass" && dates === "pass" && context === "pass", messages };
}

export function offerObservation(offer: BookingOffer, accepted: boolean) {
  if (!accepted) return { status: "quarantined", label: "隔離：未通過驗證", quantity: undefined, price: undefined };
  if (offer.currency !== "TWD") return { status: "currency_unverified", label: "幣別未知或非 TWD", quantity: undefined, price: undefined };
  const price = offer.price !== undefined && offer.price > 0 ? offer.price : undefined;
  const q = offer.badgeQuantity ?? (offer.roomsLeft && offer.roomsLeft > 0 ? offer.roomsLeft : undefined);
  if (offer.soldOut && (price !== undefined || q !== undefined)) return { status: "conflicting_evidence", label: "有價／房量與售罄矛盾", quantity: undefined, price: undefined };
  if (offer.quantityConflict) return { status: "quantity_conflict", label: "數量證據矛盾，維持未知", quantity: undefined, price };
  if (offer.soldOut) return { status: "sold_out", label: "來源明確無房", quantity: 0, price: undefined };
  if (q !== undefined && q >= 9) return { status: "available_capped", label: "達介面上限，實際量未知", quantity: undefined, price };
  if (q !== undefined) return { status: "available_exact", label: "來源顯示參考數量", quantity: q, price };
  return { status: "available_quantity_unknown", label: "參考數量未知（0 不代表售罄）", quantity: undefined, price };
}

export function roomCandidates(room: BookingOffer, rooms: CanonicalRoomDraft[]) {
  return rooms.map(canonical => {
    const scored = scoreRoomMatch(room.name, canonical.name);
    if (room.capacity && canonical.capacity && room.capacity !== canonical.capacity) {
      scored.conflicts.push("結構化入住人數不同"); scored.score = 0;
    }
    return { ...scored, id: canonical.id, name: canonical.name };
  }).sort((a, b) => b.score - a.score);
}

export function syntheticDraft(): PreviewDraft {
  const now = new Date().toISOString(); const start = "2026-09-28";
  return {
    schemaVersion: 1, mode: "synthetic", bookingUrl: "https://www.booking.com/hotel/tw/radar-synthetic-example.html",
    checkIn: start, checkOut: addDays(start, 1), adults: 2, mappings: {},
    analysis: {
      analysisId: "synthetic-example", analyzedAt: now, requestedUrl: "https://example.com", finalUrl: "https://example.com",
      property: { name: "範例河岸旅宿", sourceUrl: "https://example.com", websiteHost: "example.com", address: "新北市瑞芳區範例路1號", identityStatus: "review", confidence: 0 },
      identityEvidence: [], platformSources: [], warnings: [SYNTHETIC_NOTICE],
      canonicalRooms: [
        { id: "sample-101", name: "101 河景雙人房", roomNumber: "101", capacity: 2, sourceName: "合成範例", features: ["river_view"], bundle: false, origin: "manual", editable: true },
        { id: "sample-201", name: "201 無窗雙人房", roomNumber: "201", capacity: 2, sourceName: "合成範例", features: ["no_window"], bundle: false, origin: "manual", editable: true },
        { id: "sample-301", name: "301 河景四人房", roomNumber: "301", capacity: 4, sourceName: "合成範例", features: ["river_view"], bundle: false, origin: "manual", editable: true },
      ], dateWindow: { start, end: addDays(start, 13), days: 14 },
    },
  };
}
export type Scenario = "normal" | "unknown" | "date_mismatch" | "identity_mismatch" | "empty";
export function scenarioJson(scenario: Scenario): string {
  const d = syntheticDraft();
  return JSON.stringify({
    name: d.analysis.property.name, address: scenario === "identity_mismatch" ? "新北市瑞芳區範例路99號" : d.analysis.property.address,
    url: d.bookingUrl, check_in: scenario === "date_mismatch" ? "2026-09-29" : d.checkIn, check_out: d.checkOut,
    adults: 2, children: 0, rooms: 1, currency: "TWD", synthetic: true,
    availability: scenario === "empty" ? [] : [
      { room_id: "101", room_name: "101 河景雙人房", capacity: 2, total_price: 2400, rooms_left: 0, policies: scenario === "unknown" ? [] : ["We have 1 left", "不可退款"] },
      { room_id: "101", room_name: "101 河景雙人房", capacity: 2, total_price: 2700, rooms_left: 0, policies: ["可取消方案"] },
      { room_id: "201", room_name: "201 無窗雙人房", capacity: 2, total_price: 1900, rooms_left: 2, policies: ["不含早餐"] },
      { room_id: "301", room_name: "301 河景四人房", capacity: 4, total_price: 3900, rooms_left: 9, policies: [] },
    ],
  }, null, 2);
}

function expect(ok: boolean): asserts ok { if (!ok) throw new Error("草稿格式無效，請重新匯出有效的 v1 草稿。"); }
function strings(value: unknown, limit = 100): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every(v => typeof v === "string" && v.length <= 5000);
}
function optionalStrings(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) expect(value[key] === undefined || (typeof value[key] === "string" && (value[key] as string).length <= 5000));
}
function optionalNumbers(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) expect(value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key])));
}
function evidence(value: unknown) {
  expect(Array.isArray(value) && value.length <= 100);
  for (const item of value as unknown[]) {
    const e = record(item);
    expect(Boolean(text(e.label)) && Boolean(text(e.detail)) && typeof e.field === "string" && typeof e.strength === "string" && typeof e.score === "number" && Number.isFinite(e.score));
  }
}

/** Validate nested user-controlled values before they reach React or matching code. */
export function parseDraft(raw: string): PreviewDraft {
  if (new TextEncoder().encode(raw).length > MAX_IMPORT_BYTES) throw new Error("草稿過大。");
  const d = record(JSON.parse(raw)); const a = record(d.analysis); const p = record(a.property);
  expect(d.schemaVersion === 1 && (d.mode === "live_website" || d.mode === "synthetic"));
  expect(Boolean(text(p.name)) && Boolean(safeLink(a.requestedUrl)) && Boolean(safeLink(a.finalUrl)) && Boolean(text(p.websiteHost)));
  expect(typeof d.bookingUrl === "string" && d.bookingUrl.length <= 2048 && typeof d.adults === "number");
  expect(validDate(d.checkIn) && validDate(d.checkOut));
  optionalStrings(p, ["sourceUrl", "description", "address", "normalizedAddress", "phone", "registrationNumber"]);
  optionalNumbers(p, ["latitude", "longitude", "confidence"]);
  expect(["confirmed", "review", "rejected"].includes(String(p.identityStatus)));
  expect(Boolean(text(a.analysisId)) && Boolean(text(a.analyzedAt)) && strings(a.warnings));
  evidence(a.identityEvidence);
  expect(Array.isArray(a.platformSources) && a.platformSources.length <= 30);
  for (const source of a.platformSources as unknown[]) {
    const s = record(source); optionalStrings(s, ["sourceUrl", "matchedName"]);
    expect(["official", "booking", "agoda", "trip"].includes(String(s.platform)) && typeof s.label === "string" && typeof s.message === "string");
    evidence(s.identityEvidence); expect(Array.isArray(s.rooms));
  }
  expect(Array.isArray(a.canonicalRooms) && a.canonicalRooms.length <= 100);
  for (const item of a.canonicalRooms as unknown[]) {
    const r = record(item);
    expect(Boolean(text(r.id)) && Boolean(text(r.name)) && Boolean(text(r.sourceName)) && strings(r.features) && typeof r.bundle === "boolean");
    expect(["website_jsonld", "website_listing", "website_detail", "golden_fixture", "manual"].includes(String(r.origin)));
    optionalStrings(r, ["sourceUrl", "roomNumber"]); optionalNumbers(r, ["capacity"]);
  }
  const window = record(a.dateWindow);
  expect(validDate(window.start) && validDate(window.end) && typeof window.days === "number" && Number.isInteger(window.days) && window.days > 0 && window.days <= 365);
  if (a.tourismRegistry !== undefined) {
    const g = record(a.tourismRegistry);
    expect(typeof g.message === "string" && Array.isArray(g.candidates) && g.candidates.length <= 30);
    expect(["matched", "review", "not_found", "unavailable"].includes(String(g.status)));
    optionalStrings(g, ["sourceUrl", "selectedHotelId"]);
    for (const item of g.candidates as unknown[]) {
      const c = record(item);
      expect(Boolean(text(c.hotelId)) && Boolean(text(c.name)) && typeof c.score === "number" && Number.isFinite(c.score) && strings(c.conflicts));
      expect(["confirmed", "review", "rejected"].includes(String(c.status))); evidence(c.evidence);
      optionalStrings(c, ["address", "registrationNumber", "phone", "websiteUrl", "matchedName", "updateTime"]);
      optionalNumbers(c, ["totalRooms", "lowestPrice", "ceilingPrice", "latitude", "longitude"]);
    }
  }
  if (d.registryDecision !== undefined) {
    const decision = record(d.registryDecision);
    expect(Boolean(text(decision.hotelId)) && ["confirmed", "rejected"].includes(String(decision.action)));
  }
  optionalStrings(d, ["savedAt"]);
  if (d.booking !== undefined) {
    const b = record(d.booking);
    expect(Boolean(text(b.name)) && ["synthetic", "user_import"].includes(String(b.source)) && Array.isArray(b.offers) && b.offers.length <= 500 && typeof b.soldOut === "boolean");
    optionalStrings(b, ["address", "registrationNumber", "url", "currency"]);
    for (const key of ["checkIn", "checkOut"]) expect(b[key] === undefined || validDate(b[key]));
    for (const key of ["nights", "adults", "children", "rooms"]) expect(b[key] === undefined || (typeof b[key] === "number" && integer(b[key]) !== undefined));
    const keys = new Set<string>();
    for (const item of b.offers as unknown[]) {
      const o = record(item);
      expect(Boolean(text(o.key)) && Boolean(text(o.roomKey)) && Boolean(text(o.name)) && Boolean(text(o.plan)) && typeof o.soldOut === "boolean");
      expect(!keys.has(String(o.key)) && !RESERVED_KEYS.has(String(o.roomKey))); keys.add(String(o.key));
      optionalStrings(o, ["currency"]);
      for (const key of ["capacity", "nights", "roomsLeft", "badgeQuantity"]) expect(o[key] === undefined || (typeof o[key] === "number" && integer(o[key]) !== undefined));
      expect(o.price === undefined || (typeof o.price === "number" && number(o.price) !== undefined));
      expect(o.quantityConflict === undefined || typeof o.quantityConflict === "boolean");
    }
  }
  const draft = d as unknown as PreviewDraft;
  const sourceKeys = new Set(draft.booking?.offers.map(o => o.roomKey) ?? []);
  const roomIds = new Set(draft.analysis.canonicalRooms.map(r => r.id));
  draft.mappings = Object.fromEntries(Object.entries(record(d.mappings)).filter((entry): entry is [string, string] => !RESERVED_KEYS.has(entry[0]) && sourceKeys.has(entry[0]) && typeof entry[1] === "string" && roomIds.has(entry[1])));
  const error = validateDraft(draft); if (error) throw new Error(error);
  return draft;
}
