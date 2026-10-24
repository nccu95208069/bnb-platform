import { signCurrentIronGateMembership } from "./iron-gate-proof.server.ts";
import type { CustomerStore } from "./store.ts";

type ReadGrant = {
  credentialId: string;
  clientId: string;
  workspaceId: string;
  propertyId: string;
  origin: "os";
  token: string;
};

export type IronGateReadConfig = {
  baseUrl: string;
  proofSecret: string;
  grants: ReadGrant[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RESPONSE_FIELDS = new Set(["id", "workspaceId", "propertyId", "version", "status",
  "channelSyncState", "stays", "createdAt", "source", "guestName", "contact", "notes",
  "totalCents", "currency", "paymentSummary", "hold", "lineChannelPending"]);
const HOLD_FIELDS = new Set(["schema", "scope", "startedAt", "expiresAt", "state",
  "convertedAt", "releasedAt", "latePaymentReview"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeBookingShape(booking: Record<string, unknown>, canReadMoney: boolean): boolean {
  if (!Number.isSafeInteger(booking.version) || Number(booking.version) < 1 ||
    !["held", "confirmed", "cancelled"].includes(String(booking.status)) ||
    !["not_required", "action_required", "pending", "verified", "review_required"]
      .includes(String(booking.channelSyncState)) ||
    !["os", "line", "website", "external"].includes(String(booking.source)) ||
    typeof booking.createdAt !== "string" || !INSTANT.test(booking.createdAt) ||
    !Array.isArray(booking.stays) || booking.stays.length > 32) return false;
  for (const [field, max] of [["guestName", 200], ["contact", 256], ["notes", 2048]] as const) {
    if (field in booking && booking[field] !== null &&
      (typeof booking[field] !== "string" || booking[field].length > max)) return false;
  }
  if ("totalCents" in booking && booking.totalCents !== null &&
    (!Number.isSafeInteger(booking.totalCents) || Number(booking.totalCents) < 0)) return false;
  if ("currency" in booking && booking.currency !== "TWD") return false;
  if ("lineChannelPending" in booking && (!Array.isArray(booking.lineChannelPending) ||
    booking.lineChannelPending.length > 4096 || booking.lineChannelPending.some((cell) =>
      !object(cell) || Object.keys(cell).sort().join(",") !== "date,desired,roomId" ||
      !UUID.test(String(cell.roomId)) || typeof cell.date !== "string" ||
      !DATE.test(cell.date) || !["open", "closed"].includes(String(cell.desired)))))
    return false;
  for (const stay of booking.stays) {
    if (!object(stay) || Object.keys(stay).some((key) => !["checkIn", "checkOut", "roomIds"].includes(key)) ||
      typeof stay.checkIn !== "string" || !DATE.test(stay.checkIn) ||
      typeof stay.checkOut !== "string" || !DATE.test(stay.checkOut) ||
      !Array.isArray(stay.roomIds) || stay.roomIds.length > 32 ||
      stay.roomIds.some((roomId) => typeof roomId !== "string" || !UUID.test(roomId))) return false;
  }
  if ("paymentSummary" in booking) {
    const summary = booking.paymentSummary;
    if (!object(summary) || Object.keys(summary).some((key) =>
      !["receivedCents", "refundedCents", "netReceivedCents"].includes(key)) ||
      ["receivedCents", "refundedCents", "netReceivedCents"].some((key) =>
        !Number.isSafeInteger(summary[key]) || Number(summary[key]) < 0)) return false;
  }
  if ("hold" in booking) {
    const hold = booking.hold;
    if (!object(hold) || Object.keys(hold).some((key) => !HOLD_FIELDS.has(key)) ||
      hold.schema !== 1 || hold.scope !== "platform_only" ||
      !["active", "awaiting_owner", "converted", "released"].includes(String(hold.state)) ||
      typeof hold.startedAt !== "string" || !INSTANT.test(hold.startedAt) ||
      typeof hold.expiresAt !== "string" || !INSTANT.test(hold.expiresAt) ||
      ["convertedAt", "releasedAt"].some((key) => key in hold &&
        (typeof hold[key] !== "string" || !INSTANT.test(hold[key]))) ||
      "latePaymentReview" in hold && typeof hold.latePaymentReview !== "boolean" ||
      !canReadMoney && ("latePaymentReview" in hold || "convertedAt" in hold)) return false;
  }
  return true;
}

function configuredBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1"))
    throw new Error("IRON_GATE_READ_CONFIG_INVALID");
  return url.origin;
}

/** Parse only server-side configuration. No URL, credential, or grant comes from a browser request. */
export function ironGateReadConfig(env: NodeJS.ProcessEnv = process.env): IronGateReadConfig {
  try {
    if (env.IRON_GATE_SHADOW_ENABLED !== "true") throw new Error();
    const baseUrl = configuredBaseUrl(env.IRON_GATE_BASE_URL ?? "");
    const proofSecret = env.IRON_GATE_OS_PROOF_SECRET ?? "";
    const grants = JSON.parse(env.IRON_GATE_OS_READ_GRANTS ?? "null") as unknown;
    if (Buffer.byteLength(proofSecret, "utf8") < 32 || !Array.isArray(grants) || grants.length < 1 ||
      grants.length > 1000) throw new Error();
    const seen = new Set<string>();
    for (const item of grants) {
      if (!item || typeof item !== "object") throw new Error();
      const grant = item as Record<string, unknown>;
      if (Object.keys(grant).some((key) => !["credentialId", "clientId", "workspaceId",
        "propertyId", "origin", "token"].includes(key)) ||
        !UUID.test(String(grant.credentialId)) || !UUID.test(String(grant.workspaceId)) ||
        !UUID.test(String(grant.propertyId)) || grant.origin !== "os" ||
        typeof grant.clientId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(grant.clientId) ||
        typeof grant.token !== "string" || !TOKEN.test(grant.token)) throw new Error();
      const key = String(grant.propertyId);
      if (seen.has(key)) throw new Error();
      seen.add(key);
    }
    return { baseUrl, proofSecret, grants: grants as ReadGrant[] };
  } catch { throw new Error("IRON_GATE_READ_CONFIG_INVALID"); }
}

/**
 * An authenticated OS server may read one booking through Iron Gate. The
 * current workspace membership is reloaded and signed for this exact GET.
 */
export async function readIronGateBooking(
  store: CustomerStore, accountId: string, slug: string,
  propertyId: string, bookingId: string, config: IronGateReadConfig,
  send: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (!UUID.test(propertyId) || !UUID.test(bookingId)) throw new Error("INVALID_INPUT");
  const baseUrl = configuredBaseUrl(config.baseUrl);
  const grant = config.grants.find((item) => item.propertyId === propertyId);
  if (!grant) throw new Error("NOT_FOUND");
  const url = `${baseUrl}/v1/properties/${propertyId}/bookings/${bookingId}`;
  const unsigned = new Request(url, { method: "GET" });
  const proof = await signCurrentIronGateMembership(store, accountId, slug, unsigned,
    grant, config.proofSecret);
  const claims = JSON.parse(Buffer.from(proof.split(".")[0], "base64url").toString("utf8")) as {
    fields: string[]; workspaceId: string;
  };
  let response: Response;
  try {
    response = await send(url, { method: "GET", headers: {
      authorization: `Bearer ${grant.token}`, "x-iron-gate-os-proof": proof,
    }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) });
  } catch { throw new Error("IRON_GATE_READ_FAILED"); }
  if (response.status === 404) throw new Error("NOT_FOUND");
  if (!response.ok) throw new Error("IRON_GATE_READ_FAILED");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(declared) || declared > 64 * 1024) throw new Error("IRON_GATE_READ_FAILED");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("IRON_GATE_READ_FAILED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw new Error("IRON_GATE_READ_FAILED");
      }
      chunks.push(value);
    }
  } catch { throw new Error("IRON_GATE_READ_FAILED"); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("IRON_GATE_READ_FAILED"); }
  if (!raw || Array.isArray(raw) || typeof raw !== "object") throw new Error("IRON_GATE_READ_FAILED");
  const booking = raw as Record<string, unknown>;
  if (booking.id !== bookingId || booking.propertyId !== propertyId ||
    booking.workspaceId !== claims.workspaceId ||
    Object.keys(booking).some((key) => !RESPONSE_FIELDS.has(key)) ||
    !claims.fields.includes("guest_name") && "guestName" in booking ||
    !claims.fields.includes("contact") && "contact" in booking ||
    !claims.fields.includes("notes") && "notes" in booking ||
    !claims.fields.includes("money") &&
      ["totalCents", "currency", "paymentSummary"].some((key) => key in booking) ||
    !safeBookingShape(booking, claims.fields.includes("money")))
    throw new Error("IRON_GATE_READ_FAILED");
  return booking;
}

