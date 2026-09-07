import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OWNER_COOKIE = "sf_calendar_owner";
export const OWNER_SESSION_SECONDS = 30 * 24 * 60 * 60;
const validKey = (value: string | undefined): value is string => Boolean(value && /^[a-f0-9]{64}$/.test(value));
export function ownerAccessConfigured(): boolean {
  return validKey(process.env.CALENDAR_OWNER_CODE_HASH) && validKey(process.env.CALENDAR_OWNER_SESSION_SECRET);
}
export function validOwnerCode(code: unknown): boolean {
  if (!ownerAccessConfigured() || typeof code !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(code)) return false;
  return timingSafeEqual(createHash("sha256").update(code).digest(), Buffer.from(process.env.CALENDAR_OWNER_CODE_HASH!, "hex"));
}
function sign(payload: string, binding: string): string {
  return createHmac("sha256", `${process.env.CALENDAR_OWNER_SESSION_SECRET}:${binding}`).update(payload).digest("base64url");
}
export function createOwnerSession(now = Date.now(), binding = process.env.CALENDAR_OWNER_CODE_HASH!): string {
  if (!ownerAccessConfigured()) throw new Error("OWNER_ACCESS_UNAVAILABLE");
  const payload = `owner.${Math.floor(now / 1000) + OWNER_SESSION_SECONDS}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${sign(payload, binding)}`;
}
export function validOwnerSession(cookie: string | undefined, now = Date.now(), binding = process.env.CALENDAR_OWNER_CODE_HASH!): boolean {
  if (!ownerAccessConfigured() || !cookie || cookie.length > 256) return false;
  const parts = cookie.split(".");
  if (parts.length !== 4 || parts[0] !== "owner" || !/^\d{10}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{22}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3])) return false;
  const expiry = Number(parts[1]), seconds = Math.floor(now / 1000);
  if (expiry <= seconds || expiry > seconds + OWNER_SESSION_SECONDS) return false;
  const expected = Buffer.from(sign(parts.slice(0, 3).join("."), binding));
  return timingSafeEqual(expected, Buffer.from(parts[3]));
}
