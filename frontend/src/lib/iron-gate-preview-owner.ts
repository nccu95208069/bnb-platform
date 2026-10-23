import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ADMIN_EMAIL, type Principal } from "./workspace-auth/types";

export const PREVIEW_OWNER_COOKIE = "sf_ig_preview_owner";
const LIFETIME_SECONDS = 24 * 60 * 60;

export function previewOwnerConfigured(): boolean {
  return process.env.VERCEL_ENV === "preview" &&
    process.env.IRON_GATE_SWEETFUN_CALENDAR_PREVIEW_ENABLED === "true" &&
    process.env.IRON_GATE_PREVIEW_OWNER_ONLY === "true" &&
    /^[a-f0-9]{64}$/.test(process.env.IRON_GATE_PREVIEW_OWNER_CODE_HASH ?? "") &&
    /^[a-f0-9]{64}$/.test(process.env.IRON_GATE_PREVIEW_OWNER_SESSION_SECRET ?? "");
}

function sign(payload: string): Buffer {
  return createHmac("sha256", process.env.IRON_GATE_PREVIEW_OWNER_SESSION_SECRET!)
    .update(payload).digest();
}

export function previewOwnerCodeMatches(email: unknown, code: unknown): boolean {
  if (!previewOwnerConfigured() || email !== ADMIN_EMAIL || typeof code !== "string" ||
    !/^[A-Za-z0-9_-]{32}$/.test(code)) return false;
  const actual = createHash("sha256").update(code).digest();
  const expected = Buffer.from(process.env.IRON_GATE_PREVIEW_OWNER_CODE_HASH!, "hex");
  return timingSafeEqual(actual, expected);
}

export function createPreviewOwnerSession(now = Date.now()): string {
  if (!previewOwnerConfigured()) throw Error("PREVIEW_OWNER_UNAVAILABLE");
  const payload = `igpreview.${Math.floor(now / 1000) + LIFETIME_SECONDS}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${sign(payload).toString("base64url")}`;
}

export function validPreviewOwnerSession(cookie: string | undefined, now = Date.now()): boolean {
  if (!previewOwnerConfigured() || !cookie || cookie.length > 256) return false;
  const parts = /^igpreview\.(\d{10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(cookie);
  if (!parts) return false;
  const seconds = Math.floor(now / 1000), expiry = Number(parts[1]);
  if (expiry <= seconds || expiry > seconds + LIFETIME_SECONDS) return false;
  const actual = Buffer.from(parts[3], "base64url"), expected = sign(`igpreview.${parts[1]}.${parts[2]}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function previewOwnerPrincipal(): Principal {
  return { id: "calendar-owner", displayName: "擁有者（固定快照預覽）", email: ADMIN_EMAIL,
    role: "viewer_no_price", allProperties: false, propertyIds: ["sweetfun"], viewPrices: false };
}

export const previewOwnerSessionSeconds = LIFETIME_SECONDS;