export type IronGateRoomActionRow = {
  id: string;
  status: "held" | "confirmed" | "cancelled";
  channelSyncState: "not_required" | "action_required" | "pending" | "verified" | "review_required";
  guestName: string | null;
  createdAt: string;
  stays: { checkIn: string; checkOut: string; roomIds: string[] }[];
  pendingClose: number;
  pendingOpen: number;
};

/** One bounded, membership-scoped page for the read-only room action and cancelled view. */
export async function listIronGateRoomActions(
  store: CustomerStore, accountId: string, slug: string, propertyId: string,
  cursor: string | null, config: IronGateReadConfig, send: typeof fetch = fetch,
): Promise<{ rows: IronGateRoomActionRow[]; nextCursor: string | null }> {
  if (!UUID.test(propertyId) || cursor !== null && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor))
    throw new Error("INVALID_INPUT");
  const grant = config.grants.find((item) => item.propertyId === propertyId);
  if (!grant) throw new Error("NOT_FOUND");
  const url = new URL(`${configuredBaseUrl(config.baseUrl)}/v1/properties/${propertyId}/bookings`);
  url.searchParams.set("limit", "50");
  url.searchParams.set("attention", "true");
  if (cursor) url.searchParams.set("cursor", cursor);
  const proof = await signCurrentIronGateMembership(store, accountId, slug,
    new Request(url, { method: "GET" }), grant, config.proofSecret);
  const claims = JSON.parse(Buffer.from(proof.split(".")[0], "base64url").toString("utf8")) as {
    fields: string[];
  };
  let response: Response;
  try {
    response = await send(url.toString(), { method: "GET", headers: {
      authorization: `Bearer ${grant.token}`, "x-iron-gate-os-proof": proof,
    }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) });
  } catch { throw new Error("IRON_GATE_READ_FAILED"); }
  if (!response.ok) throw new Error("IRON_GATE_READ_FAILED");
  const length = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(length) || length > 512 * 1024) throw new Error("IRON_GATE_READ_FAILED");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("IRON_GATE_READ_FAILED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) { await reader.cancel(); throw new Error("IRON_GATE_READ_FAILED"); }
      chunks.push(value);
    }
  } catch { throw new Error("IRON_GATE_READ_FAILED"); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("IRON_GATE_READ_FAILED"); }
  if (!object(raw) || raw.propertyId !== propertyId || !Array.isArray(raw.bookings) ||
    raw.bookings.length > 50 || !(raw.nextCursor === null || typeof raw.nextCursor === "string" &&
    /^[A-Za-z0-9_-]{1,512}$/.test(raw.nextCursor))) throw new Error("IRON_GATE_READ_FAILED");
  const rows: IronGateRoomActionRow[] = [];
  for (const value of raw.bookings) {
    if (!object(value) || typeof value.id !== "string" || !UUID.test(value.id) ||
      value.propertyId !== propertyId || value.workspaceId !== grant.workspaceId ||
      !claims.fields.includes("guest_name") && "guestName" in value ||
      !claims.fields.includes("contact") && "contact" in value ||
      !claims.fields.includes("notes") && "notes" in value ||
      !claims.fields.includes("money") &&
        ["totalCents", "currency", "paymentSummary"].some((key) => key in value) ||
      !safeBookingShape(value, claims.fields.includes("money")))
      throw new Error("IRON_GATE_READ_FAILED");
    if (value.status !== "cancelled" && !["action_required", "pending", "review_required"]
      .includes(String(value.channelSyncState))) continue;
    const cells = (value.lineChannelPending ?? []) as { desired: "open" | "closed" }[];
    rows.push({ id: value.id, status: value.status as IronGateRoomActionRow["status"],
      channelSyncState: value.channelSyncState as IronGateRoomActionRow["channelSyncState"],
      guestName: typeof value.guestName === "string" ? value.guestName : null,
      createdAt: value.createdAt as string,
      stays: value.stays as IronGateRoomActionRow["stays"],
      pendingClose: cells.filter((cell) => cell.desired === "closed").length,
      pendingOpen: cells.filter((cell) => cell.desired === "open").length });
  }
  return { rows, nextCursor: raw.nextCursor as string | null };
}

