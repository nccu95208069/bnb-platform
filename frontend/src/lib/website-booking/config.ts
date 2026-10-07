import { createHmac, timingSafeEqual } from "node:crypto";
import { digest } from "../customer-workspaces/auth.ts";
import { dateValue, textValue } from "../customer-workspaces/service.ts";
import { businessDate } from "../customer-workspaces/domain.ts";
import { normalizedEmail, validEmail } from "../workspace-auth/types.ts";
import type { RoomRecord, Stay, WebsiteBinding, WebsiteClient, WebsiteConfig } from "./types.ts";

export const uuid = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw Error("INVALID_INPUT");
  return value;
};
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("INVALID_INPUT");
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw Error("INVALID_INPUT");
}
export function plain(value: unknown, max: number, required = true) {
  const v = textValue(value, max, required);
  if (v && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw Error("INVALID_INPUT");
  return v;
}
export function email(value: unknown) {
  const v = normalizedEmail(value);
  if (!validEmail(v) || v.length > 160 || /[\r\n]/.test(v)) throw Error("INVALID_INPUT");
  return v;
}
export function id(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) throw Error("INVALID_INPUT");
  return value;
}
export function amount(value: unknown) {
  if (!["string", "number"].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw Error("INVALID_INPUT");
  const n = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 100_000_000) throw Error("INVALID_INPUT");
  return n;
}
export function integer(value: unknown, min: number, max: number) {
  if (!["string", "number"].includes(typeof value) || !/^\d+$/.test(String(value))) throw Error("INVALID_INPUT");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw Error("INVALID_INPUT");
  return n;
}
export function addDays(day: string, n: number) { return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10); }
export function validateConfiguration(value: unknown, rooms: unknown, expectedHash: unknown, now = new Date()) {
  const c = record(value);
  fields(c, ["schema", "kind", "sellingMode", "currency", "timezone", "holdHours", "opensOn", "closesOn", "transferInstructions", "cancellationPolicy", "availabilityConfirmed", "wholeHouseNightly", "rooms"]);
  if (c.schema !== 1 || c.kind !== "new" || !["rooms", "whole_house", "mixed"].includes(String(c.sellingMode)) ||
    c.currency !== "TWD" || c.timezone !== "Asia/Taipei" || c.holdHours !== 24 || c.availabilityConfirmed !== true) throw Error("INVALID_INPUT");
  const opens = dateValue(c.opensOn), closes = dateValue(c.closesOn);
  if (opens > closes || closes < businessDate(now.toISOString()) || Date.parse(closes) - Date.parse(opens) > 2 * 366 * 86400000) throw Error("INVALID_INPUT");
  plain(c.transferInstructions, 1600); plain(c.cancellationPolicy, 1600);
  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > 60) throw Error("INVALID_INPUT");
  const roomRecords: RoomRecord[] = rooms.map(r => {
    const v = record(r); fields(v, ["id", "name"]);
    if (v.id === "whole-house") throw Error("INVALID_INPUT");
    return { id: id(v.id), name: plain(v.name, 80)! };
  });
  if (new Set(roomRecords.map(r => r.id)).size !== roomRecords.length || !Array.isArray(c.rooms) || c.rooms.length > 60) throw Error("INVALID_INPUT");
  let physicalRooms = 0;
  const seen = new Set<string>();
  for (const r of c.rooms) {
    const v = record(r); fields(v, ["roomTypeId", "enabled", "units", "capacity", "nightly"]);
    if ([v.units, v.capacity, v.nightly].some(v => !["string", "number"].includes(typeof v) || String(v).length > 12)) throw Error("INVALID_INPUT");
    const roomId = id(v.roomTypeId);
    if (seen.has(roomId) || !roomRecords.some(r => r.id === roomId) || typeof v.enabled !== "boolean") throw Error("INVALID_INPUT");
    seen.add(roomId);
    if (v.enabled) {
      physicalRooms += integer(v.units, 1, 50); integer(v.capacity, 1, 60);
      if (c.sellingMode !== "whole_house") amount(v.nightly);
    }
  }
  if (physicalRooms < 1 || physicalRooms > 100) throw Error("INVALID_INPUT");
  if (c.sellingMode !== "rooms") amount(c.wholeHouseNightly);
  const configurationHash = digest(JSON.stringify({ reservationConfig: value, roomIds: roomRecords.map(r => r.id) }));
  if (configurationHash !== expectedHash) throw Error("CONFIGURATION_CHANGED");
  return { config: value as WebsiteConfig, roomRecords, configurationHash };
}
export function enabled() { return process.env.WEBSITE_BOOKING_ENABLED === "true" && process.env.CUSTOMER_WORKSPACES_ENABLED === "true"; }
export function requireEnabled() { if (!enabled()) throw Error("WEBSITE_BOOKING_UNAVAILABLE"); }
export function bindingToken(binding: WebsiteBinding) {
  const key = process.env.CUSTOMER_SESSION_SECRET;
  if (!key || key.length < 32) throw Error("WEBSITE_BOOKING_UNAVAILABLE");
  return createHmac("sha256", key).update(`website-booking:v1:${binding.id}:${binding.credentialGeneration}`).digest("base64url");
}
export function sameSecret(left: string, right: string) { return timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right))); }
export function serviceClient(token: string | null): WebsiteClient {
  let rows: WebsiteClient[];
  try { rows = JSON.parse(process.env.WEBSITE_BOOKING_CLIENTS || "[]"); } catch { throw Error("WEBSITE_BOOKING_UNAVAILABLE"); }
  if (!Array.isArray(rows) || rows.length > 50) throw Error("WEBSITE_BOOKING_UNAVAILABLE");
  const ids = new Set<string>(), hashes = new Set<string>();
  for (const c of rows) {
    try {
      const row = record(c); fields(row, ["id", "token_sha256", "site_ids", "editor_origin"]);
      id(c.id);
      if (ids.has(c.id) || typeof c.token_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(c.token_sha256) || hashes.has(c.token_sha256) ||
        !Array.isArray(c.site_ids) || c.site_ids.length < 1 || c.site_ids.length > 100 || new Set(c.site_ids).size !== c.site_ids.length || c.site_ids.some(s => id(s) !== s)) throw Error();
      const origin = new URL(c.editor_origin);
      if (origin.protocol !== "https:" || origin.origin !== c.editor_origin) throw Error();
      ids.add(c.id); hashes.add(c.token_sha256);
    } catch { throw Error("WEBSITE_BOOKING_UNAVAILABLE"); }
  }
  const found = rows.find(c => c && typeof c.token_sha256 === "string" && /^[a-f0-9]{64}$/.test(c.token_sha256) && token && token.length >= 32 && sameSecret(c.token_sha256, digest(token)));
  if (!found || !Array.isArray(found.site_ids) || found.site_ids.some(s => typeof s !== "string")) throw Error("UNAUTHORIZED");
  id(found.id);
  try { const origin = new URL(found.editor_origin); if (origin.protocol !== "https:" || origin.origin !== found.editor_origin) throw Error(); } catch { throw Error("WEBSITE_BOOKING_UNAVAILABLE"); }
  return found;
}
export function permittedSite(client: WebsiteClient, siteId: unknown) {
  const site = id(siteId);
  if (!client.site_ids.includes(site)) throw Error("FORBIDDEN");
  return site;
}
export function stayInput(input: Record<string, unknown>, binding: WebsiteBinding, now = new Date()): Stay {
  const checkIn = dateValue(input.checkIn), checkOut = dateValue(input.checkOut);
  if (checkIn < businessDate(now.toISOString()) || checkIn < binding.config.opensOn || checkOut <= checkIn ||
    checkOut > addDays(binding.config.closesOn, 1) || Date.parse(checkOut) - Date.parse(checkIn) > 30 * 86400000) throw Error("INVALID_INPUT");
  const offer = binding.offers.find(o => o.id === input.roomTypeId);
  if (!offer) throw Error("INVALID_INPUT");
  const quantity = integer(input.quantity, 1, offer.wholeHouse ? 1 : offer.roomIds.length);
  const adults = integer(input.adults, 1, 60), children = integer(input.children, 0, 60);
  if (adults + children > offer.capacity * quantity) throw Error("INVALID_INPUT");
  return { checkIn, checkOut, roomTypeId: offer.id, quantity, adults, children };
}