/** Read-only shadow tag projection. No tag writer or catalog writer is exposed by OS. */
export async function readIronGateTags(
  store: CustomerStore, accountId: string, slug: string,
  propertyId: string, bookingId: string, config: IronGateReadConfig,
  send: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (!UUID.test(propertyId) || !UUID.test(bookingId)) throw new Error("INVALID_INPUT");
  const baseUrl = configuredBaseUrl(config.baseUrl);
  const grant = config.grants.find((item) => item.propertyId === propertyId);
  if (!grant) throw new Error("NOT_FOUND");
  const url = `${baseUrl}/v1/properties/${propertyId}/bookings/${bookingId}/tags`;
  const proof = await signCurrentIronGateMembership(store, accountId, slug,
    new Request(url, { method: "GET" }), grant, config.proofSecret);
  let response: Response;
  try {
    response = await send(url, { method: "GET", headers: {
      authorization: `Bearer ${grant.token}`, "x-iron-gate-os-proof": proof,
    }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) });
  } catch { throw new Error("IRON_GATE_READ_FAILED"); }
  if (response.status === 404) throw new Error("NOT_FOUND");
  if (!response.ok) throw new Error("IRON_GATE_READ_FAILED");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > 64 * 1024)
    throw new Error("IRON_GATE_READ_FAILED");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("IRON_GATE_READ_FAILED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw new Error("IRON_GATE_READ_FAILED");
      }
      chunks.push(value);
    }
  } catch { throw new Error("IRON_GATE_READ_FAILED"); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("IRON_GATE_READ_FAILED"); }
  if (!object(raw) || Object.keys(raw).some((field) =>
    !["bookingId", "workspaceId", "propertyId", "bookingVersion", "inventoryVersion", "tagCatalogVersion", "tagIds", "tags"].includes(field)) ||
    raw.bookingId !== bookingId || raw.workspaceId !== grant.workspaceId ||
    raw.propertyId !== propertyId ||
    !Number.isSafeInteger(raw.bookingVersion) || Number(raw.bookingVersion) < 1 ||
    !Number.isSafeInteger(raw.inventoryVersion) || Number(raw.inventoryVersion) < 0 ||
    !Number.isSafeInteger(raw.tagCatalogVersion) || Number(raw.tagCatalogVersion) < 0 ||
    !Array.isArray(raw.tagIds) || raw.tagIds.length > 30 ||
    !Array.isArray(raw.tags) || raw.tags.length !== raw.tagIds.length)
    throw new Error("IRON_GATE_READ_FAILED");
  const tagIds = raw.tagIds as unknown[];
  if (tagIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) ||
    new Set(tagIds).size !== tagIds.length ||
    (raw.tags as unknown[]).some((tag, index) => !object(tag) ||
      Object.keys(tag).sort().join(",") !== "id,name" ||
      tag.id !== tagIds[index] || typeof tag.name !== "string" ||
      !tag.name || tag.name.length > 30 || /[,，\r\n\u0000-\u001f\u007f]/u.test(tag.name)))
    throw new Error("IRON_GATE_READ_FAILED");
  return raw;
}
