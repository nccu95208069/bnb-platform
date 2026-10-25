import type {
  Action, AmendBookingInput, Booking, BookingReceipt, CreateBookingInput, CreateHoldInput,
  ExtendHoldInput, LineInventoryInput, LineInventoryBatchInput, LineBulkCancelInput,
  LineChannelActionInput,
  DesiredCell, Night, NightPrice, PaymentEventInput, Principal, PropertyRepository, PropertyState,
  ReadbackInput, RequestReceipt, SourceEventInput, SourceFactsInput, SourceOrderLookupInput, Stay,
  TransactionContext, EventType,
} from "./types.ts";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { GateError } from "./errors.ts";
import { createBusinessReport, type BusinessReport } from "./business-report.ts";
import { firstGmailNotification, GMAIL_NOTIFICATION_SOURCE,
  GMAIL_NOTIFICATION_SUBJECT } from "./source-notification.ts";
import { isOsDirectBooking, originalDirectOrderRef } from "./os-direct-booking.ts";
export { GateError } from "./errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const MAX_NIGHTS = 366;
const MAX_READ_DAYS = 31;
const MAX_CALENDAR_DAYS = 410;
const LINE_PREVIEW_LIFETIME_MS = 15 * 60_000;
const LINE_PREVIEW_SECRET = /^[A-Za-z0-9_-]{43}$/;

function reject(code: string, status = 400): never { throw new GateError(code, status); }
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) reject("INVALID_ID");
  return value;
}
function nonempty(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value || value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)) reject("INVALID_INPUT");
  return value;
}
function nullableText(value: unknown, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) reject("INVALID_INPUT");
  return value;
}
function dayNumber(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) reject("INVALID_DATE");
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) reject("INVALID_DATE");
  return time / DAY;
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    reject("INVALID_TIMESTAMP");
  const time = Date.parse(value);
  if (!Number.isFinite(time)) reject("INVALID_TIMESTAMP");
  return time;
}
function keyOf(cell: Night): string { return `${cell.roomId}:${cell.date}`; }
// JSONB rejects the NUL code point. JSON array encoding is unambiguous for
// source components and can be stored in PostgreSQL without a delimiter byte.
function sourceOrderKey(sourceSystem: string, sourceAccount: string,
  externalOrderId: string): string {
  return JSON.stringify([sourceSystem, sourceAccount, externalOrderId]);
}
function uniqueNights(cells: Night[]): Night[] {
  return [...new Map(cells.map((cell) => [keyOf(cell), cell])).values()];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("INVALID_LINE_PREVIEW");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
async function linePreviewKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signLinePreview(secret: string, principal: Principal,
  propertyId: string, inventoryVersion: number, inputHash: string,
  action: "create" | "amend" | "cancel" | "inventory" | "inventory-batch" | "bulk-cancel" | "channel-action" = "create", bookingId: string | null = null,
  bookingVersion: number | null = null, targetHash: string | null = null): Promise<{
    token: string; expiresAt: string;
  }> {
  const issuedAtMs = Date.now(), expiresAtMs = issuedAtMs + LINE_PREVIEW_LIFETIME_MS;
  const claims = { v: 1, aud: `iron-gate-line-${action}-preview-v1`, bookingId, bookingVersion,
    workspaceId: principal.workspaceId, propertyId,
    actorId: principal.subjectId, clientId: principal.clientId,
    grantId: principal.grantId, authorityEpoch: principal.authorityEpoch,
    inventoryVersion, inputHash, targetHash, issuedAtMs, expiresAtMs,
    nonce: crypto.randomUUID() };
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC",
    await linePreviewKey(secret), new TextEncoder().encode(encoded)));
  return { token: `${encoded}.${base64url(signature)}`,
    expiresAt: new Date(expiresAtMs).toISOString() };
}
function verifyLinePreview(secret: string, token: string | null | undefined,
  principal: Principal, propertyId: string, inventoryVersion: number,
  inputHash: string, action: "create" | "amend" | "cancel" | "inventory" | "inventory-batch" | "bulk-cancel" | "channel-action" = "create",
  bookingId: string | null = null, bookingVersion: number | null = null,
  targetHash: string | null = null): number | null {
  try {
    if (typeof token !== "string" || token.length > 2048) return null;
    const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!parts) return null;
    const expected = createHmac("sha256", secret).update(parts[1], "utf8").digest();
    const supplied = decodeBase64url(parts[2]);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64url(parts[1])));
    const now = Date.now();
    const valid = claims?.v === 1 && claims.aud === `iron-gate-line-${action}-preview-v1` &&
      claims.bookingId === bookingId && claims.bookingVersion === bookingVersion &&
      claims.workspaceId === principal.workspaceId && claims.propertyId === propertyId &&
      claims.actorId === principal.subjectId && claims.clientId === principal.clientId &&
      claims.grantId === principal.grantId &&
      claims.authorityEpoch === principal.authorityEpoch &&
      claims.inventoryVersion === inventoryVersion && claims.inputHash === inputHash &&
      (claims.targetHash ?? null) === targetHash &&
      typeof claims.nonce === "string" && UUID.test(claims.nonce) &&
      Number.isSafeInteger(claims.issuedAtMs) &&
      Number.isSafeInteger(claims.expiresAtMs) &&
      claims.expiresAtMs - claims.issuedAtMs === LINE_PREVIEW_LIFETIME_MS &&
      claims.issuedAtMs <= now + 2_000 && claims.expiresAtMs > now;
    return valid ? claims.expiresAtMs : null;
  } catch { return null; }
}

export function nightsFor(stays: Stay[], roomIds: string[]): Night[] {
  if (!Array.isArray(stays) || stays.length < 1 || stays.length > 60) reject("INVALID_STAY");
  const allowed = new Set(roomIds);
  const result: Night[] = [];
  for (const stay of stays) {
    if (!stay || !Array.isArray(stay.roomIds) || !stay.roomIds.length) reject("INVALID_STAY");
    const from = dayNumber(stay.checkIn), to = dayNumber(stay.checkOut);
    if (to <= from || to - from > MAX_NIGHTS) reject("INVALID_STAY");
    if (new Set(stay.roomIds).size !== stay.roomIds.length) reject("INVALID_STAY");
    for (const roomId of stay.roomIds) {
      if (!allowed.has(uuid(roomId))) reject("ROOM_NOT_FOUND");
      for (let day = from; day < to; day++) {
        result.push({ roomId, date: new Date(day * DAY).toISOString().slice(0, 10) });
        if (result.length > 4096) reject("INVALID_STAY");
      }
    }
  }
  if (result.length > 4096 || uniqueNights(result).length !== result.length) reject("DUPLICATE_ROOM_NIGHT");
  return result;
}

function authorize(principal: Principal, state: PropertyState, action: Action, write = false): void {
  if (principal.workspaceId !== state.workspaceId || !Array.isArray(principal.propertyIds) ||
    !principal.propertyIds.includes(state.propertyId) || !Array.isArray(principal.actions) ||
    !principal.actions.includes(action) || !Array.isArray(principal.fields)) reject("FORBIDDEN", 403);
  if (principal.origin === "source" && (!principal.grantId ||
    !state.sourceGrants.some((grant) => grant.active && grant.grantId === principal.grantId &&
      grant.sourceSystem === principal.sourceSystem && grant.sourceAccount === principal.sourceAccount)))
    reject("FORBIDDEN", 403);
  if (principal.origin === "line" && !principal.grantId) reject("FORBIDDEN", 403);
  if (principal.origin === "channel" && (!principal.grantId ||
    principal.grantId !== state.channel.grantId)) reject("FORBIDDEN", 403);
  if (principal.origin === "website" && (!principal.bindingId ||
    principal.bindingId !== state.channel.websiteBindingId)) reject("FORBIDDEN", 403);
  if (write && state.readOnly) reject("PROPERTY_READ_ONLY", 409);
  if (write && principal.authorityEpoch !== state.authorityEpoch) reject("AUTHORITY_MOVED", 409);
}
function lineManagesAll(principal: Principal): boolean {
  return principal.origin === "line" && principal.actions.includes("booking:manage_all");
}
function lineManualPolicy(principal: Principal, policy: unknown): boolean {
  if (policy === undefined) return false;
  if (policy !== "manual") reject("INVALID_CHANNEL_POLICY");
  if (!lineManagesAll(principal) || !principal.actions.includes("inventory:write") ||
    !principal.grantId) reject("FORBIDDEN", 403);
  return true;
}
function lineScope(principal: Principal): Record<string, unknown> {
  return lineManagesAll(principal) ? { grantId: principal.grantId, manageAll: true } :
    { grantId: principal.grantId };
}
function occupies(booking: Booking): boolean { return booking.status === "held" || booking.status === "confirmed"; }
function hasConflict(state: PropertyState, cells: Night[], exceptBookingId?: string, exceptFenceKey?: string): boolean {
  const asked = new Set(cells.map(keyOf));
  if (state.manualBlocks.some((cell) => asked.has(keyOf(cell)))) return true;
  if (state.fences.some((fence) => fence.key !== exceptFenceKey && fence.cells.some((cell) => asked.has(keyOf(cell))))) return true;
  return state.bookings.some((booking) => booking.id !== exceptBookingId && occupies(booking) &&
    nightsFor(booking.stays, state.roomIds).some((cell) => asked.has(keyOf(cell))));
}
/** The preview is invalidated only by changes to its own room nights. */
function targetHash(state: PropertyState, cells: Night[], exceptBookingId?: string): string {
  const selected = new Set(cells.map(keyOf));
  const occupancy = state.bookings.filter((booking) => booking.id !== exceptBookingId &&
    occupies(booking)).flatMap((booking) => nightsFor(booking.stays, state.roomIds)
      .filter((cell) => selected.has(keyOf(cell))).map((cell) => [keyOf(cell), booking.id, booking.version]));
  const blocks = state.manualBlocks.filter((cell) => selected.has(keyOf(cell))).map(keyOf);
  const fences = state.fences.filter((fence) => fence.cells.some((cell) => selected.has(keyOf(cell))))
    .map((fence) => [fence.key, fence.reason,
      fence.cells.filter((cell) => selected.has(keyOf(cell))).map(keyOf).sort()]);
  return createHash("sha256").update(canonical({ cells: [...selected].sort(),
    occupancy: occupancy.sort(), blocks: blocks.sort(), fences: fences.sort() }), "utf8")
    .digest("hex");
}
function linePendingCells(baseline: Night[], current: Night[]): DesiredCell[] {
  const before = new Set(baseline.map(keyOf));
  const after = new Set(current.map(keyOf));
  return [
    ...current.filter((cell) => !before.has(keyOf(cell)))
      .map((cell) => ({ ...cell, desired: "closed" as const })),
    ...baseline.filter((cell) => !after.has(keyOf(cell)))
      .map((cell) => ({ ...cell, desired: "open" as const })),
  ].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}
function linePendingFenceKey(bookingId: string): string { return `line:action:${bookingId}`; }
function updateLinePending(state: PropertyState, booking: Booking, current: Night[]): void {
  const baseline = booking.lineChannelBaselineNights ?? [];
  const pending = linePendingCells(baseline, current);
  const previous = booking.lineChannelPending ?? [];
  const sameWork = previous.length === pending.length && previous.every((cell, index) =>
    keyOf(cell) === keyOf(pending[index]) && cell.desired === pending[index].desired);
  booking.lineChannelActionRequiredAt = pending.length ?
    booking.channelSyncState === "action_required" && sameWork &&
      booking.lineChannelActionRequiredAt ? booking.lineChannelActionRequiredAt :
      new Date().toISOString() : null;
  booking.lineChannelPending = pending;
  booking.channelOperationKey = null;
  booking.channelSyncState = booking.lineChannelPending.length ? "action_required" :
    baseline.length ? "verified" : "not_required";
  // The former room nights are still closed at OwlNest. Keep them out of
  // inventory until staff explicitly opens and verifies them there.
  const key = linePendingFenceKey(booking.id);
  state.fences = state.fences.filter((fence) => fence.key !== key);
  const opens = booking.lineChannelPending.filter((cell) => cell.desired === "open")
    .map(({ roomId, date }) => ({ roomId, date }));
  if (opens.length) state.fences.push({ key, cells: opens, reason: "line_action_required" });
}
function readInventoryIndex(state: PropertyState, first: number, end: number) {
  if (state.roomIds.length * (end - first) > 4096) reject("READ_CAPACITY_LIMIT", 409);
  const occupied = new Map<string, Booking["status"]>();
  for (const booking of state.bookings) {
    if (!occupies(booking)) continue;
    for (const cell of nightsFor(booking.stays, state.roomIds)) {
      const day = dayNumber(cell.date);
      if (day < first || day >= end) continue;
      const key = keyOf(cell);
      if (occupied.has(key)) reject("INVENTORY_CONFLICT", 409);
      occupied.set(key, booking.status);
    }
  }
  const fenced = new Set<string>(state.fences.flatMap((fence) => fence.cells.map(keyOf)));
  const blocked = new Set<string>([...state.manualBlocks.map(keyOf), ...fenced]);
  return { occupied, blocked, fenced };
}
function receiptFor(state: PropertyState, principal: Principal, requestKey: string, hash: string): RequestReceipt | null {
  const prior = state.receipts.find((receipt) => receipt.key === requestKey &&
    receipt.clientId === principal.clientId && receipt.subjectId === principal.subjectId &&
    receipt.grantId === (principal.grantId ?? null));
  if (prior && prior.requestHash !== hash) reject("IDEMPOTENCY_CONFLICT", 409);
  return prior ?? null;
}
function saveReceipt(state: PropertyState, principal: Principal, requestKey: string, action: Action,
  hash: string, response: Record<string, unknown>): void {
  state.receipts.push({ key: requestKey, clientId: principal.clientId,
    subjectId: principal.subjectId, grantId: principal.grantId ?? null,
    propertyId: state.propertyId,
    action, requestHash: hash, response });
}
function publicBooking(booking: Booking, principal: Principal,
  state: PropertyState): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: booking.id, workspaceId: booking.workspaceId, propertyId: booking.propertyId,
    version: booking.version, status: booking.status, channelSyncState: booking.channelSyncState,
    stays: booking.stays, createdAt: booking.createdAt, source: booking.source,
  };
  if ((principal.origin === "os" || lineManagesAll(principal)) &&
    booking.lineChannelPending !== undefined)
    result.lineChannelPending = structuredClone(booking.lineChannelPending);
  if ((principal.origin === "os" || lineManagesAll(principal)) &&
    booking.lineChannelActionRequiredAt !== undefined)
    result.lineChannelActionRequiredAt = booking.lineChannelActionRequiredAt;
  if (principal.origin === "os" || lineManagesAll(principal))
    result.sourceReviewRequired = booking.lineOverridePending === true ||
      state.sourceLinks.some((link) => link.bookingId === booking.id && link.diverged);
  if (principal.origin === "os" || lineManagesAll(principal)) result.bookedAt = booking.bookedAt;
  if (principal.origin === "os") {
    result.channelOperationKey = booking.channelOperationKey;
    result.osEditMode = isOsDirectBooking(booking) ? "full" :
      booking.source === "external" ? "guest_name" : "none";
    result.osDirectOverride = booking.osDirectOverride === true;
    if (booking.osManualRoomChange || booking.lineChannelBaselineNights)
      result.manualBaselineNights = structuredClone(booking.osManualRoomChange?.baseline ?? booking.lineChannelBaselineNights);
  }
  // Field grants are server-authenticated. Public website queries use a separate order credential.
  if ((principal.origin === "os" || principal.origin === "line") &&
    principal.fields.includes("guest_name")) {
    result.guestName = booking.guestName;
    if (principal.origin === "os" && booking.sourceCalendar) {
      result.sourceCalendar = { platform: booking.sourceCalendar.platform,
        ...(principal.fields.includes("money") ?
          { externalOrderNo: booking.sourceCalendar.externalOrderNo } : {}),
        bookedAt: booking.bookedAt };
    } else if (lineManagesAll(principal) && booking.sourceCalendar) {
      result.sourceCalendar = { ...booking.sourceCalendar, bookedAt: booking.bookedAt };
    }
    // The imported rows remain private evidence. Only unambiguous calendar
    // labels may leave that evidence, under the same OS guest grant.
    const snapshot = principal.origin === "os" || lineManagesAll(principal) ?
      booking.sweetfunSnapshot : undefined;
    const rows = snapshot?.rows;
    const groupKey = typeof snapshot?.groupKey === "string" ? snapshot.groupKey : null;
    if (!booking.sourceCalendar && Array.isArray(rows) && rows.length) {
      const unique = (column: number): string | null => {
        const values = [...new Set(rows.map((row) => String(row.values?.[column] ?? "").trim()))]
          .filter(Boolean);
        return values.length === 1 ? values[0] : null;
      };
      const platform = unique(2);
      const externalOrderNo = unique(13);
      const rawBookedAt = unique(5);
      const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(rawBookedAt ?? "");
      const bookedAt = match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : null;
      result.sourceCalendar = { platform,
        ...(principal.fields.includes("money") ? { externalOrderNo } : {}),
        bookedAt: booking.osDirectOverride === true ? booking.bookedAt :
          bookedAt && Number.isFinite(Date.parse(`${bookedAt}T00:00:00Z`)) &&
          new Date(`${bookedAt}T00:00:00Z`).toISOString().slice(0, 10) === bookedAt
          ? bookedAt : null,
        ...(principal.fields.includes("money") && booking.source === "external" &&
          booking.version === 1 &&
          booking.totalCents !== null && rows.length === booking.stays.length &&
          rows.every((row) => Array.isArray(row?.values) &&
            Number.isSafeInteger(row.roomFeeCents) && row.roomFeeCents >= 0) &&
          rows.reduce((sum, row) => sum + row.roomFeeCents, 0) === booking.totalCents &&
          groupKey !== null &&
          (/^L:[A-Za-z0-9-]{8,64}$/.test(groupKey) ||
            /^J:[A-Za-z0-9_-]{8,100}$/.test(groupKey)) &&
          rows.every((row) => groupKey ===
            (groupKey.startsWith("L:")
              ? `L:${String(row.values[11] ?? "").trim()}`
              : `J:${String(row.values[9] ?? "").trim()}`))
          ? { sourceOrderRef: groupKey } : {}),
        ...(principal.fields.includes("money") && booking.osDirectOverride === true &&
          originalDirectOrderRef(booking) ? { sourceOrderRef: originalDirectOrderRef(booking) } : {}) };
    }
    const offland = booking.offlandSnapshot;
    const offlandRows = offland?.rows;
    const offlandKey = typeof offland?.groupKey === "string" ? offland.groupKey : null;
    if (!booking.sourceCalendar && Array.isArray(offlandRows) && offlandRows.length &&
      booking.source === "external") {
      const unique = (column: number): string | null => {
        const values = [...new Set(offlandRows.map((row: { values?: unknown[] }) =>
          String(row.values?.[column] ?? "").trim()))].filter(Boolean);
        return values.length === 1 ? values[0] : null;
      };
      const sourceOrderRef = principal.fields.includes("money") &&
        booking.version === 1 &&
        (/^Q:[A-Za-z0-9-]{8,128}$/.test(offlandKey ?? "") ||
          /^J:[A-Za-z0-9_-]{8,100}$/.test(offlandKey ?? "")) &&
        offlandRows.every((row: { values?: unknown[] }) =>
          offlandKey === (offlandKey?.startsWith("Q:")
            ? `Q:${String(row.values?.[16] ?? "").trim()}`
            : `J:${String(row.values?.[9] ?? "").trim()}`))
        ? offlandKey : null;
      result.sourceCalendar = { platform: unique(2),
        ...(principal.fields.includes("money") ?
          { externalOrderNo: unique(16),
            ...(sourceOrderRef ? { sourceOrderRef } : {}) } : {}),
        bookedAt: booking.bookedAt };
    }
  }
  if ((principal.origin === "os" || principal.origin === "line") &&
    principal.fields.includes("contact")) result.contact = booking.contact;
  if ((principal.origin === "os" || principal.origin === "line") &&
    principal.fields.includes("notes")) result.notes = booking.notes;
  if (principal.origin === "os" && principal.fields.includes("payment_status"))
    result.paymentReview = calendarPaymentStatus(booking);
  if ((principal.origin === "os" || principal.origin === "finance") &&
    principal.fields.includes("money")) {
    result.totalCents = booking.totalCents;
    result.currency = booking.currency;
    result.paymentSummary = paymentTotals(booking);
    if (principal.origin === "os") {
      const prices = bookingNightPrices(booking);
      if (prices) result.roomNightPrices = prices;
    }
  }
  if (principal.origin === "line" && principal.fields.includes("money")) {
    result.totalCents = booking.totalCents;
    result.currency = booking.currency;
    const prices = bookingNightPrices(booking);
    if (prices) result.roomNightPrices = prices;
    if (lineManagesAll(principal)) result.sourcePaymentFlag = sourcePaymentFlag(booking);
  }
  if (principal.origin === "os" && booking.hold) {
    const hold = booking.status === "held" && booking.hold.state === "active" &&
      timestamp(booking.hold.expiresAt) <= Date.now()
      ? { ...booking.hold, state: "awaiting_owner" } : { ...booking.hold };
    if (!principal.fields.includes("money")) {
      delete hold.latePaymentReview;
      delete hold.convertedAt;
    }
    result.hold = hold;
  }
  return result;
}
// A calendar stay is a priced segment. Imported multi-night orders retain
// their original per-night amounts; expose them only when they still reconcile
// exactly to the authoritative booking total.
function calendarStayAmounts(booking: Booking): number[] | null {
  if (booking.totalCents === null || !Number.isSafeInteger(booking.totalCents) ||
    booking.totalCents < 0 || booking.stays.some((stay) => stay.roomIds.length !== 1)) return null;
  if (booking.stays.length === 1) return [booking.totalCents];
  if (Array.isArray(booking.roomNightPrices)) {
    const cells = nightsFor(booking.stays, [...new Set(booking.stays.flatMap(stay => stay.roomIds))]);
    const prices = exactNightPrices(booking.roomNightPrices, cells, booking.totalCents);
    if (prices) return booking.stays.map(stay => prices.filter(price =>
      price.roomId === stay.roomIds[0] && price.date >= stay.checkIn && price.date < stay.checkOut)
      .reduce((sum, price) => sum + price.amountCents, 0));
  }
  // A newer source event supplies only a whole-order amount. Historical
  // imported rows cannot prove its current per-night distribution.
  if (booking.sourceCalendar || booking.osDirectOverride) return null;
  const rows = booking.sweetfunSnapshot?.rows;
  if (!Array.isArray(rows) || rows.length !== booking.stays.length) return null;
  const amounts: number[] = [];
  for (const [index, stay] of booking.stays.entries()) {
    const values = rows[index]?.values;
    if (!Array.isArray(values)) return null;
    const date = (value: unknown) => String(value ?? "").replaceAll("/", "-")
      .replace(/-(\d)(?=-|$)/g, "-0$1");
    const amount = String(values[6] ?? "");
    if (date(values[3]) !== stay.checkIn || date(values[4]) !== stay.checkOut ||
      !/^\d{1,10}$/.test(amount)) return null;
    amounts.push(Number(amount) * 100);
  }
  return amounts.reduce((sum, amount) => sum + amount, 0) === booking.totalCents ? amounts : null;
}
function exactNightPrices(prices: NightPrice[] | undefined, cells: Night[], totalCents: number | null):
  NightPrice[] | null {
  if (!Array.isArray(prices) || prices.length !== cells.length || totalCents === null ||
    prices.length > 4096) return null;
  const expected = new Set(cells.map(keyOf));
  const seen = new Set<string>();
  let total = 0n;
  for (const price of prices) {
    if (!price || typeof price.roomId !== "string" || typeof price.date !== "string" ||
      !Number.isSafeInteger(price.amountCents) || price.amountCents < 0 ||
      !expected.has(keyOf(price)) || seen.has(keyOf(price))) return null;
    seen.add(keyOf(price));
    total += BigInt(price.amountCents);
  }
  if (seen.size !== expected.size || total !== BigInt(totalCents)) return null;
  return structuredClone(prices);
}
function bookingNightPrices(booking: Booking): NightPrice[] | null {
  const cells = nightsFor(booking.stays, [...new Set(booking.stays.flatMap((stay) => stay.roomIds))]);
  const stored = exactNightPrices(booking.roomNightPrices, cells, booking.totalCents);
  if (stored) return stored;
  const amounts = calendarStayAmounts(booking);
  if (!amounts || booking.stays.some((stay) => stay.roomIds.length !== 1 ||
    dayNumber(stay.checkOut) - dayNumber(stay.checkIn) !== 1)) return null;
  return exactNightPrices(booking.stays.map((stay, index) => ({
    roomId: stay.roomIds[0], date: stay.checkIn, amountCents: amounts[index],
  })), cells, booking.totalCents);
}
function sourcePaymentFlag(booking: Booking): "unpaid" | "paid" | "unknown" {
  if (booking.source !== "external" || booking.version !== 1 ||
    booking.sourceCalendar || !bookingNightPrices(booking)) return "unknown";
  const rows = booking.sweetfunSnapshot?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length !== booking.stays.length) return "unknown";
  const flags = new Set(rows.map((row) => String(row.values?.[7] ?? "").trim()));
  if (flags.size !== 1) return "unknown";
  const flag = [...flags][0];
  return flag === "not_yet" ? "unpaid" : flag === "done" ? "paid" : "unknown";
}
function verifyCreate(input: CreateBookingInput, principal: Principal): void {
  if (principal.origin !== input.source || !["os", "line", "website"].includes(input.source))
    reject("FORBIDDEN", 403);
  if (principal.origin === "line" && !principal.grantId) reject("FORBIDDEN", 403);
  if (!Number.isSafeInteger(input.expectedInventoryVersion) || input.expectedInventoryVersion < 0)
    reject("INVALID_VERSION");
  nullableText(input.guestName, 200);
  nullableText(input.contact, 256);
  nullableText(input.notes, 2048);
  if (input.totalCents !== null && (!Number.isSafeInteger(input.totalCents) || input.totalCents < 0))
    reject("INVALID_AMOUNT");
  if (input.bookedAt !== null) dayNumber(input.bookedAt);
  if (input.roomNightPrices !== undefined && !["line", "os"].includes(principal.origin))
    reject("FORBIDDEN", 403);
  lineManualPolicy(principal, input.channelPolicy);
}
function verifyAmend(input: AmendBookingInput): void {
  if (!Number.isSafeInteger(input.expectedBookingVersion) || input.expectedBookingVersion < 1 ||
    !Number.isSafeInteger(input.expectedInventoryVersion) || input.expectedInventoryVersion < 0)
    reject("INVALID_VERSION");
  if (!input.changes || Array.isArray(input.changes) || typeof input.changes !== "object") reject("INVALID_INPUT");
  const fields = Object.keys(input.changes);
  if (!fields.length || fields.some((field) => !["stays", "guestName", "contact", "notes", "totalCents", "roomNightPrices", "bookedAt"].includes(field)))
    reject("INVALID_INPUT");
  if ("guestName" in input.changes) nullableText(input.changes.guestName, 200);
  if ("contact" in input.changes) nullableText(input.changes.contact, 256);
  if ("notes" in input.changes) nullableText(input.changes.notes, 2048);
  if ("bookedAt" in input.changes && input.changes.bookedAt !== null) dayNumber(input.changes.bookedAt);
  if ("totalCents" in input.changes && input.changes.totalCents !== null &&
    (!Number.isSafeInteger(input.changes.totalCents) || input.changes.totalCents! < 0)) reject("INVALID_AMOUNT");
  if (input.channelPolicy !== undefined && input.channelPolicy !== "manual")
    reject("INVALID_CHANNEL_POLICY");
  if (input.reason !== undefined) nonempty(input.reason, 500);
}
function requireLineMutation(principal: Principal, state: PropertyState, booking: Booking,
  manual = false): void {
  if (!lineManagesAll(principal) || !principal.grantId)
    reject("FORBIDDEN", 403);
  if (state.channel.mode !== "owlnest" || !state.channel.ready ||
    state.channel.sourceReadbackEnabled !== true || !state.channel.grantId)
    reject("LINE_CHANNEL_NOT_READY", 409);
  if (booking.status !== "confirmed" ||
    (booking.channelSyncState !== "verified" &&
      !(booking.source === "external" && booking.channelSyncState === "not_required") &&
      !(manual && booking.channelSyncState === "action_required" &&
        booking.lineChannelBaselineNights !== undefined && booking.channelOperationKey === null)))
    reject("LINE_BOOKING_NOT_READY", 409);
  if (manual && state.operations.some((operation) => operation.bookingId === booking.id &&
    operation.state !== "sync_verified")) reject("LINE_BOOKING_NOT_READY", 409);
  if (netReceived(booking) !== 0) reject("LINE_PAYMENT_REQUIRES_REVIEW", 409);
  if (sourcePaymentFlag(booking) === "paid") reject("LINE_PAYMENT_REQUIRES_REVIEW", 409);
  requireLineStockWindow(state, nightsFor(booking.stays, state.roomIds));
}
function requireManualBaseline(booking: Booking, manual: boolean, changesRoomNights: boolean): void {
  if (manual && changesRoomNights && booking.lineChannelBaselineNights === undefined)
    reject("LINE_CHANNEL_BASELINE_UNPROVEN", 409);
}
function requireLineStockWindow(state: PropertyState, cells: Night[],
  code = "LINE_STOCK_NOT_OBSERVED"): void {
  const end = state.channel.stockObservedThrough;
  if (end && cells.some((cell) => cell.date > end))
    reject(code, 409);
}
function requireOsStockWindow(state: PropertyState, cells: Night[]): void {
  const from = state.channel.stockObservedFrom;
  const through = state.channel.stockObservedThrough;
  if (!from || !through || cells.some((cell) => cell.date < from || cell.date > through))
    reject("CHANNEL_STOCK_NOT_OBSERVED", 409);
}
function verifiedOwnManualClose(state: PropertyState, booking: Booking, cells: Night[]): boolean {
  const operation = state.operations.find((item) => item.key === booking.channelOperationKey);
  if (booking.source !== "os" || booking.channelSyncState !== "verified" ||
    !operation || operation.bookingId !== booking.id ||
    operation.state !== "sync_verified" || operation.manualInitialClose !== true ||
    operation.ownCloseWriteRequired !== true ||
    operation.initialOpenPreflight?.status !== "open" ||
    !operation.observations?.some((item) => item.accepted === true) ||
    operation.cells.length !== cells.length || hasConflict(state, cells, booking.id))
    return false;
  const expected = new Set(cells.map(keyOf));
  return operation.cells.every((cell) => cell.desired === "closed" && expected.has(keyOf(cell)));
}
function osChangeFenceKey(bookingId: string): string { return `os:amend:${bookingId}`; }
function saveOsRoomChange(state: PropertyState, booking: Booking, before: Night[], after: Night[]): void {
  const lineBaseline = booking.lineChannelBaselineNights;
  booking.osManualRoomChange ??= { baseline: structuredClone(lineBaseline ?? before),
    baselineState: lineBaseline ? lineBaseline.length ? "verified" : "not_required" :
      booking.channelSyncState, baselineOperationKey: booking.channelOperationKey };
  if (lineBaseline !== undefined) {
    state.fences = state.fences.filter(fence => fence.key !== linePendingFenceKey(booking.id));
    delete booking.lineChannelBaselineNights;
    delete booking.lineChannelPending;
    delete booking.lineChannelActionRequiredAt;
  }
  const saved = booking.osManualRoomChange;
  const key = osChangeFenceKey(booking.id);
  state.fences = state.fences.filter(fence => fence.key !== key);
  const work = linePendingCells(saved.baseline, after);
  if (!work.length) {
    booking.channelSyncState = saved.baselineState;
    booking.channelOperationKey = saved.baselineOperationKey;
    delete booking.osManualRoomChange;
    return;
  }
  const old = work.filter(cell => cell.desired === "open").map(({ roomId, date }) => ({ roomId, date }));
  if (old.length) state.fences.push({ key, cells: old, reason: "channel_pending" });
  booking.channelSyncState = "awaiting_manual_sync";
  booking.channelOperationKey = null;
}
function hasVerifiedClosedBaseline(state: PropertyState, booking: Booking, cells: Night[]): boolean {
  const proven = new Set<string>();
  for (const operation of state.operations.filter(item => item.bookingId === booking.id &&
    item.state === "sync_verified" && item.observations?.some(item => item.accepted))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    for (const cell of operation.cells) {
      if (cell.desired === "closed") proven.add(keyOf(cell)); else proven.delete(keyOf(cell));
    }
  }
  return cells.every(cell => proven.has(keyOf(cell)));
}
function verifyLineInventoryInput(input: LineInventoryInput): Night {
  if (!input || !Number.isSafeInteger(input.expectedInventoryVersion) ||
    input.expectedInventoryVersion < 0 || !["closed", "open"].includes(input.desired))
    reject("INVALID_INPUT");
  uuid(input.roomId); dayNumber(input.date);
  return { roomId: input.roomId, date: input.date };
}
function verifyLineInventoryBatchInput(input: LineInventoryBatchInput): Night[] {
  if (!input || !Number.isSafeInteger(input.expectedInventoryVersion) ||
    input.expectedInventoryVersion < 0 || !["closed", "open"].includes(input.desired) ||
    !Array.isArray(input.cells) || input.cells.length < 1 || input.cells.length > 14)
    reject("INVALID_INPUT");
  let previous = "";
  return input.cells.map((cell) => {
    if (!cell || Object.keys(cell).sort().join(",") !== "date,roomId") reject("INVALID_INPUT");
    uuid(cell.roomId); dayNumber(cell.date);
    const key = keyOf(cell);
    if (key <= previous) reject("INVALID_INPUT");
    previous = key;
    return { roomId: cell.roomId, date: cell.date };
  });
}
function verifyLineChannelActionInput(input: LineChannelActionInput): Night[] {
  if (!input || !Number.isSafeInteger(input.expectedBookingVersion) ||
    input.expectedBookingVersion < 1 || !Number.isSafeInteger(input.expectedInventoryVersion) ||
    input.expectedInventoryVersion < 0 || !["closed", "open"].includes(input.desired) ||
    !Array.isArray(input.cells) || !input.cells.length || input.cells.length > 4096)
    reject("INVALID_INPUT");
  let previous = "";
  return input.cells.map((cell) => {
    if (!cell || Object.keys(cell).sort().join(",") !== "date,roomId") reject("INVALID_INPUT");
    uuid(cell.roomId); dayNumber(cell.date);
    const key = keyOf(cell);
    if (key <= previous) reject("INVALID_INPUT");
    previous = key;
    return { roomId: cell.roomId, date: cell.date };
  });
}
function requireLineChannelAction(principal: Principal, state: PropertyState,
  booking: Booking, input: LineChannelActionInput, cells: Night[]): void {
  authorize(principal, state, "inventory:write", true);
  if (!lineManagesAll(principal) || !principal.grantId ||
    state.channel.mode !== "owlnest" || !state.channel.ready ||
    state.channel.sourceReadbackEnabled !== true || !state.channel.grantId)
    reject("LINE_CHANNEL_NOT_READY", 409);
  if (booking.version !== input.expectedBookingVersion) reject("VERSION_CONFLICT", 409);
  if (booking.lineChannelBaselineNights === undefined ||
    booking.channelSyncState !== "action_required" ||
    !booking.lineChannelPending?.length || booking.channelOperationKey !== null)
    reject("LINE_CHANNEL_ACTION_NOT_READY", 409);
  if (state.operations.some((operation) => operation.bookingId === booking.id &&
    operation.state !== "sync_verified")) reject("LINE_CHANNEL_ACTION_NOT_READY", 409);
  const expected = booking.lineChannelPending.filter((cell) => cell.desired === input.desired)
    .map(keyOf).sort();
  if (!expected.length || expected.length !== cells.length ||
    expected.some((value, index) => value !== keyOf(cells[index])))
    reject("LINE_CHANNEL_ACTION_SCOPE_MISMATCH", 409);
  requireLineStockWindow(state, cells);
  const current = new Set(booking.status === "confirmed" ?
    nightsFor(booking.stays, state.roomIds).map(keyOf) : []);
  if (input.desired === "closed") {
    if (booking.status !== "confirmed" || cells.some((cell) => !current.has(keyOf(cell))))
      reject("LINE_CHANNEL_ACTION_SCOPE_MISMATCH", 409);
    // The booking's own source-review fence preserves its old nights but may
    // not block a defensive close of newly acquired nights. Other fences do.
    const ownFence = `review:line:${booking.id}`;
    if (hasConflict(state, cells, booking.id, ownFence)) reject("ROOM_CONFLICT", 409);
  } else {
    if (booking.lineChannelPending.some((cell) => cell.desired === "closed"))
      reject("LINE_CLOSE_FIRST", 409);
    if (booking.source === "external" && booking.lineOverridePending === true)
      reject("SOURCE_REVIEW_OPEN", 409);
    if (cells.some((cell) => current.has(keyOf(cell))) ||
      hasConflict(state, cells, booking.id, linePendingFenceKey(booking.id)))
      reject("ROOM_CONFLICT", 409);
  }
}
function verifyLineBulkCancelInput(input: LineBulkCancelInput): void {
  if (!input || !Number.isSafeInteger(input.expectedInventoryVersion) ||
    input.expectedInventoryVersion < 0 || !Array.isArray(input.bookings) ||
    input.bookings.length < 2 || input.bookings.length > 50) reject("INVALID_INPUT");
  let previous = "";
  for (const item of input.bookings) {
    if (!item || Object.keys(item).sort().join(",") !== "bookingId,expectedBookingVersion" ||
      !Number.isSafeInteger(item.expectedBookingVersion) || item.expectedBookingVersion < 1)
      reject("INVALID_INPUT");
    const id = uuid(item.bookingId);
    if (id <= previous) reject("INVALID_INPUT");
    previous = id;
  }
  if (input.channelPolicy !== undefined && input.channelPolicy !== "manual")
    reject("INVALID_CHANNEL_POLICY");
}
function requireLineInventory(principal: Principal, state: PropertyState,
  input: LineInventoryInput): Night {
  authorize(principal, state, "inventory:write", true);
  if (!lineManagesAll(principal) || !principal.grantId ||
    state.channel.mode !== "owlnest" || !state.channel.ready ||
    state.channel.sourceReadbackEnabled !== true || !state.channel.grantId)
    reject("LINE_CHANNEL_NOT_READY", 409);
  const cell = verifyLineInventoryInput(input);
  requireLineStockWindow(state, [cell]);
  if (!state.roomIds.includes(cell.roomId)) reject("ROOM_NOT_FOUND", 404);
  const existing = state.manualBlocks.some((item) => keyOf(item) === keyOf(cell));
  if (input.desired === "closed") {
    if (existing || hasConflict(state, [cell])) reject("ROOM_CONFLICT", 409);
  } else {
    if (!existing) reject("MANUAL_BLOCK_NOT_FOUND", 409);
    const withoutBlock = { ...state,
      manualBlocks: state.manualBlocks.filter((item) => keyOf(item) !== keyOf(cell)) };
    if (hasConflict(withoutBlock, [cell])) reject("ROOM_CONFLICT", 409);
  }
  return cell;
}
function requireAmendFields(principal: Principal, changes: AmendBookingInput["changes"]): void {
  const grants: [keyof AmendBookingInput["changes"], string][] = [
    ["guestName", "guest_name"], ["contact", "contact"], ["notes", "notes"],
    ["totalCents", "money"],
    ["roomNightPrices", "money"],
    ["bookedAt", "guest_name"],
  ];
  if (grants.some(([field, grant]) => field in changes && !principal.fields.includes(grant as
    Principal["fields"][number]))) reject("FORBIDDEN", 403);
}
function operationState(state: PropertyState, booking: Booking): BookingReceipt["operationState"] {
  if (state.channel.mode === "none") return "local_only";
  if (booking.channelSyncState === "not_required") return "not_required";
  if (booking.channelSyncState === "action_required") return "action_required";
  if (booking.channelSyncState === "awaiting_manual_sync") return "awaiting_manual_sync";
  return booking.channelSyncState === "verified" ? "sync_verified" :
    booking.channelSyncState === "review_required" ? "review_required" : "sync_pending";
}
function makeBookingReceipt(state: PropertyState, booking: Booking): BookingReceipt {
  return { bookingId: booking.id, bookingVersion: booking.version, inventoryVersion: state.version,
    operationState: operationState(state, booking), operationKey: booking.channelOperationKey,
    sourceReviewRequired: booking.lineOverridePending === true,
    refundReviewRequired: netReceived(booking) > 0 &&
      (booking.status === "cancelled" ||
        (booking.totalCents !== null && netReceived(booking) > booking.totalCents)) };
}
function flagExternalSourceReview(state: PropertyState, booking: Booking,
  before: Night[], after: Night[], unverifiable = false): void {
  if (booking.source !== "external") return;
  booking.lineOverridePending = true;
  if (unverifiable) booking.lineOverrideUnverifiable = true;
  for (const link of state.sourceLinks) if (link.bookingId === booking.id) link.diverged = true;
  if (changedNights(before, after)) {
    const key = `review:line:${booking.id}`;
    const existing = state.fences.find((fence) => fence.key === key);
    state.fences = state.fences.filter((fence) => fence.key !== key);
    state.fences.push({ key, cells: uniqueNights([...(existing?.cells ?? []), ...before, ...after]),
      reason: "source_review" });
  }
}

function netReceived(booking: Booking): number {
  return paymentTotals(booking).netReceivedCents;
}

function paymentTotals(booking: Booking): {
  receivedCents: number; refundedCents: number; netReceivedCents: number;
} {
  let received = 0n, refunded = 0n;
  for (const event of booking.paymentEvents ?? []) {
    if (!Number.isSafeInteger(event.amountCents) || event.amountCents < 0) reject("INVALID_AMOUNT", 409);
    if (event.kind === "received") received += BigInt(event.amountCents);
    else if (event.kind === "refunded") refunded += BigInt(event.amountCents);
    else reject("INVALID_PAYMENT_EVENT", 409);
  }
  if (received > BigInt(Number.MAX_SAFE_INTEGER) || refunded > BigInt(Number.MAX_SAFE_INTEGER) ||
    refunded > received) reject("AMOUNT_OVERFLOW", 409);
  return { receivedCents: Number(received), refundedCents: Number(refunded),
    netReceivedCents: Number(received - refunded) };
}

// The original Sheet H cell is a guest-paid claim, not a cash receipt. Keep
// it separate from paymentEvents and disclose only a compact calendar status.
function calendarPaymentStatus(booking: Booking): { status: "paid" | "deposit" | "unknown";
  source: "sheet_flag" | "payment_events" | "unknown" } {
  const rows = booking.sweetfunSnapshot?.rows;
  const events = booking.paymentEvents ?? [];
  // A later booking-source amendment clears its old imported fee and advances
  // the booking version. Never reuse the frozen H flag for that changed order.
  const sourcePaid = booking.totalCents !== null &&
    booking.version === 1 + events.length &&
    Array.isArray(rows) && rows.length > 0 && rows.every((row) =>
      Array.isArray(row?.values) && String(row.values[7] ?? "").trim() === "done");
  if (events.length) {
    const totals = paymentTotals(booking);
    if (totals.refundedCents > 0) {
      if (booking.totalCents !== null && booking.totalCents > 0 &&
        totals.netReceivedCents >= booking.totalCents)
        return { status: "paid", source: "payment_events" };
      return totals.netReceivedCents > 0
        ? { status: "deposit", source: "payment_events" }
        : { status: "unknown", source: "unknown" };
    }
    if (booking.totalCents !== null && booking.totalCents > 0 &&
      totals.netReceivedCents >= booking.totalCents)
      return { status: "paid", source: "payment_events" };
    if (sourcePaid) return { status: "paid", source: "sheet_flag" };
    return totals.netReceivedCents > 0
      ? { status: "deposit", source: "payment_events" }
      : { status: "unknown", source: "unknown" };
  }
  return sourcePaid ? { status: "paid", source: "sheet_flag" } :
    { status: "unknown", source: "unknown" };
}

function changedNights(before: Night[], after: Night[]): boolean {
  const left = before.map(keyOf).sort(), right = after.map(keyOf).sort();
  return left.length !== right.length || left.some((cell, index) => cell !== right[index]);
}

function emit(tx: TransactionContext, state: PropertyState, type: EventType,
  booking: Booking | null, principal: Principal, requestKey: string | null,
  reason?: string): void {
  const at = new Date().toISOString();
  tx.emit({ eventId: crypto.randomUUID(), at, type,
    propertyId: state.propertyId, bookingId: booking?.id ?? null,
    bookingVersion: booking?.version ?? null, inventoryVersion: state.version });
  tx.audit({ auditId: crypto.randomUUID(), at, type, workspaceId: state.workspaceId,
    propertyId: state.propertyId, bookingId: booking?.id ?? null,
    bookingVersion: booking?.version ?? null, bookingStatus: booking?.status ?? null,
    inventoryVersion: state.version, actorOrigin: principal.origin,
    actorClientId: principal.clientId, actorSubjectId: principal.subjectId,
    actorGrantId: principal.grantId ?? null, requestKey,
    ...(reason ? { reason } : {}) });
}

export class IronGateService {
  private readonly repository: PropertyRepository;
  private readonly linePreviewSecret: string | null;
  constructor(repository: PropertyRepository, linePreviewSecret: string | null = null) {
    if (linePreviewSecret !== null && !LINE_PREVIEW_SECRET.test(linePreviewSecret))
      throw Error("LINE_PREVIEW_SECRET_INVALID");
    this.repository = repository;
    this.linePreviewSecret = linePreviewSecret;
  }

  async previewLineCreate(principal: Principal, propertyId: string,
    input: CreateBookingInput): Promise<Record<string, unknown>> {
    uuid(propertyId); verifyCreate(input, principal);
    const manual = lineManualPolicy(principal, input.channelPolicy);
    if (principal.origin !== "line" || !this.linePreviewSecret)
      reject("LINE_PREVIEW_UNAVAILABLE", 503);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "booking:create");
    if (state.readOnly !== false || principal.authorityEpoch !== state.authorityEpoch ||
      state.channel.mode !== "owlnest" || !state.channel.ready ||
      state.channel.sourceReadbackEnabled !== true || !state.channel.grantId)
      reject("LINE_CHANNEL_NOT_READY", 409);
    if (!manual && state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
    const cells = nightsFor(input.stays, state.roomIds);
    if (input.roomNightPrices !== undefined &&
      !exactNightPrices(input.roomNightPrices, cells, input.totalCents))
      reject("INVALID_NIGHT_PRICES");
    requireLineStockWindow(state, cells);
    if (hasConflict(state, cells)) reject("ROOM_CONFLICT", 409);
    const hash = await digest({ action: "booking:create", input });
    const scopeHash = manual ? await targetHash(state, cells) : null;
    const signed = await signLinePreview(this.linePreviewSecret, principal,
      propertyId, input.expectedInventoryVersion, hash, "create", null, null, scopeHash);
    return { propertyId, inventoryVersion: input.expectedInventoryVersion,
      authorityEpoch: state.authorityEpoch, expiresAt: signed.expiresAt,
      previewToken: signed.token, channelSyncState: "preview_only",
      ...(manual ? { observedInventoryVersion: state.version } : {}) };
  }

  async createBooking(principal: Principal, propertyId: string, requestKey: string,
    input: CreateBookingInput, linePreviewToken: string | null = null): Promise<BookingReceipt> {
    uuid(propertyId); uuid(requestKey); verifyCreate(input, principal);
    const manual = lineManualPolicy(principal, input.channelPolicy);
    const hash = await digest({ action: "booking:create", input });
    const linePreviewExpiry = principal.origin === "line" && this.linePreviewSecret !== null && !manual ?
      await verifyLinePreview(this.linePreviewSecret, linePreviewToken, principal,
        propertyId, input.expectedInventoryVersion, hash) : null;
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "booking:create", true);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response as BookingReceipt;
      if (principal.origin === "os") {
        if (!principal.fields.includes("guest_name") || !principal.fields.includes("money"))
          reject("FORBIDDEN", 403);
        if (!input.guestName?.trim()) reject("GUEST_NAME_REQUIRED");
        if (input.totalCents === null) reject("PRICE_REQUIRED");
      }
      if (principal.origin === "line") {
        const cells = nightsFor(input.stays, state.roomIds);
        const expiry = manual && this.linePreviewSecret ?
          verifyLinePreview(this.linePreviewSecret, linePreviewToken, principal,
            propertyId, input.expectedInventoryVersion, hash, "create", null, null,
            targetHash(state, cells)) : linePreviewExpiry;
        if (expiry === null || Date.now() >= expiry)
          reject("LINE_PREVIEW_REQUIRED", 409);
        if (state.readOnly !== false || state.channel.mode !== "owlnest" || !state.channel.ready ||
          state.channel.sourceReadbackEnabled !== true || !state.channel.grantId)
          reject("LINE_CHANNEL_NOT_READY", 409);
      }
      if (!manual && state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      // Direct website writes require a one-use server-issued quote, including
      // local-only properties. A binding alone is never sale authorization.
      if (principal.origin === "website") reject("WEBSITE_QUOTE_REQUIRED", 409);
      if (state.channel.mode === "owlnest" && !state.channel.ready &&
        principal.origin !== "os") reject("SOURCE_UNAVAILABLE", 503);
      const cells = nightsFor(input.stays, state.roomIds);
      if (input.roomNightPrices !== undefined &&
        !exactNightPrices(input.roomNightPrices, cells, input.totalCents))
        reject("INVALID_NIGHT_PRICES");
      if (principal.origin === "line") requireLineStockWindow(state, cells);
      if (hasConflict(state, cells)) reject("ROOM_CONFLICT", 409);
      const manualSync = principal.origin === "os" && state.channel.mode === "owlnest";
      const operationKey = state.channel.mode === "owlnest" && !manual && !manualSync ?
        crypto.randomUUID() : null;
      // LINE's durable request key is chosen before its existing V2 confirmation
      // card. Giving the booking that ID lets the finance journal bind its
      // pre-write claim to the exact booking it will later read back.
      const bookingId = principal.origin === "line" ? requestKey : crypto.randomUUID();
      if (state.bookings.some((item) => item.id === bookingId)) reject("BOOKING_ID_CONFLICT", 409);
      const createdAt = new Date().toISOString();
      const booking: Booking = {
        id: bookingId, workspaceId: state.workspaceId, propertyId, version: 1,
        status: "confirmed", channelSyncState: manual ? "action_required" :
          manualSync ? "awaiting_manual_sync" :
          operationKey ? "pending" : "not_required",
        channelOperationKey: operationKey, stays: structuredClone(input.stays),
        ...(manual ? { lineChannelBaselineNights: [],
          lineChannelPending: linePendingCells([], cells),
          lineChannelActionRequiredAt: createdAt } : {}),
        guestName: input.guestName, contact: input.contact, notes: input.notes,
        totalCents: input.totalCents, currency: "TWD", bookedAt: input.bookedAt,
        ...(input.roomNightPrices ? { roomNightPrices: structuredClone(input.roomNightPrices) } : {}),
        createdAt, source: input.source,
        sourceKey: input.source === "line" ? `line:${principal.grantId}` : null,
      };
      state.bookings.push(booking);
      if (operationKey) {
        state.operations.push({ key: operationKey, bookingId: booking.id, bookingVersion: booking.version,
          state: "sync_pending", cells: cells.map((cell) => ({ ...cell, desired: "closed" })),
          createdAt: booking.createdAt, verifiedAt: null, providerVersion: null });
        state.fences.push({ key: operationKey, cells, reason: "channel_pending" });
      }
      state.version++;
      const response = makeBookingReceipt(state, booking);
      saveReceipt(state, principal, requestKey, "booking:create", hash, { ...response });
      emit(tx, state, "booking.created", booking, principal, requestKey);
      return response;
    });
  }

  async requestManualChannelSync(principal: Principal, propertyId: string, bookingId: string,
    requestKey: string, expectedBookingVersion: number,
    expectedInventoryVersion: number): Promise<BookingReceipt> {
    uuid(propertyId); uuid(bookingId); uuid(requestKey);
    if (!Number.isSafeInteger(expectedBookingVersion) || expectedBookingVersion < 1 ||
      !Number.isSafeInteger(expectedInventoryVersion) || expectedInventoryVersion < 0)
      reject("INVALID_VERSION");
    const hash = await digest({ action: "channel:manual_sync", bookingId,
      expectedBookingVersion, expectedInventoryVersion });
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "booking:amend", true);
      if (principal.origin !== "os") reject("FORBIDDEN", 403);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response as BookingReceipt;
      if (state.version !== expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      const booking = state.bookings.find((item) => item.id === bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      if (booking.version !== expectedBookingVersion) reject("VERSION_CONFLICT", 409);
      if (!isOsDirectBooking(booking) || booking.status !== "confirmed" ||
        booking.channelSyncState !== "awaiting_manual_sync" ||
        booking.channelOperationKey !== null) reject("CHANNEL_SYNC_NOT_READY", 409);
      if (state.channel.mode !== "owlnest" || !state.channel.ready ||
        state.channel.sourceReadbackEnabled !== true || !state.channel.grantId)
        reject("CHANNEL_SYNC_NOT_READY", 409);
      const cells = nightsFor(booking.stays, state.roomIds);
      const change = booking.osManualRoomChange;
      if (booking.lineOverridePending || state.sourceLinks.some(link => link.bookingId === booking.id && link.diverged))
        reject("SOURCE_AMEND_REQUIRES_REVIEW", 409);
      if (hasConflict(state, cells, booking.id, change ? osChangeFenceKey(booking.id) : undefined))
        reject("ROOM_CONFLICT", 409);
      if (change && !hasVerifiedClosedBaseline(state, booking, change.baseline))
        requireOsStockWindow(state, uniqueNights([...change.baseline, ...cells]));
      const desired: DesiredCell[] = change ? linePendingCells(change.baseline, cells) :
        cells.map(cell => ({ ...cell, desired: "closed" as const }));
      if (!desired.length) reject("CHANNEL_SYNC_NOT_READY", 409);
      if (change) state.fences = state.fences.filter(fence => fence.key !== osChangeFenceKey(booking.id));
      const operationKey = crypto.randomUUID();
      booking.channelOperationKey = operationKey;
      booking.channelSyncState = "pending";
      state.operations.push({ key: operationKey, bookingId, bookingVersion: booking.version,
        state: "sync_pending", cells: desired,
        createdAt: new Date().toISOString(), verifiedAt: null, providerVersion: null,
        ...(!change || !change.baseline.length ?
          { manualInitialClose: true, ownCloseWriteRequired: true } : {}) });
      state.fences.push({ key: operationKey, cells: desired.map(({ roomId, date }) => ({ roomId, date })),
        reason: "channel_pending" });
      state.version++;
      const response = makeBookingReceipt(state, booking);
      saveReceipt(state, principal, requestKey, "booking:amend", hash, { ...response });
      emit(tx, state, "channel.sync_requested", booking, principal, requestKey);
      return response;
    });
  }

  async createHold(principal: Principal, propertyId: string, requestKey: string,
    input: CreateHoldInput): Promise<BookingReceipt> {
    uuid(propertyId); uuid(requestKey);
    verifyCreate({ ...input, source: "os" }, principal);
    if (principal.origin !== "os") reject("FORBIDDEN", 403);
    if (input.totalCents === null || input.totalCents <= 0) reject("HOLD_TOTAL_REQUIRED");
    const hash = await digest({ action: "hold:create", input });
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "hold:write", true);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response as BookingReceipt;
      if (state.channel.mode !== "none") reject("HOLD_CHANNEL_UNIMPLEMENTED", 409);
      if (state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      const cells = nightsFor(input.stays, state.roomIds);
      if (hasConflict(state, cells)) reject("ROOM_CONFLICT", 409);
      const createdAt = new Date().toISOString();
      const booking: Booking = {
        id: crypto.randomUUID(), workspaceId: state.workspaceId, propertyId,
        version: 1, status: "held", channelSyncState: "not_required", channelOperationKey: null,
        stays: structuredClone(input.stays), guestName: input.guestName, contact: input.contact,
        notes: input.notes, totalCents: input.totalCents, currency: "TWD", bookedAt: input.bookedAt,
        createdAt, source: "os", sourceKey: null,
        hold: { schema: 1, scope: "platform_only", startedAt: createdAt,
          expiresAt: new Date(Date.parse(createdAt) + DAY).toISOString(), state: "active" },
        paymentEvents: [],
      };
      state.bookings.push(booking);
      state.version++;
      const response = makeBookingReceipt(state, booking);
      saveReceipt(state, principal, requestKey, "hold:write", hash, { ...response });
      emit(tx, state, "hold.created", booking, principal, requestKey);
      return response;
    });
  }

  async extendHold(principal: Principal, propertyId: string, bookingId: string, requestKey: string,
    input: ExtendHoldInput): Promise<BookingReceipt> {
    uuid(propertyId); uuid(bookingId); uuid(requestKey);
    if (!Number.isSafeInteger(input.expectedBookingVersion) || input.expectedBookingVersion < 1)
      reject("INVALID_VERSION");
    const expiry = timestamp(input.newExpiresAt);
    const hash = await digest({ action: "hold:extend", bookingId, input });
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "hold:write", true);
      if (principal.origin !== "os") reject("FORBIDDEN", 403);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response as BookingReceipt;
      const booking = state.bookings.find((item) => item.id === bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      if (booking.version !== input.expectedBookingVersion) reject("VERSION_CONFLICT", 409);
      if (booking.status !== "held" || booking.hold?.state !== "active" ||
        state.channel.mode !== "none") reject("HOLD_NOT_ACTIVE", 409);
      const now = Date.now();
      if (expiry <= now || expiry <= timestamp(booking.hold.expiresAt) ||
        expiry > now + 366 * DAY) reject("INVALID_HOLD_EXPIRY");
      if (hasConflict(state, nightsFor(booking.stays, state.roomIds), booking.id))
        reject("ROOM_CONFLICT", 409);
      booking.hold.expiresAt = input.newExpiresAt;
      booking.version++;
      const response = makeBookingReceipt(state, booking);
      saveReceipt(state, principal, requestKey, "hold:write", hash, { ...response });
      emit(tx, state, "hold.extended", booking, principal, requestKey);
      return response;
    });
  }

  async convertHold(principal: Principal, propertyId: string, bookingId: string, requestKey: string,
    expectedBookingVersion: number): Promise<BookingReceipt> {
    uuid(propertyId); uuid(bookingId); uuid(requestKey);
    if (!Number.isSafeInteger(expectedBookingVersion) || expectedBookingVersion < 1) reject("INVALID_VERSION");
    const hash = await digest({ action: "hold:convert", bookingId, expectedBookingVersion });
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "hold:write", true);
      if (principal.origin !== "os") reject("FORBIDDEN", 403);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response as BookingReceipt;
      const booking = state.bookings.find((item) => item.id === bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      if (booking.version !== expectedBookingVersion) reject("VERSION_CONFLICT", 409);
      if (booking.status !== "held" || booking.hold?.state !== "active") reject("HOLD_NOT_ACTIVE", 409);
      if (timestamp(booking.hold.expiresAt) <= Date.now()) reject("HOLD_EXPIRED_REVIEW", 409);
      if (netReceived(booking) <= 0) reject("PAYMENT_EVIDENCE_REQUIRED", 409);
      booking.status = "confirmed";
      booking.hold.state = "converted";
      booking.hold.convertedAt = new Date().toISOString();
      booking.version++;
      const response = makeBookingReceipt(state, booking);
      saveReceipt(state, principal, requestKey, "hold:write", hash, { ...response });
      emit(tx, state, "hold.converted", booking, principal, requestKey);
      return response;
    });
  }

  async releaseHold(principal: Principal, propertyId: string, bookingId: string, requestKey: string,
    expectedBookingVersion: number, expectedInventoryVersion: number): Promise<BookingReceipt> {
    uuid(propertyId); uuid(bookingId); uuid(requestKey);
    if (!Number.isSafeInteger(expectedBookingVersion) || expectedBookingVersion < 1 ||
      !Number.isSafeInteger(expectedInventoryVersion) || expectedInventoryVersion < 0) reject("INVALID_VERSION");
    const hash = await digest({ action: "hold:release", bookingId, expectedBookingVersion, expectedInventoryVersion });
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "hold:write", true);
      if (principal.origin !== "os") reject("FORBIDDEN", 403);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response as BookingReceipt;
      if (state.version !== expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      const booking = state.bookings.find((item) => item.id === bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      if (booking.version !== expectedBookingVersion) reject("VERSION_CONFLICT", 409);
      if (booking.status !== "held" || booking.hold?.state !== "active") reject("HOLD_NOT_ACTIVE", 409);
      if (netReceived(booking) !== 0) reject("CANCELLATION_REQUIRES_SETTLEMENT", 409);
      booking.status = "cancelled";
      booking.hold.state = "released";
      booking.hold.releasedAt = new Date().toISOString();
      booking.version++;
      state.version++;
      const response = makeBookingReceipt(state, booking);
      saveReceipt(state, principal, requestKey, "hold:write", hash, { ...response });
      emit(tx, state, "hold.released", booking, principal, requestKey);
      return response;
    });
  }

  async previewLineAction(principal: Principal, propertyId: string, bookingId: string,
    action: "amend" | "cancel", input: AmendBookingInput | {
      expectedBookingVersion: number; expectedInventoryVersion: number; channelPolicy?: "manual";
    }): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(bookingId);
    if (action === "amend") verifyAmend(input as AmendBookingInput);
    else if (!Number.isSafeInteger(input.expectedBookingVersion) || input.expectedBookingVersion < 1 ||
      !Number.isSafeInteger(input.expectedInventoryVersion) || input.expectedInventoryVersion < 0)
      reject("INVALID_VERSION");
    const manual = lineManualPolicy(principal, input.channelPolicy);
    if (principal.origin !== "line" || !this.linePreviewSecret) reject("LINE_PREVIEW_UNAVAILABLE", 503);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, action === "amend" ? "booking:amend" : "booking:cancel", true);
    const booking = state.bookings.find((item) => item.id === bookingId);
    if (!booking) reject("BOOKING_NOT_FOUND", 404);
    requireLineMutation(principal, state, booking, manual);
    requireManualBaseline(booking, manual, action === "cancel" ||
      action === "amend" && "stays" in (input as AmendBookingInput).changes);
    if ((!manual && state.version !== input.expectedInventoryVersion) ||
      booking.version !== input.expectedBookingVersion) reject("VERSION_CONFLICT", 409);
    if (action === "amend" && "stays" in (input as AmendBookingInput).changes) {
      const next = nightsFor((input as AmendBookingInput).changes.stays!, state.roomIds);
      requireLineStockWindow(state, next);
      if (hasConflict(state, next, bookingId,
        manual ? linePendingFenceKey(bookingId) : undefined)) reject("ROOM_CONFLICT", 409);
    }
    if (action === "amend") requireAmendFields(principal, (input as AmendBookingInput).changes);
    if (action === "amend" && "roomNightPrices" in (input as AmendBookingInput).changes) {
      const changes = (input as AmendBookingInput).changes;
      const cells = nightsFor(changes.stays ?? booking.stays, state.roomIds);
      if (!exactNightPrices(changes.roomNightPrices, cells,
        changes.totalCents !== undefined ? changes.totalCents : booking.totalCents))
        reject("INVALID_NIGHT_PRICES");
    }
    const hash = await digest({ action: `booking:${action}`, bookingId,
      ...(action === "amend" ? { input } : input) });
    const current = nightsFor(booking.stays, state.roomIds);
    const next = action === "amend" && "stays" in (input as AmendBookingInput).changes ?
      nightsFor((input as AmendBookingInput).changes.stays!, state.roomIds) : current;
    const scopeHash = manual ? await targetHash(state,
      uniqueNights([...current, ...next]), bookingId) : null;
    const signed = await signLinePreview(this.linePreviewSecret, principal, propertyId,
      input.expectedInventoryVersion, hash, action, bookingId, booking.version, scopeHash);
    return { propertyId, bookingId, action, bookingVersion: booking.version,
      inventoryVersion: input.expectedInventoryVersion, authorityEpoch: state.authorityEpoch,
      expiresAt: signed.expiresAt, previewToken: signed.token,
      channelSyncState: "preview_only",
      ...(manual ? { observedInventoryVersion: state.version } : {}) };
  }

  async amendBooking(principal: Principal, propertyId: string, bookingId: string, requestKey: string,
    input: AmendBookingInput, linePreviewToken: string | null = null): Promise<BookingReceipt> {
    uuid(propertyId); uuid(bookingId); uuid(requestKey); verifyAmend(input);
    const osManual = principal.origin === "os" && input.channelPolicy === "manual";
    const manual = osManual ? false : lineManualPolicy(principal, input.channelPolicy);
    const hash = await digest({ action: "booking:amend", bookingId, input });
    const linePreviewExpiry = principal.origin === "line" && this.linePreviewSecret !== null && !manual ?
      await verifyLinePreview(this.linePreviewSecret, linePreviewToken, principal, propertyId,
        input.expectedInventoryVersion, hash, "amend", bookingId,
        input.expectedBookingVersion) : null;
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "booking:amend", true);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response as BookingReceipt;
      if (principal.origin !== "os" && principal.origin !== "line") reject("FORBIDDEN", 403);
      if (!manual && state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      const booking = state.bookings.find((item) => item.id === bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      if (principal.origin === "line") {
        const current = nightsFor(booking.stays, state.roomIds);
        const next = "stays" in input.changes ? nightsFor(input.changes.stays!, state.roomIds) : current;
        const expiry = manual && this.linePreviewSecret ?
          verifyLinePreview(this.linePreviewSecret, linePreviewToken, principal,
            propertyId, input.expectedInventoryVersion, hash, "amend", bookingId,
            input.expectedBookingVersion,
            targetHash(state, uniqueNights([...current, ...next]), bookingId)) : linePreviewExpiry;
        if (expiry === null || Date.now() >= expiry) reject("LINE_PREVIEW_REQUIRED", 409);
      }
      if (booking.version !== input.expectedBookingVersion) reject("VERSION_CONFLICT", 409);
      if (booking.status === "cancelled") reject("ORDER_CANCELLED", 409);
      if (principal.origin === "line") requireLineMutation(principal, state, booking, manual);
      requireManualBaseline(booking, manual, "stays" in input.changes);
      const osDirect = principal.origin === "os" && isOsDirectBooking(booking);
      if (principal.origin === "os" && booking.source !== "external" && !osDirect)
        reject("FORBIDDEN", 403);
      if (osDirect && (booking.status !== "confirmed" || booking.lineOverridePending ||
        state.sourceLinks.some(link => link.bookingId === booking.id && link.diverged)))
        reject("SOURCE_AMEND_REQUIRES_REVIEW", 409);
      if (osManual && !osDirect) reject("FORBIDDEN", 403);
      const externalNameCorrection = principal.origin === "os" && booking.source === "external" && !osDirect;
      if (externalNameCorrection) {
        const linked = state.sourceLinks.filter((link) => link.bookingId === booking.id);
        if (booking.status !== "confirmed" ||
          !["verified", "not_required"].includes(booking.channelSyncState) ||
          booking.lineOverridePending === true || linked.length !== 1 ||
          linked[0].diverged || linked[0].lastAppliedBookingVersion !== booking.version ||
          Object.keys(input.changes).length !== 1 ||
          typeof input.changes.guestName !== "string" ||
          !input.changes.guestName.trim() ||
          input.changes.guestName.trim() === booking.guestName || !input.reason?.trim())
          reject("SOURCE_AMEND_REQUIRES_REVIEW", 409);
      }
      const baselineReadbackNeeded = principal.origin === "line" &&
        booking.channelSyncState === "not_required" && !manual;
      requireAmendFields(principal, input.changes);
      const originalPrices = bookingNightPrices(booking);
      let roomNightsChanged = false;
      const current = nightsFor(booking.stays, state.roomIds);
      let next: Night[] = current;
      const unverifiableSourceEdit = principal.origin === "line" &&
        (("contact" in input.changes && input.changes.contact !== booking.contact) ||
          ("notes" in input.changes && input.changes.notes !== booking.notes) ||
          ("roomNightPrices" in input.changes));
      if ("roomNightPrices" in input.changes) {
        const pricedCells = nightsFor(input.changes.stays ?? booking.stays, state.roomIds);
        if (!exactNightPrices(input.changes.roomNightPrices, pricedCells,
          input.changes.totalCents !== undefined ? input.changes.totalCents : booking.totalCents))
          reject("INVALID_NIGHT_PRICES");
      }
      if ("stays" in input.changes) {
        next = nightsFor(input.changes.stays!, state.roomIds);
        if (principal.origin === "line") requireLineStockWindow(state, next);
        roomNightsChanged = changedNights(current, next);
        if (roomNightsChanged && state.channel.mode !== "none" && principal.origin !== "line" &&
          !(principal.origin === "os" && state.channel.mode === "owlnest"))
          reject("CHANNEL_AMENDMENT_UNIMPLEMENTED", 409);
        if (roomNightsChanged && state.channel.mode === "owlnest" && principal.origin === "os") {
          if (!osDirect || !(osManual ? ["verified", "not_required", "awaiting_manual_sync", "action_required"] :
            ["verified", "awaiting_manual_sync"]).includes(
            booking.channelSyncState)) reject("CHANNEL_AMENDMENT_NOT_READY", 409);
          if (!osManual && booking.channelSyncState === "verified") {
            if (!state.channel.ready || state.channel.sourceReadbackEnabled !== true ||
              !state.channel.grantId || !state.channel.stockObservedFrom ||
              !state.channel.stockObservedThrough)
              reject("CHANNEL_AMENDMENT_NOT_READY", 409);
            requireOsStockWindow(state, uniqueNights([...current, ...next]));
          }
        }
        if (roomNightsChanged && hasConflict(state, next, booking.id,
          (manual || osManual && booking.lineChannelBaselineNights !== undefined) ? linePendingFenceKey(booking.id) : booking.osManualRoomChange ?
            osChangeFenceKey(booking.id) : undefined)) reject("ROOM_CONFLICT", 409);
        booking.stays = structuredClone(input.changes.stays!);
      }
      if ("guestName" in input.changes) booking.guestName = externalNameCorrection ?
        input.changes.guestName!.trim() : input.changes.guestName!;
      if ("contact" in input.changes) booking.contact = input.changes.contact!;
      if ("notes" in input.changes) booking.notes = input.changes.notes!;
      if ("bookedAt" in input.changes) booking.bookedAt = input.changes.bookedAt!;
      if ("totalCents" in input.changes) booking.totalCents = input.changes.totalCents!;
      if ("roomNightPrices" in input.changes)
        booking.roomNightPrices = structuredClone(input.changes.roomNightPrices!);
      else if ("stays" in input.changes || "totalCents" in input.changes)
        delete booking.roomNightPrices;
      if (osDirect && originalPrices && !("roomNightPrices" in input.changes) &&
        !("stays" in input.changes) && !("totalCents" in input.changes))
        booking.roomNightPrices = originalPrices;
      booking.version++;
      if (osDirect && booking.source === "external") {
        booking.osDirectOverride = true;
        for (const link of state.sourceLinks) if (link.bookingId === booking.id)
          link.lastAppliedBookingVersion = booking.version;
      }
      if (principal.origin === "line") flagExternalSourceReview(state, booking, current, next,
        unverifiableSourceEdit);
      if (externalNameCorrection) flagExternalSourceReview(state, booking, current, next);
      if (osManual && state.channel.mode === "owlnest" && roomNightsChanged &&
        (booking.channelSyncState !== "awaiting_manual_sync" || booking.osManualRoomChange)) {
        saveOsRoomChange(state, booking, current, next);
      } else if (principal.origin === "line" && manual &&
        (roomNightsChanged || booking.channelSyncState === "action_required")) {
        updateLinePending(state, booking, next);
      } else if (state.channel.mode === "owlnest" && roomNightsChanged &&
        booking.channelSyncState !== "awaiting_manual_sync" ||
        principal.origin === "line" && baselineReadbackNeeded) {
        const before = new Set(current.map(keyOf)), after = new Set(next.map(keyOf));
        const cells: DesiredCell[] = baselineReadbackNeeded && !roomNightsChanged ?
          next.map((cell) => ({ ...cell, desired: "closed" as const })) : [
          ...next.filter((cell) => baselineReadbackNeeded || !before.has(keyOf(cell)))
            .map((cell) => ({ ...cell, desired: "closed" as const })),
          ...current.filter((cell) => !after.has(keyOf(cell))).map((cell) => ({ ...cell,
            desired: booking.source === "external" ? "closed" as const : "open" as const })),
          ];
        const operationKey = crypto.randomUUID();
        booking.channelOperationKey = operationKey;
        booking.channelSyncState = "pending";
        state.operations.push({ key: operationKey, bookingId, bookingVersion: booking.version,
          state: "sync_pending", cells, createdAt: new Date().toISOString(),
          verifiedAt: null, providerVersion: null });
        state.fences.push({ key: operationKey, cells: cells.map(({ roomId, date }) => ({ roomId, date })),
          reason: "channel_pending" });
      }
      if (roomNightsChanged || baselineReadbackNeeded) state.version++;
      const response = makeBookingReceipt(state, booking);
      saveReceipt(state, principal, requestKey, "booking:amend", hash, { ...response });
      emit(tx, state, "booking.amended", booking, principal, requestKey, input.reason);
      return response;
    });
  }

  async recordPaymentEvent(principal: Principal, propertyId: string, bookingId: string,
    requestKey: string, input: PaymentEventInput): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(bookingId); uuid(requestKey); uuid(input.eventId);
    if (!Number.isSafeInteger(input.expectedBookingVersion) || input.expectedBookingVersion < 1)
      reject("INVALID_VERSION");
    if (input.kind !== "received" && input.kind !== "refunded") reject("INVALID_INPUT");
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) reject("INVALID_AMOUNT");
    if (input.currency !== "TWD") reject("INVALID_CURRENCY");
    const evidence = nonempty(input.evidenceRef, 256).trim().normalize("NFKC").toLowerCase();
    if (!evidence) reject("INVALID_INPUT");
    if (timestamp(input.occurredAt) > Date.now()) reject("FUTURE_RECEIPT");
    if (input.method !== undefined && !["cash", "bank_transfer", "credit_card", "other"].includes(input.method))
      reject("INVALID_PAYMENT_METHOD");
    if (input.refundOfEventId !== undefined) {
      uuid(input.refundOfEventId);
      if (input.kind !== "refunded") reject("INVALID_REFUND_REFERENCE");
    }
    const hash = await digest({ action: "payment:write", bookingId, input });
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "payment:write", true);
      if (principal.origin !== "os" && principal.origin !== "finance") reject("FORBIDDEN", 403);
      if (!principal.fields.includes("money")) reject("FORBIDDEN", 403);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response;
      const booking = state.bookings.find((item) => item.id === bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      if (booking.version !== input.expectedBookingVersion) reject("VERSION_CONFLICT", 409);
      if (state.bookings.some((item) => (item.paymentEvents ?? []).some((event) => event.id === input.eventId)))
        reject("PAYMENT_EVENT_EXISTS", 409);
      if ((booking.paymentEvents ?? []).some((event) => event.kind === input.kind &&
        event.evidenceRef.trim().normalize("NFKC").toLowerCase() === evidence))
        reject("PAYMENT_EVIDENCE_EXISTS", 409);
      if (input.kind === "refunded" && input.amountCents > netReceived(booking))
        reject("REFUND_EXCEEDS_RECEIVED", 409);
      if (booking.source === "os" && !booking.hold && input.kind === "received" &&
        (booking.status !== "confirmed" || booking.totalCents === null ||
          input.amountCents > booking.totalCents - netReceived(booking)))
        reject("RECEIPT_EXCEEDS_DUE", 409);
      if (input.refundOfEventId !== undefined) {
        const original = (booking.paymentEvents ?? []).find(event => event.id === input.refundOfEventId && event.kind === "received");
        if (!original || timestamp(input.occurredAt) < timestamp(original.occurredAt))
          reject("INVALID_REFUND_REFERENCE");
        const refunded = (booking.paymentEvents ?? []).filter(event => event.kind === "refunded" &&
          event.refundOfEventId === original.id).reduce((sum, event) => sum + event.amountCents, 0);
        if (input.amountCents > original.amountCents - refunded) reject("REFUND_EXCEEDS_RECEIVED", 409);
      }
      if ((booking.paymentEvents ?? []).length >= 500) reject("PAYMENT_EVENT_LIMIT", 409);
      booking.paymentEvents ??= [];
      booking.paymentEvents.push({ id: input.eventId, kind: input.kind, amountCents: input.amountCents,
        currency: input.currency, evidenceRef: input.evidenceRef, occurredAt: input.occurredAt,
        recordedAt: new Date().toISOString(), actorId: principal.subjectId,
        ...(input.method ? { method: input.method } : {}),
        ...(input.refundOfEventId ? { refundOfEventId: input.refundOfEventId } : {}) });
      paymentTotals(booking);
      if (booking.hold?.state === "released" && booking.status === "cancelled") {
        // Late money is a finance fact, not permission to reclaim released nights.
        booking.hold.latePaymentReview = netReceived(booking) > 0;
      }
      booking.version++;
      const response = { bookingId, bookingVersion: booking.version, inventoryVersion: state.version,
        paymentEventId: input.eventId, netReceivedCents: netReceived(booking),
        refundReviewRequired: booking.status === "cancelled" && netReceived(booking) > 0 };
      saveReceipt(state, principal, requestKey, "payment:write", hash, response);
      emit(tx, state, "payment.recorded", booking, principal, requestKey);
      return response;
    });
  }

  async getBooking(principal: Principal, propertyId: string, bookingId: string): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(bookingId);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "booking:read");
    if (principal.origin === "source" || principal.origin === "channel") reject("FORBIDDEN", 403);
    if (principal.origin === "website" &&
      (!principal.bindingId || principal.bindingId !== state.channel.websiteBindingId))
      reject("FORBIDDEN", 403);
    if ((principal.origin === "guest" || principal.origin === "website") &&
      principal.bookingIdScope !== bookingId) reject("FORBIDDEN", 403);
    const booking = state.bookings.find((item) => item.id === bookingId);
    if (!booking) reject("BOOKING_NOT_FOUND", 404);
    if (principal.origin === "line" && !lineManagesAll(principal) &&
      (booking.source !== "line" || booking.sourceKey !== `line:${principal.grantId}`))
      reject("BOOKING_NOT_FOUND", 404);
    const projection = publicBooking(booking, principal, state);
    if (principal.origin === "os" && principal.fields.includes("money"))
      projection.paymentEvents = (booking.paymentEvents ?? []).map((event) => ({ ...event }));
    return principal.origin === "line" ? { ...projection,
      inventoryVersion: state.version, authorityEpoch: state.authorityEpoch,
      readOnly: state.readOnly === true,
      lineScope: lineScope(principal) } : projection;
  }

  async listBookings(principal: Principal, propertyId: string, options: {
    limit: number; cursor: string | null; status: Booking["status"] | null;
    from: string | null; to: string | null; attention?: boolean;
  }): Promise<Record<string, unknown>> {
    uuid(propertyId);
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) reject("INVALID_LIMIT");
    if (options.status !== null && !["held", "confirmed", "cancelled"].includes(options.status))
      reject("INVALID_STATUS");
    if ((options.from === null) !== (options.to === null)) reject("INVALID_DATE_RANGE");
    if (options.from !== null && options.to !== null && dayNumber(options.to) <= dayNumber(options.from))
      reject("INVALID_DATE_RANGE");
    let seek: { createdAt: string; id: string } | null = null;
    if (options.cursor !== null) {
      try {
        if (!/^[A-Za-z0-9_-]{1,512}$/.test(options.cursor)) throw Error();
        const encoded = options.cursor.replace(/-/g, "+").replace(/_/g, "/");
        const parsed = JSON.parse(atob(encoded));
        if (parsed.v !== 1 || parsed.propertyId !== propertyId || parsed.status !== options.status ||
          parsed.from !== options.from || parsed.to !== options.to ||
          Boolean(parsed.attention) !== Boolean(options.attention) ||
          typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") throw Error();
        timestamp(parsed.createdAt); uuid(parsed.id);
        seek = { createdAt: parsed.createdAt, id: parsed.id };
      } catch { reject("INVALID_CURSOR"); }
    }
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "booking:read");
    if (principal.origin !== "os" && principal.origin !== "line") reject("FORBIDDEN", 403);
    if (options.attention && principal.origin !== "os") reject("FORBIDDEN", 403);
    const result = state.bookings.filter((booking) =>
      (principal.origin !== "line" || lineManagesAll(principal) || booking.source === "line" &&
        booking.sourceKey === `line:${principal.grantId}`) &&
      (!options.attention ||
        ["action_required", "pending", "review_required"].includes(booking.channelSyncState)) &&
      (options.status === null || booking.status === options.status) &&
      (options.from === null || options.to === null || booking.stays.some((stay) =>
        stay.checkIn < options.to! && stay.checkOut > options.from!)) &&
      (!seek || booking.createdAt > seek.createdAt ||
        (booking.createdAt === seek.createdAt && booking.id > seek.id)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const page = result.slice(0, options.limit);
    const last = page.at(-1);
    const nextCursor = result.length > options.limit && last ?
      btoa(JSON.stringify({ v: 1, propertyId, status: options.status, from: options.from,
        attention: Boolean(options.attention),
        to: options.to, createdAt: last.createdAt, id: last.id }))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
    const imported = state.sweetfunImport ?? state.offlandImport;
    const snapshot = state.readOnly === true && state.authorityEpoch === 0 &&
      imported && typeof imported.capturedAt === "string" &&
      typeof imported.sourceHash === "string"
      ? { capturedAt: imported.capturedAt,
        sourceHash: imported.sourceHash } : null;
    return { propertyId, inventoryVersion: state.version,
      authorityEpoch: state.authorityEpoch, readOnly: state.readOnly === true,
      snapshot, bookings: page.map((booking) => publicBooking(booking, principal, state)), nextCursor,
      ...(principal.origin === "line" ? { lineScope: lineScope(principal) } : {}) };
  }

  async listEvents(principal: Principal, propertyId: string, after: number,
    limit: number): Promise<Record<string, unknown>> {
    uuid(propertyId);
    if (!Number.isSafeInteger(after) || after < 0) reject("INVALID_CURSOR");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject("INVALID_LIMIT");
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "event:read");
    if (principal.origin !== "os" && principal.origin !== "service" && principal.origin !== "finance")
      reject("FORBIDDEN", 403);
    const events = await this.repository.events(propertyId, after, limit + 1);
    const page = events.slice(0, limit);
    return { propertyId, events: page, nextCursor: page.at(-1)?.cursor ?? after,
      hasMore: events.length > limit };
  }

  /** One authoritative read: payments change booking versions, not inventoryVersion. */
  async directFinanceSnapshot(principal: Principal, propertyId: string): Promise<Record<string, unknown>> {
    uuid(propertyId);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "finance:ledger");
    if (principal.origin !== "os" || !principal.fields.includes("money")) reject("FORBIDDEN", 403);
    if (principal.authorityEpoch !== state.authorityEpoch) reject("AUTHORITY_MOVED", 409);
    const bookings = state.bookings.filter(booking => booking.source === "os")
      .sort((a, b) => a.id.localeCompare(b.id)).map(booking => ({
        id: booking.id, propertyId, workspaceId: state.workspaceId, source: "os",
        version: booking.version, status: booking.status, stays: structuredClone(booking.stays),
        totalCents: booking.totalCents, currency: booking.currency,
        paymentSummary: paymentTotals(booking),
        paymentEvents: structuredClone(booking.paymentEvents ?? []),
      }));
    const eventIds = bookings.flatMap(booking => booking.paymentEvents.map(event => event.id));
    if (new Set(eventIds).size !== eventIds.length) reject("PAYMENT_INTEGRITY_CONFLICT", 409);
    const snapshot = { schema: 1, propertyId, workspaceId: state.workspaceId,
      authorityEpoch: state.authorityEpoch, inventoryVersion: state.version, bookings };
    const encoded = JSON.stringify(snapshot);
    if (bookings.length > 5000 || new TextEncoder().encode(encoded).byteLength > 2_000_000)
      reject("READ_CAPACITY_LIMIT", 409);
    return { ...snapshot, revision: createHash("sha256").update(encoded, "utf8").digest("hex") };
  }

  async financeLedger(principal: Principal, propertyId: string, options: {
    limit: number; cursor: string | null;
  }): Promise<Record<string, unknown>> {
    uuid(propertyId);
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)
      reject("INVALID_LIMIT");
    let seek: { recordedAt: string; eventId: string } | null = null;
    if (options.cursor !== null) {
      try {
        if (!/^[A-Za-z0-9_-]{1,512}$/.test(options.cursor)) throw Error();
        const decoded = options.cursor.replace(/-/g, "+").replace(/_/g, "/");
        const parsed = JSON.parse(atob(decoded));
        if (parsed.v !== 1 || parsed.propertyId !== propertyId) throw Error();
        timestamp(parsed.recordedAt); uuid(parsed.eventId);
        seek = { recordedAt: parsed.recordedAt, eventId: parsed.eventId };
      } catch { reject("INVALID_CURSOR"); }
    }
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "finance:ledger");
    if ((principal.origin !== "finance" && principal.origin !== "os") ||
      !principal.fields.includes("money")) reject("FORBIDDEN", 403);
    const rows = [];
    for (const booking of state.bookings) for (const event of booking.paymentEvents ?? []) {
      rows.push({ bookingId: booking.id, eventId: event.id, kind: event.kind,
        amountCents: event.amountCents, currency: event.currency,
        evidenceRef: event.evidenceRef, occurredAt: event.occurredAt,
        recordedAt: event.recordedAt });
      if (rows.length > 100_000) reject("READ_CAPACITY_LIMIT", 409);
    }
    if (new Set(rows.map((row) => row.eventId)).size !== rows.length)
      reject("PAYMENT_INTEGRITY_CONFLICT", 409);
    const filtered = rows.filter((row) => !seek || row.recordedAt > seek.recordedAt ||
      (row.recordedAt === seek.recordedAt && row.eventId > seek.eventId))
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) ||
        a.eventId.localeCompare(b.eventId));
    const page = filtered.slice(0, options.limit);
    const last = page.at(-1);
    const nextCursor = filtered.length > options.limit && last ?
      btoa(JSON.stringify({ v: 1, propertyId, recordedAt: last.recordedAt,
        eventId: last.eventId })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
    return { propertyId, events: page, nextCursor };
  }

  async availability(principal: Principal, propertyId: string, from: string, to: string): Promise<Record<string, unknown>> {
    uuid(propertyId);
    const first = dayNumber(from), end = dayNumber(to);
    if (end <= first || end - first > MAX_READ_DAYS) reject("INVALID_DATE_RANGE");
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "booking:read");
    if (principal.origin !== "os" && principal.origin !== "service" &&
      principal.origin !== "website" && principal.origin !== "line")
      reject("FORBIDDEN", 403);
    if (principal.origin === "website" &&
      (!principal.bindingId || principal.bindingId !== state.channel.websiteBindingId))
      reject("FORBIDDEN", 403);
    const { occupied, blocked } = readInventoryIndex(state, first, end);
    const cells = [];
    for (const roomId of state.roomIds) for (let day = first; day < end; day++) {
      const cell = { roomId, date: new Date(day * DAY).toISOString().slice(0, 10) };
      const status = occupied.get(keyOf(cell));
      cells.push({ ...cell, state: status ? (status === "held" ? "held" : "sold") :
        blocked.has(keyOf(cell)) ? "blocked" : "unsold",
        saleReady: false,
        ...(lineManagesAll(principal) ? { manualBlocked:
          state.manualBlocks.some((item) => keyOf(item) === keyOf(cell)) } : {}) });
    }
    return { propertyId, inventoryVersion: state.version, authorityEpoch: state.authorityEpoch,
      readOnly: state.readOnly === true, cells,
      ...(principal.origin === "line" ? { lineScope: lineScope(principal) } : {}),
      note: "unsold means no local occupancy; it does not prove external channel stock" };
  }

  async lineCapabilities(principal: Principal, propertyId: string): Promise<Record<string, unknown>> {
    uuid(propertyId);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "booking:read");
    if (principal.origin !== "line" || !principal.grantId) reject("FORBIDDEN", 403);
    return { propertyId, inventoryVersion: state.version,
      authorityEpoch: state.authorityEpoch, readOnly: state.readOnly === true,
      lineScope: lineScope(principal),
      channelReady: state.channel.mode === "owlnest" && state.channel.ready === true &&
        state.channel.sourceReadbackEnabled === true && Boolean(state.channel.grantId),
      stockObservedThrough: state.channel.stockObservedThrough ?? null,
      canCreate: principal.actions.includes("booking:create"),
      canAmend: lineManagesAll(principal) && principal.actions.includes("booking:amend"),
      canCancel: lineManagesAll(principal) && principal.actions.includes("booking:cancel"),
      canInventory: lineManagesAll(principal) && principal.actions.includes("inventory:write"),
      canManualChannel: lineManagesAll(principal) && principal.actions.includes("inventory:write") };
  }

  async previewLineChannelAction(principal: Principal, propertyId: string, bookingId: string,
    input: LineChannelActionInput): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(bookingId);
    const cells = verifyLineChannelActionInput(input);
    if (principal.origin !== "line" || !this.linePreviewSecret)
      reject("LINE_PREVIEW_UNAVAILABLE", 503);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    const booking = state.bookings.find((item) => item.id === bookingId);
    if (!booking) reject("BOOKING_NOT_FOUND", 404);
    requireLineChannelAction(principal, state, booking, input, cells);
    const hash = await digest({ action: "channel:request", bookingId, input });
    const signed = await signLinePreview(this.linePreviewSecret, principal, propertyId,
      input.expectedInventoryVersion, hash, "channel-action", bookingId, booking.version,
      await targetHash(state, cells, bookingId));
    return { propertyId, bookingId, bookingVersion: booking.version,
      inventoryVersion: input.expectedInventoryVersion, authorityEpoch: state.authorityEpoch,
      desired: input.desired, cells, previewToken: signed.token,
      expiresAt: signed.expiresAt, channelSyncState: "preview_only" };
  }

  async requestLineChannelAction(principal: Principal, propertyId: string, bookingId: string,
    requestKey: string, input: LineChannelActionInput,
    linePreviewToken: string | null): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(bookingId); uuid(requestKey);
    const cells = verifyLineChannelActionInput(input);
    if (principal.origin !== "line" || !this.linePreviewSecret)
      reject("LINE_PREVIEW_UNAVAILABLE", 503);
    const hash = await digest({ action: "channel:request", bookingId, input });
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "inventory:write", true);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response;
      const booking = state.bookings.find((item) => item.id === bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      const expiry = verifyLinePreview(this.linePreviewSecret!, linePreviewToken, principal,
        propertyId, input.expectedInventoryVersion, hash, "channel-action", bookingId,
        input.expectedBookingVersion, targetHash(state, cells, bookingId));
      if (expiry === null || Date.now() >= expiry) reject("LINE_PREVIEW_REQUIRED", 409);
      requireLineChannelAction(principal, state, booking, input, cells);
      if (state.operations.some((item) => item.key === requestKey))
        reject("OPERATION_ID_CONFLICT", 409);
      const operationKey = requestKey;
      const createdAt = new Date().toISOString();
      state.operations.push({ key: operationKey, bookingId, bookingVersion: booking.version,
        state: "sync_pending", cells: cells.map((cell) => ({ ...cell,
          desired: input.desired })), createdAt, verifiedAt: null, providerVersion: null,
        lineGrantId: principal.grantId, lineActorId: principal.subjectId,
        ownCloseWriteRequired: input.desired === "closed" });
      // Swap the booking's action-required fence for the operation fence in
      // the same transaction. The former nights never become saleable.
      if (input.desired === "open")
        state.fences = state.fences.filter((fence) => fence.key !== linePendingFenceKey(booking.id));
      state.fences.push({ key: operationKey, cells, reason: "channel_pending" });
      booking.channelOperationKey = operationKey;
      booking.channelSyncState = "pending";
      state.version++;
      const response = { propertyId, bookingId, bookingVersion: booking.version,
        inventoryVersion: state.version, operationKey, operationState: "sync_pending",
        desired: input.desired, cells };
      saveReceipt(state, principal, requestKey, "inventory:write", hash, response);
      emit(tx, state, "channel.requested", booking, principal, requestKey);
      return response;
    });
  }

  async lineChannelAction(principal: Principal, propertyId: string,
    operationKey: string): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(operationKey);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "inventory:write");
    if (!lineManagesAll(principal) || !principal.grantId) reject("FORBIDDEN", 403);
    const operation = state.operations.find((item) => item.key === operationKey);
    if (!operation || operation.lineGrantId !== principal.grantId)
      reject("OPERATION_NOT_FOUND", 404);
    return { propertyId, operationKey, bookingId: operation.bookingId,
      bookingVersion: operation.bookingVersion, state: operation.state,
      cells: operation.cells, verifiedAt: operation.verifiedAt,
      providerVersion: operation.providerVersion };
  }

  async previewLineInventory(principal: Principal, propertyId: string,
    input: LineInventoryInput): Promise<Record<string, unknown>> {
    uuid(propertyId); verifyLineInventoryInput(input);
    if (principal.origin !== "line" || !this.linePreviewSecret)
      reject("LINE_PREVIEW_UNAVAILABLE", 503);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    requireLineInventory(principal, state, input);
    if (state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
    const hash = await digest({ action: "inventory:write", input });
    const signed = await signLinePreview(this.linePreviewSecret, principal, propertyId,
      state.version, hash, "inventory");
    return { propertyId, roomId: input.roomId, date: input.date,
      desired: input.desired, inventoryVersion: state.version,
      authorityEpoch: state.authorityEpoch, expiresAt: signed.expiresAt,
      previewToken: signed.token, channelSyncState: "preview_only" };
  }

  async setLineInventory(principal: Principal, propertyId: string, requestKey: string,
    input: LineInventoryInput, linePreviewToken: string | null): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(requestKey); verifyLineInventoryInput(input);
    const hash = await digest({ action: "inventory:write", input });
    const expiry = principal.origin === "line" && this.linePreviewSecret !== null ?
      await verifyLinePreview(this.linePreviewSecret, linePreviewToken, principal, propertyId,
        input.expectedInventoryVersion, hash, "inventory") : null;
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "inventory:write", true);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response;
      if (expiry === null || Date.now() >= expiry) reject("LINE_PREVIEW_REQUIRED", 409);
      if (state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      const cell = requireLineInventory(principal, state, input);
      if (input.desired === "closed") state.manualBlocks.push(cell);
      else state.manualBlocks = state.manualBlocks.filter((item) => keyOf(item) !== keyOf(cell));
      const operationKey = crypto.randomUUID();
      state.operations.push({ key: operationKey, bookingId: null, bookingVersion: 0,
        state: "sync_pending", cells: [{ ...cell, desired: input.desired }],
        createdAt: new Date().toISOString(), verifiedAt: null, providerVersion: null });
      state.fences.push({ key: operationKey, cells: [cell], reason: "channel_pending" });
      state.version++;
      const response = { propertyId, roomId: cell.roomId, date: cell.date,
        desired: input.desired, inventoryVersion: state.version,
        operationState: "sync_pending", operationKey };
      saveReceipt(state, principal, requestKey, "inventory:write", hash, response);
      emit(tx, state, input.desired === "closed" ? "inventory.blocked" : "inventory.opened",
        null, principal, requestKey);
      return response;
    });
  }

  async previewLineInventoryBatch(principal: Principal, propertyId: string,
    input: LineInventoryBatchInput): Promise<Record<string, unknown>> {
    uuid(propertyId); const cells = verifyLineInventoryBatchInput(input);
    if (principal.origin !== "line" || !this.linePreviewSecret)
      reject("LINE_PREVIEW_UNAVAILABLE", 503);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    if (state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
    for (const cell of cells) requireLineInventory(principal, state, {
      ...cell, desired: input.desired, expectedInventoryVersion: input.expectedInventoryVersion });
    const hash = await digest({ action: "inventory:batch-write", input });
    const signed = await signLinePreview(this.linePreviewSecret, principal, propertyId,
      state.version, hash, "inventory-batch");
    return { propertyId, cells, desired: input.desired,
      inventoryVersion: state.version, authorityEpoch: state.authorityEpoch,
      expiresAt: signed.expiresAt, previewToken: signed.token,
      channelSyncState: "preview_only" };
  }

  async setLineInventoryBatch(principal: Principal, propertyId: string, requestKey: string,
    input: LineInventoryBatchInput, linePreviewToken: string | null): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(requestKey); const cells = verifyLineInventoryBatchInput(input);
    if (principal.origin !== "line" || !this.linePreviewSecret)
      reject("LINE_PREVIEW_UNAVAILABLE", 503);
    const hash = await digest({ action: "inventory:batch-write", input });
    const expiry = await verifyLinePreview(this.linePreviewSecret, linePreviewToken, principal,
      propertyId, input.expectedInventoryVersion, hash, "inventory-batch");
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "inventory:write", true);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response;
      if (expiry === null || Date.now() >= expiry) reject("LINE_PREVIEW_REQUIRED", 409);
      if (state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      // Check the entire batch before changing a single manual block.
      for (const cell of cells) requireLineInventory(principal, state, {
        ...cell, desired: input.desired, expectedInventoryVersion: input.expectedInventoryVersion });
      const selected = new Set(cells.map(keyOf));
      if (input.desired === "closed") state.manualBlocks.push(...cells);
      else state.manualBlocks = state.manualBlocks.filter((item) => !selected.has(keyOf(item)));
      const operationKey = crypto.randomUUID();
      state.operations.push({ key: operationKey, bookingId: null, bookingVersion: 0,
        state: "sync_pending", cells: cells.map((cell) => ({ ...cell, desired: input.desired })),
        createdAt: new Date().toISOString(), verifiedAt: null, providerVersion: null });
      state.fences.push({ key: operationKey, cells, reason: "channel_pending" });
      state.version++;
      const response = { propertyId, cells, desired: input.desired,
        inventoryVersion: state.version, operationState: "sync_pending", operationKey };
      saveReceipt(state, principal, requestKey, "inventory:write", hash, response);
      emit(tx, state, input.desired === "closed" ? "inventory.blocked" : "inventory.opened",
        null, principal, requestKey);
      return response;
    });
  }

  // One versioned read supplies the OS booking calendar. The sparse cells are
  // derived from the same state as the bookings, so navigation does not need
  // repeated full-property reads for every booking page and 31-day segment.
  async calendarSnapshot(principal: Principal, propertyId: string, from: string,
    to: string): Promise<Record<string, unknown>> {
    uuid(propertyId);
    const first = dayNumber(from), end = dayNumber(to);
    if (end <= first || end - first > MAX_CALENDAR_DAYS) reject("INVALID_DATE_RANGE");
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "booking:read");
    if (principal.origin !== "os") reject("FORBIDDEN", 403);
    const { occupied, blocked } = readInventoryIndex(state, first, end);
    const bookings = state.bookings.filter((booking) =>
      booking.status !== "cancelled" && booking.stays.some((stay) =>
        stay.checkIn < to && stay.checkOut > from));
    if (bookings.length > 2048) reject("READ_CAPACITY_LIMIT", 409);
    const cells: { roomId: string; date: string; state: "sold" | "held" | "blocked" }[] = [];
    for (const [key, status] of occupied) {
      const [roomId, date] = key.split(":");
      cells.push({ roomId, date, state: status === "held" ? "held" : "sold" });
    }
    for (const key of blocked) {
      if (occupied.has(key)) continue;
      const [roomId, date] = key.split(":");
      if (!state.roomIds.includes(roomId) || date < from || date >= to) continue;
      cells.push({ roomId, date, state: "blocked" });
    }
    return { propertyId, workspaceId: state.workspaceId, from, to,
      inventoryVersion: state.version, authorityEpoch: state.authorityEpoch,
      readOnly: state.readOnly === true,
      bookings: bookings.map((booking) => {
        const projected = publicBooking(booking, principal, state);
        return { id: projected.id, version: booking.version, propertyId: projected.propertyId,
          workspaceId: projected.workspaceId, status: projected.status,
          stays: projected.stays, source: projected.source,
          bookedAt: projected.bookedAt,
          channelSyncState: projected.channelSyncState,
          sourceReviewRequired: projected.sourceReviewRequired,
          ...(projected.osEditMode ? { osEditMode: projected.osEditMode } : {}),
          ...(principal.fields.includes("guest_name") ?
            { guestName: projected.guestName,
              ...(projected.sourceCalendar ?
                { sourceCalendar: projected.sourceCalendar } : {}) } : {}),
          ...(principal.fields.includes("payment_status") ?
            { paymentReview: calendarPaymentStatus(booking) } : {}),
          ...(principal.fields.includes("money") ?
            { totalCents: booking.totalCents, currency: booking.currency,
              stayAmountsCents: calendarStayAmounts(booking) } : {}) };
      }), cells };
  }

  async businessReport(principal: Principal, propertyId: string): Promise<BusinessReport> {
    uuid(propertyId);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "booking:aggregate");
    if (principal.origin !== "service" || principal.fields.length !== 0)
      reject("FORBIDDEN", 403);
    // Recheck after authentication: authority may have moved between the two reads.
    if (principal.authorityEpoch !== state.authorityEpoch || state.authorityEpoch < 1)
      reject("AUTHORITY_MOVED", 409);
    if (state.readOnly !== false) reject("PROPERTY_READ_ONLY", 409);
    const prices = new Map<string, NightPrice[]>();
    for (const booking of state.bookings) {
      if (booking.status !== "confirmed") continue;
      const cells = nightsFor(booking.stays, state.roomIds);
      const exact = exactNightPrices(booking.roomNightPrices, cells, booking.totalCents);
      if (exact) prices.set(booking.id, exact);
    }
    return createBusinessReport(state, (booking) => calendarPaymentStatus(booking).status === "paid",
      undefined, prices);
  }

  async occupancySummary(principal: Principal, propertyId: string, from: string,
    to: string): Promise<Record<string, unknown>> {
    uuid(propertyId);
    const first = dayNumber(from), end = dayNumber(to);
    if (end <= first || end - first > MAX_READ_DAYS) reject("INVALID_DATE_RANGE");
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "occupancy:aggregate");
    if (principal.origin !== "service" && principal.origin !== "os") reject("FORBIDDEN", 403);
    const { occupied, blocked, fenced: fenceCells } = readInventoryIndex(state, first, end);
    const days = [];
    for (let day = first; day < end; day++) {
      const date = new Date(day * DAY).toISOString().slice(0, 10);
      let confirmed = 0, held = 0, blockedOnly = 0, unsold = 0, fenced = 0;
      for (const roomId of state.roomIds) {
        const key = `${roomId}:${date}`;
        const status = occupied.get(key);
        if (status === "confirmed") confirmed++;
        else if (status === "held") held++;
        else if (blocked.has(key)) blockedOnly++;
        else unsold++;
        if (fenceCells.has(key)) fenced++;
      }
      days.push({ date, confirmed, held, blocked: blockedOnly, unsold, fenced });
    }
    return { propertyId, inventoryVersion: state.version, totalRooms: state.roomIds.length,
      days, saleReady: false };
  }

  async housekeepingTurnovers(principal: Principal, propertyId: string, from: string,
    to: string): Promise<Record<string, unknown>> {
    uuid(propertyId);
    const first = dayNumber(from), end = dayNumber(to);
    if (end <= first || end - first > MAX_READ_DAYS) reject("INVALID_DATE_RANGE");
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "housekeeping:read");
    if (principal.origin !== "service" && principal.origin !== "os") reject("FORBIDDEN", 403);
    readInventoryIndex(state, first, end);
    const turnovers = [];
    for (const booking of state.bookings) {
      if (booking.status !== "confirmed") continue;
      const byRoom = new Map<string, Set<number>>();
      for (const cell of nightsFor(booking.stays, state.roomIds)) {
        const dates = byRoom.get(cell.roomId) ?? new Set<number>();
        dates.add(dayNumber(cell.date));
        byRoom.set(cell.roomId, dates);
      }
      for (const [roomId, dates] of byRoom) for (const night of dates) {
        if (dates.has(night + 1) || night + 1 < first || night + 1 >= end) continue;
        turnovers.push({ bookingId: booking.id, roomId,
          checkoutDate: new Date((night + 1) * DAY).toISOString().slice(0, 10),
          channelSyncState: booking.channelSyncState });
        if (turnovers.length > 4096) reject("READ_CAPACITY_LIMIT", 409);
      }
    }
    turnovers.sort((a, b) => a.checkoutDate.localeCompare(b.checkoutDate) ||
      a.roomId.localeCompare(b.roomId) || a.bookingId.localeCompare(b.bookingId));
    return { propertyId, inventoryVersion: state.version, turnovers };
  }

  async cancelBooking(principal: Principal, propertyId: string, bookingId: string, requestKey: string,
    expectedBookingVersion: number, expectedInventoryVersion: number,
    linePreviewToken: string | null = null, channelPolicyOrReason?: string, reason?: string): Promise<BookingReceipt> {
    uuid(propertyId); uuid(bookingId); uuid(requestKey);
    if (!Number.isSafeInteger(expectedBookingVersion) || !Number.isSafeInteger(expectedInventoryVersion))
      reject("INVALID_VERSION");
    const channelPolicy = principal.origin === "line" ? channelPolicyOrReason : undefined;
    const auditReason = principal.origin === "os" ? reason ?? channelPolicyOrReason : reason;
    if (auditReason !== undefined) nonempty(auditReason, 500);
    if (principal.origin === "line" && auditReason !== undefined) reject("INVALID_INPUT");
    const manual = lineManualPolicy(principal, channelPolicy);
    const hash = await digest({ action: "booking:cancel", bookingId,
      expectedBookingVersion, expectedInventoryVersion, ...(manual ? { channelPolicy } : {}),
      reason: auditReason });
    const linePreviewExpiry = principal.origin === "line" && this.linePreviewSecret !== null && !manual ?
      await verifyLinePreview(this.linePreviewSecret, linePreviewToken, principal, propertyId,
        expectedInventoryVersion, hash, "cancel", bookingId, expectedBookingVersion) : null;
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "booking:cancel", true);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response as BookingReceipt;
      if (principal.origin !== "os" && principal.origin !== "line") reject("FORBIDDEN", 403);
      if (!manual && state.version !== expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      const booking = state.bookings.find((item) => item.id === bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      if (principal.origin === "line") {
        const expiry = manual && this.linePreviewSecret ?
          verifyLinePreview(this.linePreviewSecret, linePreviewToken, principal,
            propertyId, expectedInventoryVersion, hash, "cancel", bookingId,
            expectedBookingVersion, targetHash(state,
              nightsFor(booking.stays, state.roomIds), bookingId)) : linePreviewExpiry;
        if (expiry === null || Date.now() >= expiry) reject("LINE_PREVIEW_REQUIRED", 409);
      }
      if (booking.version !== expectedBookingVersion) reject("VERSION_CONFLICT", 409);
      if (principal.origin === "line") requireLineMutation(principal, state, booking, manual);
      requireManualBaseline(booking, manual, true);
      if (booking.osManualRoomChange) reject("CHANNEL_CANCELLATION_NOT_READY", 409);
      if (booking.status === "cancelled") reject("ORDER_CANCELLED", 409);
      if (booking.status === "held") reject("HOLD_RELEASE_REQUIRED", 409);
      if (booking.source === "external" && principal.origin !== "line")
        reject("SOURCE_CANCEL_REQUIRES_REVIEW", 409);
      if (principal.origin === "os" && netReceived(booking) !== 0)
        reject("CANCELLATION_REQUIRES_SETTLEMENT", 409);
      if (principal.origin === "os" && state.channel.mode === "owlnest" &&
        booking.channelSyncState !== "awaiting_manual_sync") {
        const cells = nightsFor(booking.stays, state.roomIds);
        if (!verifiedOwnManualClose(state, booking, cells)) requireOsStockWindow(state, cells);
      }
      const previousSync = booking.channelSyncState;
      const previousNights = nightsFor(booking.stays, state.roomIds);
      if (principal.origin === "line")
        flagExternalSourceReview(state, booking, previousNights, []);
      booking.status = "cancelled";
      booking.version++;
      if (manual) {
        booking.lineChannelBaselineNights ??= previousSync === "action_required" ? [] : previousNights;
        updateLinePending(state, booking, []);
      } else if (state.channel.mode === "owlnest" && previousSync === "awaiting_manual_sync") {
        booking.channelSyncState = "not_required";
      } else if (state.channel.mode === "owlnest") {
        const cells = nightsFor(booking.stays, state.roomIds);
        if (previousSync === "pending" || previousSync === "review_required") {
          const previous = state.operations.find((operation) => operation.key === booking.channelOperationKey);
          if (previous) previous.state = "review_required";
          booking.channelSyncState = "review_required";
          if (!state.fences.some((fence) => fence.key === booking.channelOperationKey)) {
            state.fences.push({ key: `review:${booking.id}`, cells, reason: "source_review" });
          }
        } else {
          const operationKey = crypto.randomUUID();
          booking.channelOperationKey = operationKey;
          booking.channelSyncState = "pending";
          state.operations.push({ key: operationKey, bookingId, bookingVersion: booking.version,
            state: "sync_pending", cells: cells.map((cell) => ({ ...cell,
              desired: booking.source === "external" ? "closed" : "open" })),
            createdAt: new Date().toISOString(), verifiedAt: null, providerVersion: null });
          state.fences.push({ key: operationKey, cells, reason: "channel_pending" });
        }
      }
      state.version++;
      const response = makeBookingReceipt(state, booking);
      saveReceipt(state, principal, requestKey, "booking:cancel", hash, { ...response });
      emit(tx, state, "booking.cancelled", booking, principal, requestKey, auditReason);
      return response;
    });
  }

  async previewLineBulkCancel(principal: Principal, propertyId: string,
    input: LineBulkCancelInput): Promise<Record<string, unknown>> {
    uuid(propertyId); verifyLineBulkCancelInput(input);
    const manual = lineManualPolicy(principal, input.channelPolicy);
    if (principal.origin !== "line" || !this.linePreviewSecret)
      reject("LINE_PREVIEW_UNAVAILABLE", 503);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "booking:cancel", true);
    if (!manual && state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
    const target: Night[] = [];
    for (const item of input.bookings) {
      const booking = state.bookings.find((value) => value.id === item.bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      if (booking.version !== item.expectedBookingVersion) reject("VERSION_CONFLICT", 409);
      requireLineMutation(principal, state, booking, manual);
      requireManualBaseline(booking, manual, true);
      target.push(...nightsFor(booking.stays, state.roomIds));
    }
    const hash = await digest({ action: "booking:bulk-cancel", input });
    const signed = await signLinePreview(this.linePreviewSecret, principal, propertyId,
      input.expectedInventoryVersion, hash, "bulk-cancel", null, null,
      manual ? await targetHash(state, uniqueNights(target)) : null);
    return { propertyId, inventoryVersion: input.expectedInventoryVersion, authorityEpoch: state.authorityEpoch,
      bookingIds: input.bookings.map((item) => item.bookingId),
      expiresAt: signed.expiresAt, previewToken: signed.token,
      channelSyncState: "preview_only",
      ...(manual ? { observedInventoryVersion: state.version } : {}) };
  }

  async bulkCancelLineBookings(principal: Principal, propertyId: string, requestKey: string,
    input: LineBulkCancelInput, linePreviewToken: string | null = null): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(requestKey); verifyLineBulkCancelInput(input);
    const manual = lineManualPolicy(principal, input.channelPolicy);
    if (principal.origin !== "line" || !this.linePreviewSecret)
      reject("LINE_PREVIEW_UNAVAILABLE", 503);
    const hash = await digest({ action: "booking:bulk-cancel", input });
    const expiry = manual ? null : await verifyLinePreview(this.linePreviewSecret, linePreviewToken, principal,
      propertyId, input.expectedInventoryVersion, hash, "bulk-cancel");
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "booking:cancel", true);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response;
      if (!manual && state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      // Validate the complete set before touching any booking or channel cell.
      const bookings = input.bookings.map((item) => {
        const booking = state.bookings.find((value) => value.id === item.bookingId);
        if (!booking) reject("BOOKING_NOT_FOUND", 404);
        if (booking.version !== item.expectedBookingVersion) reject("VERSION_CONFLICT", 409);
        requireLineMutation(principal, state, booking, manual);
        requireManualBaseline(booking, manual, true);
        return booking;
      });
      const validExpiry = manual ? verifyLinePreview(this.linePreviewSecret!, linePreviewToken,
        principal, propertyId, input.expectedInventoryVersion, hash, "bulk-cancel", null, null,
        targetHash(state, uniqueNights(bookings.flatMap((booking) =>
          nightsFor(booking.stays, state.roomIds))))) : expiry;
      if (validExpiry === null || Date.now() >= validExpiry) reject("LINE_PREVIEW_REQUIRED", 409);
      const now = new Date().toISOString();
      const operationKeys: (string | null)[] = [];
      for (const booking of bookings) {
        const cells = nightsFor(booking.stays, state.roomIds);
        flagExternalSourceReview(state, booking, cells, []);
        booking.status = "cancelled";
        booking.version++;
        if (manual) {
          booking.lineChannelBaselineNights ??= cells;
          updateLinePending(state, booking, []);
          operationKeys.push(null);
          emit(tx, state, "booking.cancelled", booking, principal, requestKey);
          continue;
        }
        const operationKey = crypto.randomUUID();
        operationKeys.push(operationKey);
        booking.channelOperationKey = operationKey;
        booking.channelSyncState = "pending";
        state.operations.push({ key: operationKey, bookingId: booking.id,
          bookingVersion: booking.version, state: "sync_pending",
          cells: cells.map((cell) => ({ ...cell,
            desired: booking.source === "external" ? "closed" as const : "open" as const })),
          createdAt: now, verifiedAt: null, providerVersion: null });
        state.fences.push({ key: operationKey, cells, reason: "channel_pending" });
        emit(tx, state, "booking.cancelled", booking, principal, requestKey);
      }
      state.version++;
      const response = { bookingIds: bookings.map((booking) => booking.id),
        bookingVersions: bookings.map((booking) => booking.version),
        inventoryVersion: state.version, operationState: manual ?
          bookings.some((booking) => booking.lineChannelPending?.length) ? "action_required" :
          "not_required" : "sync_pending",
        operationKeys, sourceReviewRequired: bookings.some((booking) =>
          booking.lineOverridePending === true) };
      saveReceipt(state, principal, requestKey, "booking:cancel", hash, response);
      return response;
    });
  }

  async requestResult(principal: Principal, propertyId: string, requestKey: string): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(requestKey);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    if (principal.workspaceId !== state.workspaceId || !Array.isArray(principal.propertyIds) ||
      !principal.propertyIds.includes(propertyId)) reject("FORBIDDEN", 403);
    const receipt = state.receipts.find((item) => item.key === requestKey &&
      item.clientId === principal.clientId && item.subjectId === principal.subjectId &&
      item.grantId === (principal.grantId ?? null));
    if (!receipt) reject("REQUEST_NOT_FOUND", 404);
    authorize(principal, state, receipt.action);
    if (receipt.action === "payment:write" && !principal.fields.includes("money"))
      reject("FORBIDDEN", 403);
    if (principal.origin === "guest" && principal.bookingIdScope !== receipt.response.bookingId)
      reject("FORBIDDEN", 403);
    const booking = state.bookings.find((item) => item.id === receipt.response.bookingId);
    return { ...receipt.response, currentBookingVersion: booking?.version ?? null,
      currentChannelSyncState: booking?.channelSyncState ?? null };
  }

  async channelOperation(principal: Principal, propertyId: string, operationKey: string): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(operationKey);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "channel:verify");
    if (principal.origin !== "channel" || !principal.grantId ||
      principal.grantId !== state.channel.grantId) reject("FORBIDDEN", 403);
    const operation = state.operations.find((item) => item.key === operationKey);
    if (!operation) reject("OPERATION_NOT_FOUND", 404);
    return { key: operation.key, bookingId: operation.bookingId, state: operation.state,
      cells: operation.cells, verifiedAt: operation.verifiedAt,
      providerVersion: operation.providerVersion,
      ownCloseWriteRequired: operation.ownCloseWriteRequired === true,
      manualInitialClose: operation.manualInitialClose === true,
      initialOpenPreflight: operation.initialOpenPreflight?.status ?? null };
  }

  async pendingChannelOperations(principal: Principal, propertyId: string,
    limit: number): Promise<Record<string, unknown>> {
    uuid(propertyId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject("INVALID_LIMIT");
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "channel:verify");
    if (principal.origin !== "channel" || !principal.grantId ||
      principal.grantId !== state.channel.grantId) reject("FORBIDDEN", 403);
    // A held property claim is deliberately not retried after an uncertain
    // provider result. Recovery must resolve it before dispatch resumes.
    const pending = (state.channelDispatch ? [] : state.operations)
      .filter((operation) => operation.state === "sync_pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
        left.key.localeCompare(right.key));
    return { propertyId, inventoryVersion: state.version,
      operations: pending.slice(0, limit).map((operation) => ({
        key: operation.key, bookingId: operation.bookingId,
        bookingVersion: operation.bookingVersion, state: operation.state,
        createdAt: operation.createdAt, cells: operation.cells,
      })), hasMore: pending.length > limit };
  }

  /** A repeated login failure or an abandoned dispatch ends in fenced manual review. */
  async reviewUndispatchedLineOperation(principal: Principal, propertyId: string,
    operationKey: string, cause: "preflight" | "stale-claim"): Promise<Record<string, unknown>> {
    uuid(propertyId); uuid(operationKey);
    if (!["preflight", "stale-claim"].includes(cause)) reject("INVALID_INPUT");
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "channel:verify", true);
      if (principal.origin !== "channel" || !principal.grantId ||
        principal.grantId !== state.channel.grantId) reject("FORBIDDEN", 403);
      const operation = state.operations.find((item) => item.key === operationKey);
      if (!operation || !operation.lineGrantId) reject("OPERATION_NOT_FOUND", 404);
      if (operation.state !== "sync_pending") return { state: operation.state, operationKey };
      if (cause === "preflight") {
        if (state.channelDispatch) reject("CHANNEL_PROPERTY_CLAIMED", 409);
        operation.preflightFailures = (operation.preflightFailures ?? 0) + 1;
        if (operation.preflightFailures < 3) return {
          state: "sync_pending", operationKey, failures: operation.preflightFailures };
      } else {
        const claim = state.channelDispatch;
        if (!claim || claim.operationKey !== operationKey ||
          claim.state !== "review_required" && Date.now() - timestamp(claim.claimedAt) < 7 * 60_000)
          reject("CHANNEL_CLAIM_NOT_STALE", 409);
      }
      operation.state = "review_required";
      const booking = state.bookings.find((item) => item.id === operation.bookingId) ?? null;
      if (booking?.channelOperationKey === operationKey) booking.channelSyncState = "review_required";
      state.version++;
      emit(tx, state, "channel.review_required", booking, principal, operationKey);
      return { state: "review_required", operationKey };
    });
  }

  async recordManualChannelPreflight(principal: Principal,
    input: ReadbackInput): Promise<Record<string, unknown>> {
    uuid(input.propertyId); uuid(input.operationKey); nonempty(input.providerVersion, 128);
    const observed = timestamp(input.observedAt), now = Date.now();
    if (observed > now + 60_000 || observed < now - 300_000) reject("STALE_READBACK", 409);
    if (!Array.isArray(input.cells) || input.cells.length > 4096) reject("INVALID_INPUT");
    return this.repository.transact(input.propertyId, (state, tx) => {
      authorize(principal, state, "channel:verify", true);
      if (principal.origin !== "channel" || !principal.grantId ||
        principal.grantId !== state.channel.grantId) reject("FORBIDDEN", 403);
      const operation = state.operations.find((item) => item.key === input.operationKey);
      if (!operation || operation.manualInitialClose !== true ||
        operation.state !== "sync_pending" ||
        state.channelDispatch?.operationKey !== operation.key ||
        state.channelDispatch.state !== "active") reject("CHANNEL_PREFLIGHT_NOT_READY", 409);
      if (operation.initialOpenPreflight) reject("CHANNEL_PREFLIGHT_RECORDED", 409);
      if (observed < timestamp(operation.createdAt)) reject("STALE_READBACK", 409);
      const expected = operation.cells.map(keyOf).sort();
      const actual: string[] = [];
      for (const cell of input.cells) {
        if (!cell || Object.keys(cell).sort().join(",") !== "count,date,isLock,roomId" ||
          !state.roomIds.includes(uuid(cell.roomId)) ||
          !Number.isSafeInteger(cell.count) || cell.count < 0 || cell.count > 100 ||
          typeof cell.isLock !== "boolean") reject("INVALID_INPUT");
        dayNumber(cell.date);
        actual.push(keyOf(cell));
      }
      actual.sort();
      if (actual.length !== expected.length ||
        actual.some((cell, index) => cell !== expected[index])) reject("INVALID_INPUT");
      const open = operation.cells.every((cell) => cell.desired === "closed") &&
        input.cells.every((cell) => cell.count > 0 && !cell.isLock);
      operation.initialOpenPreflight = { status: open ? "open" : "blocked",
        observedAt: input.observedAt, providerVersion: input.providerVersion,
        cells: structuredClone(input.cells) };
      const booking = state.bookings.find((item) => item.id === operation.bookingId);
      if (!booking || booking.channelOperationKey !== operation.key ||
        booking.channelSyncState !== "pending" || booking.status !== "confirmed")
        reject("CHANNEL_PREFLIGHT_NOT_READY", 409);
      if (!open) {
        operation.state = "review_required";
        booking.channelSyncState = "review_required";
      }
      state.version++;
      emit(tx, state, open ? "channel.preflight_open" : "channel.review_required",
        booking, principal, operation.key);
      return { operationKey: operation.key, state: operation.state,
        bookingId: booking.id, bookingVersion: booking.version,
        inventoryVersion: state.version };
    });
  }

  async recordChannelReadback(principal: Principal, input: ReadbackInput): Promise<Record<string, unknown>> {
    uuid(input.propertyId); uuid(input.operationKey); nonempty(input.providerVersion, 128);
    const observed = timestamp(input.observedAt), now = Date.now();
    if (observed > now + 60_000 || observed < now - 300_000) reject("STALE_READBACK", 409);
    if (!Array.isArray(input.cells) || input.cells.length > 4096) reject("INVALID_INPUT");
    if (input.appliedClosedCells !== undefined && (!Array.isArray(input.appliedClosedCells) ||
      input.appliedClosedCells.length > 4096)) reject("INVALID_INPUT");
    return this.repository.transact(input.propertyId, (state, tx) => {
      authorize(principal, state, "channel:verify", true);
      if (principal.origin !== "channel") reject("FORBIDDEN", 403);
      if (!principal.grantId || principal.grantId !== state.channel.grantId) reject("FORBIDDEN", 403);
      for (const cell of input.cells) {
        if (!cell || Object.keys(cell).sort().join(",") !== "count,date,isLock,roomId" ||
          !state.roomIds.includes(uuid(cell.roomId)) ||
          !Number.isSafeInteger(cell.count) || cell.count < 0 || cell.count > 100 ||
          typeof cell.isLock !== "boolean") reject("INVALID_INPUT");
        dayNumber(cell.date);
      }
      const applied = input.appliedClosedCells ?? [];
      for (const cell of applied) {
        if (!cell || Object.keys(cell).sort().join(",") !== "date,roomId" ||
          !state.roomIds.includes(uuid(cell.roomId))) reject("INVALID_INPUT");
        dayNumber(cell.date);
      }
      if (new Set(applied.map(keyOf)).size !== applied.length) reject("INVALID_INPUT");
      const operation = state.operations.find((item) => item.key === input.operationKey);
      if (!operation) reject("OPERATION_NOT_FOUND", 404);
      if (observed < timestamp(operation.createdAt)) reject("STALE_READBACK", 409);
      const booking = operation.bookingId === null ? null :
        state.bookings.find((item) => item.id === operation.bookingId) ?? null;
      if (operation.bookingId !== null && !booking) reject("BOOKING_NOT_FOUND", 404);
      if (operation.state === "sync_verified") return { operationKey: operation.key, state: operation.state,
        bookingId: booking?.id ?? null, bookingVersion: booking?.version ?? null,
        inventoryVersion: state.version };
      const expected = operation.cells.map(keyOf).sort();
      const actual = input.cells.map(keyOf).sort();
      const complete = actual.length === expected.length &&
        actual.every((cell, index) => cell === expected[index]);
      const desiredByCell = new Map(operation.cells.map((cell) => [keyOf(cell), cell.desired]));
      const providerMatches = complete && input.cells.every((cell) =>
        desiredByCell.get(keyOf(cell)) === "closed" ? cell.count === 0 || cell.isLock :
          cell.count > 0 && !cell.isLock);
      const closed = operation.cells.filter((cell) => cell.desired === "closed").map(keyOf).sort();
      const appliedKeys = applied.map(keyOf).sort();
      if (appliedKeys.some((cell) => !closed.includes(cell))) reject("INVALID_INPUT");
      const ownCloseProven = operation.ownCloseWriteRequired !== true ||
        closed.length === appliedKeys.length &&
        closed.every((cell, index) => cell === appliedKeys[index]);
      const manualPreflightValid = operation.manualInitialClose !== true ||
        operation.state === "sync_pending" &&
        operation.initialOpenPreflight?.status === "open" &&
        state.channelDispatch?.operationKey === operation.key &&
        state.channelDispatch.state === "active";
      const currentNights = new Set(booking?.status === "confirmed" ?
        nightsFor(booking.stays, state.roomIds).map(keyOf) : []);
      // Payment or guest-detail edits may advance the booking version while
      // the same channel operation still owns these exact room nights.
      const correctBooking = booking ? booking.channelOperationKey === operation.key &&
        operation.cells.every((cell) => cell.desired === "closed" ?
          operation.ownCloseWriteRequired === true ?
            booking.status === "confirmed" && currentNights.has(keyOf(cell)) :
            booking.status === "confirmed" && currentNights.has(keyOf(cell)) ||
              !currentNights.has(keyOf(cell)) && hasConflict(state, [cell], booking.id,
                operation.key) :
          (booking.status === "confirmed" || booking.status === "cancelled") &&
          !currentNights.has(keyOf(cell)) &&
          !hasConflict(state, [cell], booking.id, operation.key)) :
        operation.bookingId === null && operation.bookingVersion === 0 &&
        operation.cells.length >= 1 && operation.cells.every((cell) =>
          cell.desired === "closed" ?
            state.manualBlocks.some((item) => keyOf(item) === keyOf(cell)) :
            !state.manualBlocks.some((item) => keyOf(item) === keyOf(cell)) &&
            !hasConflict(state, [cell], undefined, operation.key));
      operation.observations ??= [];
      if (operation.observations.length >= 1000) reject("READBACK_LIMIT_REACHED", 409);
      operation.observations.push({ observedAt: input.observedAt, providerVersion: input.providerVersion,
        cells: structuredClone(input.cells), exact: providerMatches,
        accepted: providerMatches && correctBooking && ownCloseProven && manualPreflightValid });
      if (!providerMatches || !correctBooking || !ownCloseProven || !manualPreflightValid) {
        operation.state = "review_required";
        if (booking) booking.channelSyncState = "review_required";
      } else {
        operation.state = "sync_verified";
        operation.verifiedAt = input.observedAt;
        operation.providerVersion = input.providerVersion;
        if (booking) {
          if (operation.lineGrantId && booking.lineChannelBaselineNights !== undefined) {
            const baseline = new Map(booking.lineChannelBaselineNights.map((cell) => [keyOf(cell), cell]));
            for (const cell of operation.cells) {
              if (cell.desired === "closed") baseline.set(keyOf(cell), {
                roomId: cell.roomId, date: cell.date });
              else baseline.delete(keyOf(cell));
            }
            booking.lineChannelBaselineNights = [...baseline.values()];
            updateLinePending(state, booking, booking.status === "confirmed" ?
              nightsFor(booking.stays, state.roomIds) : []);
          } else {
            booking.channelSyncState = "verified";
            delete booking.osManualRoomChange;
          }
          const sourceLink = state.sourceLinks.find((link) => link.bookingId === booking.id);
          const sourceVersionCurrent = sourceLink && !sourceLink.diverged &&
            sourceLink.lastAppliedBookingVersion === booking.version;
          booking.version++;
          if (sourceVersionCurrent) sourceLink.lastAppliedBookingVersion = booking.version;
        }
        state.fences = state.fences.filter((fence) => fence.key !== operation.key);
      }
      state.version++;
      emit(tx, state, operation.state === "sync_verified" ? "channel.verified" :
        "channel.review_required", booking, principal, operation.key);
      return { operationKey: operation.key, state: operation.state, bookingId: booking?.id ?? null,
        bookingVersion: booking?.version ?? null, inventoryVersion: state.version };
    });
  }

  async sourceOrderLookup(principal: Principal,
    input: SourceOrderLookupInput): Promise<Record<string, unknown>> {
    uuid(input.propertyId);
    nonempty(input.sourceSystem, 64); nonempty(input.sourceAccount, 128);
    nonempty(input.externalOrderId, 256);
    if (principal.origin !== "source" || !principal.grantId ||
      principal.sourceSystem !== input.sourceSystem ||
      principal.sourceAccount !== input.sourceAccount) reject("FORBIDDEN", 403);
    const state = await this.repository.read(input.propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "source:write");
    const key = sourceOrderKey(input.sourceSystem, input.sourceAccount, input.externalOrderId);
    const link = state.sourceLinks.find((item) => item.key === key);
    const booking = link?.bookingId ? state.bookings.find((item) => item.id === link.bookingId) : null;
    if (link?.bookingId && !booking) reject("SOURCE_LINK_BROKEN", 409);
    return { propertyId: state.propertyId, inventoryVersion: state.version,
      readOnly: state.readOnly === true,
      sourceVersion: link?.sourceVersion ?? null,
      bookingId: booking?.id ?? null, bookingVersion: booking?.version ?? null,
      bookingStatus: booking?.status ?? null,
      stays: booking ? structuredClone(booking.stays) : [],
      bookedAt: booking?.bookedAt ?? null,
      ...(booking && !booking.sweetfunSnapshot ? { sourceFacts: { totalCents: booking.totalCents,
        currency: booking.currency, platform: booking.sourceCalendar?.platform ?? null,
        externalOrderNo: booking.sourceCalendar?.externalOrderNo ?? null } } : {}),
      diverged: link?.diverged ?? false,
      tombstoned: Boolean(link?.tombstoneNights.length),
    };
  }

  async applySourceEvent(principal: Principal, requestKey: string,
    input: SourceEventInput): Promise<Record<string, unknown>> {
    uuid(input.propertyId); uuid(requestKey);
    if (principal.origin !== "source" || !principal.grantId ||
      principal.sourceSystem !== input.sourceSystem || principal.sourceAccount !== input.sourceAccount)
      reject("FORBIDDEN", 403);
    nonempty(input.sourceSystem, 64); nonempty(input.sourceAccount, 128);
    nonempty(input.externalOrderId, 256); nonempty(input.sourceVersion, 128);
    if (input.previousSourceVersion !== null) nonempty(input.previousSourceVersion, 128);
    if (input.kind !== "upsert" && input.kind !== "cancel") reject("INVALID_INPUT");
    nullableText(input.guestName, 200);
    if (input.bookedAt !== null) dayNumber(input.bookedAt);
    if (input.totalCents !== undefined && input.totalCents !== null &&
      (!Number.isSafeInteger(input.totalCents) || input.totalCents < 0 ||
        input.totalCents > 1_000_000_000_000 || input.currency !== "TWD"))
      reject("INVALID_AMOUNT");
    if (input.currency !== undefined && input.currency !== "TWD") reject("INVALID_CURRENCY");
    if (input.platform !== undefined && input.platform !== null &&
      !["booking", "agoda", "airbnb", "ctrip", "owlnest", "owljourney", "owlting"].includes(input.platform))
      reject("INVALID_PLATFORM");
    if (input.externalOrderNo !== undefined && input.externalOrderNo !== null &&
      (typeof input.externalOrderNo !== "string" ||
        !/^[A-Za-z0-9-]{1,64}$/.test(input.externalOrderNo)))
      reject("INVALID_EXTERNAL_ORDER_NO");
    if (!Number.isSafeInteger(input.expectedInventoryVersion)) reject("INVALID_VERSION");
    const hash = await digest({ action: "source:write", input });
    return this.repository.transact(input.propertyId, (state, tx) => {
      authorize(principal, state, "source:write", true);
      if (!state.sourceGrants.some((grant) => grant.active && grant.grantId === principal.grantId &&
        grant.sourceSystem === input.sourceSystem && grant.sourceAccount === input.sourceAccount))
        reject("FORBIDDEN", 403);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response;
      if (state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      const cells = nightsFor(input.stays, state.roomIds);
      const sourceKey = sourceOrderKey(input.sourceSystem, input.sourceAccount, input.externalOrderId);
      let link = state.sourceLinks.find((item) => item.key === sourceKey);
      const linkedBooking = link?.bookingId ? state.bookings.find((item) => item.id === link!.bookingId) : null;
      const channelMode = state.channel.mode === "owlnest";
      const sourceReadback = channelMode && state.channel.sourceReadbackEnabled === true;
      const review = (reason: string, affected: Night[]): Record<string, unknown> => {
        const key = `review:${sourceKey}`;
        const existing = state.fences.find((fence) => fence.key === key);
        state.fences = state.fences.filter((fence) => fence.key !== key);
        state.fences.push({ key, cells: uniqueNights([...(existing?.cells ?? []), ...affected]),
          reason: "source_review" });
        if (link) link.diverged = true;
        state.version++;
        const response = { state: "review_required", reason, bookingId: linkedBooking?.id ?? null,
          inventoryVersion: state.version };
        saveReceipt(state, principal, requestKey, "source:write", hash, response);
        emit(tx, state, "source.review_required", linkedBooking ?? null, principal, requestKey);
        return response;
      };
      if (linkedBooking?.osDirectOverride === true)
        return review("OS_DIRECT_ORDER_MANAGED", [...cells, ...nightsFor(linkedBooking.stays, state.roomIds)]);
      if ((link?.sourceVersion ?? null) !== input.previousSourceVersion ||
        link?.sourceVersion === input.sourceVersion)
        return review("SOURCE_VERSION_CONFLICT", [...cells,
          ...(linkedBooking ? nightsFor(linkedBooking.stays, state.roomIds) : [])]);
      // A later source fact may acknowledge the exact local correction. This is
      // the only automatic way to release its source-review fence; mismatches
      // remain under review and cannot silently replace the local edit.
      if (link?.diverged && linkedBooking?.lineOverridePending === true &&
        linkedBooking.lineOverrideUnverifiable !== true &&
        (linkedBooking.channelSyncState === "verified" ||
          linkedBooking.lineChannelBaselineNights !== undefined &&
          ["action_required", "not_required"].includes(linkedBooking.channelSyncState))) {
        const sameNights = !changedNights(cells, nightsFor(linkedBooking.stays, state.roomIds));
        const matches = sameNights && (input.kind === "cancel" ?
          linkedBooking.status === "cancelled" :
          linkedBooking.status === "confirmed" && input.guestName === linkedBooking.guestName &&
          input.bookedAt === linkedBooking.bookedAt &&
          input.totalCents !== undefined && input.totalCents === linkedBooking.totalCents);
        const sourceReviewKey = `review:${sourceKey}`;
        if (matches && !state.fences.some((fence) => fence.key === sourceReviewKey)) {
          const lineReviewKey = `review:line:${linkedBooking.id}`;
          const lineFence = state.fences.find((fence) => fence.key === lineReviewKey);
          const currentKeys = new Set(linkedBooking.status === "confirmed" ?
            nightsFor(linkedBooking.stays, state.roomIds).map(keyOf) : []);
          const removed = (lineFence?.cells ?? []).filter((cell) => !currentKeys.has(keyOf(cell)));
          state.fences = state.fences.filter((fence) => fence.key !== lineReviewKey);
          link.sourceVersion = input.sourceVersion;
          link.lastAppliedBookingVersion = linkedBooking.version;
          link.diverged = false;
          if (input.kind === "cancel") link.tombstoneNights = cells;
          linkedBooking.lineOverridePending = false;
          linkedBooking.lineOverrideUnverifiable = false;
          if (removed.length && linkedBooking.lineChannelBaselineNights === undefined) {
            const operationKey = crypto.randomUUID();
            const desired: DesiredCell[] = removed.map((cell) => ({ ...cell,
              desired: hasConflict(state, [cell], linkedBooking.id) ? "closed" : "open" }));
            linkedBooking.channelOperationKey = operationKey;
            linkedBooking.channelSyncState = "pending";
            state.operations.push({ key: operationKey, bookingId: linkedBooking.id,
              bookingVersion: linkedBooking.version, state: "sync_pending", cells: desired,
              createdAt: new Date().toISOString(), verifiedAt: null, providerVersion: null });
            state.fences.push({ key: operationKey, cells: removed, reason: "channel_pending" });
          }
          state.version++;
          const response = { state: "applied", bookingId: linkedBooking.id,
            bookingVersion: linkedBooking.version, inventoryVersion: state.version,
            lineOverrideReconciled: true,
            ...(removed.length ? { channelSyncState: linkedBooking.channelSyncState,
              operationKey: linkedBooking.channelOperationKey } : {}) };
          saveReceipt(state, principal, requestKey, "source:write", hash, response);
          emit(tx, state, "source.applied", linkedBooking, principal, requestKey);
          return response;
        }
      }
      if (link?.diverged) return review("SOURCE_REVIEW_OPEN", [...cells,
        ...(linkedBooking ? nightsFor(linkedBooking.stays, state.roomIds) : [])]);
      if (link?.bookingId && (!linkedBooking || linkedBooking.version !== link.lastAppliedBookingVersion))
        return review("SOURCE_DIVERGED", [...cells, ...(linkedBooking ? nightsFor(linkedBooking.stays, state.roomIds) : [])]);
      if (input.kind === "upsert" && link && link.tombstoneNights.length)
        return review("SOURCE_TOMBSTONE_REACTIVATION", [...cells, ...link.tombstoneNights]);
      // A platform order number is only an auxiliary identity. It is not
      // enough to claim another booking, but a collision must never create a
      // second confirmed booking under a different source-event key.
      if (input.kind === "upsert" && input.platform && input.externalOrderNo) {
        const owlNestOrderId = input.externalOrderId.startsWith("L:") ?
          input.externalOrderId.slice(2) : null;
        const aliasOwner = state.bookings.find((booking) => booking.id !== linkedBooking?.id &&
          (booking.sourceCalendar?.platform === input.platform &&
            booking.sourceCalendar?.externalOrderNo === input.externalOrderNo ||
            // Imported Sheet rows have no sourceKey. Their OwlNest ID in L
            // and OTA alias in N must both block a second confirmed booking.
            Array.isArray(booking.sweetfunSnapshot?.rows) &&
            booking.sweetfunSnapshot.rows.some((row) =>
              Array.isArray(row?.values) &&
              (String(row.values[13] ?? "").trim() === input.externalOrderNo ||
                owlNestOrderId !== null &&
                String(row.values[11] ?? "").trim() === owlNestOrderId))));
        if (aliasOwner) return review("SOURCE_IDENTITY_COLLISION", [...cells,
          ...nightsFor(aliasOwner.stays, state.roomIds)]);
      }
      // The authenticated Gmail writer may claim a new OwlNest order only
      // when Gmail verified the provider's aligned DKIM/DMARC signature and
      // the source notice carries an exact OTA alias and amount. An unsigned
      // notice, generic source client, or ambiguous identity remains fenced.
      if (channelMode && input.kind === "upsert" && !linkedBooking) {
        const evidence = input.sourceIdentityEvidence;
        const signedNotice = principal.subjectId === GMAIL_NOTIFICATION_SUBJECT &&
          input.sourceSystem === GMAIL_NOTIFICATION_SOURCE &&
          /^L:OBE[A-Z0-9]+$/.test(input.externalOrderId) &&
          /^gmail-v1:[1-9]\d{12}:[0-9a-f]{64}$/.test(input.sourceVersion) &&
          input.previousSourceVersion === null && input.bookedAt === null &&
          typeof input.guestName === "string" && input.guestName.trim().length > 0 &&
          ["booking", "agoda", "airbnb", "ctrip"].includes(input.platform ?? "") &&
          typeof input.externalOrderNo === "string" &&
          typeof input.totalCents === "number" &&
          Number.isSafeInteger(input.totalCents) && input.currency === "TWD" &&
          evidence && typeof evidence === "object" &&
          Object.keys(evidence).sort().join(",") === "deliveredTo,kind,signedDomain" &&
          evidence.kind === "gmail-owlnest-dkim-v1" &&
          evidence.signedDomain === "owlting.com" &&
          evidence.deliveredTo === "sweetfuntw@gmail.com";
        if (!signedNotice) return review("SOURCE_IDENTITY_UNVERIFIED", cells);
      }
      if (sourceReadback && (!state.channel.ready || !state.channel.grantId))
        return review("CHANNEL_NOT_READY", [...cells,
          ...(linkedBooking ? nightsFor(linkedBooking.stays, state.roomIds) : [])]);
      if (sourceReadback && linkedBooking &&
        (linkedBooking.channelSyncState === "pending" ||
          linkedBooking.channelSyncState === "review_required"))
        return review("CHANNEL_PREVIOUS_OPERATION_UNRESOLVED", [...cells,
          ...nightsFor(linkedBooking.stays, state.roomIds)]);
      if (channelMode && !sourceReadback && input.kind === "upsert") {
        const current = linkedBooking ? nightsFor(linkedBooking.stays, state.roomIds).map(keyOf).sort() : [];
        const requested = cells.map(keyOf).sort();
        if (current.length !== requested.length ||
            current.some((cell, index) => cell !== requested[index]))
          return review("CHANNEL_UPSERT_REQUIRES_READBACK", [...cells,
            ...(linkedBooking ? nightsFor(linkedBooking.stays, state.roomIds) : [])]);
      }
      if (input.kind === "cancel" && linkedBooking) {
        const current = nightsFor(linkedBooking.stays, state.roomIds).map(keyOf).sort();
        const supplied = cells.map(keyOf).sort();
        if (current.length !== supplied.length || current.some((cell, index) => cell !== supplied[index]))
          return review("SOURCE_STAY_MISMATCH", [...cells, ...nightsFor(linkedBooking.stays, state.roomIds)]);
        if (channelMode && !sourceReadback)
          return review("CHANNEL_CANCEL_REQUIRES_READBACK", cells);
      }
      if (input.kind === "cancel" && !linkedBooking) {
        if (channelMode)
          return review("CHANNEL_UNKNOWN_CANCEL_REQUIRES_READBACK", cells);
        if (!link) {
          link = { key: sourceKey, sourceSystem: input.sourceSystem, sourceAccount: input.sourceAccount,
            externalOrderId: input.externalOrderId, bookingId: null, sourceVersion: input.sourceVersion,
            lastAppliedBookingVersion: 0, diverged: false, tombstoneNights: cells };
          state.sourceLinks.push(link);
        } else {
          link.sourceVersion = input.sourceVersion;
          link.tombstoneNights = cells;
        }
        state.version++;
        const response = { state: "applied", bookingId: null, inventoryVersion: state.version };
        saveReceipt(state, principal, requestKey, "source:write", hash, response);
        emit(tx, state, "source.applied", null, principal, requestKey);
        return response;
      }
      if (input.kind === "upsert" && hasConflict(state, cells, linkedBooking?.id))
        return review("ROOM_CONFLICT", [...cells, ...(linkedBooking ? nightsFor(linkedBooking.stays, state.roomIds) : [])]);
      const oldCells = linkedBooking ? nightsFor(linkedBooking.stays, state.roomIds) : [];
      let booking: Booking;
      if (linkedBooking) {
        booking = linkedBooking;
        booking.version++;
        booking.status = input.kind === "cancel" ? "cancelled" : "confirmed";
        if (input.kind === "upsert") {
          booking.stays = structuredClone(input.stays);
          booking.guestName = input.guestName;
          booking.bookedAt = input.bookedAt;
          // A missing fee stays unknown. An imported fee cannot remain current
          // after a changed external order without fresh source evidence.
          booking.totalCents = input.totalCents ?? null;
          booking.sourceCalendar = { platform: input.platform ?? null,
            externalOrderNo: input.externalOrderNo ?? null };
        }
      } else {
        booking = { id: crypto.randomUUID(), workspaceId: state.workspaceId, propertyId: state.propertyId,
          version: 1, status: "confirmed", channelSyncState: "not_required", channelOperationKey: null,
          stays: structuredClone(input.stays), guestName: input.guestName, contact: null, notes: null,
          totalCents: input.totalCents ?? null, currency: "TWD", bookedAt: input.bookedAt,
          createdAt: new Date().toISOString(), source: "external", sourceKey,
          sourceCalendar: { platform: input.platform ?? null,
            externalOrderNo: input.externalOrderNo ?? null } };
        state.bookings.push(booking);
      }
      if (!link) {
        link = { key: sourceKey, sourceSystem: input.sourceSystem, sourceAccount: input.sourceAccount,
          externalOrderId: input.externalOrderId, bookingId: booking.id, sourceVersion: input.sourceVersion,
          lastAppliedBookingVersion: booking.version, diverged: false, tombstoneNights: [] };
        state.sourceLinks.push(link);
      } else {
        link.bookingId = booking.id;
        link.sourceVersion = input.sourceVersion;
        link.lastAppliedBookingVersion = booking.version;
        link.diverged = false;
        if (input.kind === "cancel") link.tombstoneNights = cells;
      }
      // The authenticated Gmail writer only creates an unlinked booking for a
      // new-order notice. Preserve that first notice independently of bookedAt;
      // amendments, cancellations, receipts and source-fact repairs never move it.
      if (!linkedBooking && input.kind === "upsert" && principal.subjectId === GMAIL_NOTIFICATION_SUBJECT) {
        const notification = firstGmailNotification(input.sourceSystem, input.sourceVersion,
          requestKey, booking.createdAt);
        if (notification) link.firstNewOrderNotification = notification;
      }
      const channelNeeded = sourceReadback && (input.kind === "cancel" || !linkedBooking ||
        linkedBooking.channelSyncState !== "verified" || changedNights(oldCells, cells));
      if (channelNeeded) {
        const currentKeys = new Set(input.kind === "upsert" ? cells.map(keyOf) : []);
        const removed = oldCells.filter((cell) => !currentKeys.has(keyOf(cell)));
        // A separate manual block or review fence must stay closed even when
        // the source booking moves away or is cancelled.
        const desired: DesiredCell[] = [
          ...removed.map((cell) => ({ ...cell,
            desired: hasConflict(state, [cell], booking.id) ? "closed" as const : "open" as const })),
          ...(input.kind === "upsert" ? cells.map((cell) =>
            ({ ...cell, desired: "closed" as const })) : []),
        ];
        if (!desired.length) reject("CHANNEL_OPERATION_EMPTY", 409);
        const operationKey = crypto.randomUUID();
        booking.channelOperationKey = operationKey;
        booking.channelSyncState = "pending";
        state.operations.push({ key: operationKey, bookingId: booking.id,
          bookingVersion: booking.version, state: "sync_pending", cells: desired,
          createdAt: new Date().toISOString(), verifiedAt: null, providerVersion: null });
        state.fences.push({ key: operationKey, cells: uniqueNights([...oldCells, ...cells]),
          reason: "channel_pending" });
      }
      state.version++;
      const response = { state: "applied", bookingId: booking.id, bookingVersion: booking.version,
        inventoryVersion: state.version,
        ...(channelNeeded ? { channelSyncState: "pending", operationKey: booking.channelOperationKey } : {}) };
      saveReceipt(state, principal, requestKey, "source:write", hash, response);
      emit(tx, state, "source.applied", booking, principal, requestKey);
      return response;
    });
  }

  async enrichSourceFacts(principal: Principal, requestKey: string,
    input: SourceFactsInput): Promise<Record<string, unknown>> {
    uuid(input.propertyId); uuid(requestKey);
    nonempty(input.sourceSystem, 64); nonempty(input.sourceAccount, 128);
    nonempty(input.externalOrderId, 256); nonempty(input.sourceVersion, 128);
    if (principal.origin !== "source" || !principal.grantId ||
      principal.sourceSystem !== input.sourceSystem ||
      principal.sourceAccount !== input.sourceAccount) reject("FORBIDDEN", 403);
    if (!Number.isSafeInteger(input.expectedInventoryVersion) ||
      !Number.isSafeInteger(input.expectedBookingVersion) || input.expectedBookingVersion < 1)
      reject("INVALID_VERSION");
    if (!Number.isSafeInteger(input.totalCents) || input.totalCents < 0 ||
      input.totalCents > 1_000_000_000_000 || input.currency !== "TWD")
      reject("INVALID_AMOUNT");
    if (!["booking", "agoda", "airbnb", "ctrip", "owlnest", "owljourney", "owlting"]
      .includes(input.platform)) reject("INVALID_PLATFORM");
    if (input.externalOrderNo !== null &&
      (typeof input.externalOrderNo !== "string" ||
        !/^[A-Za-z0-9-]{1,64}$/.test(input.externalOrderNo)))
      reject("INVALID_EXTERNAL_ORDER_NO");
    const hash = await digest({ action: "source:facts", input });
    return this.repository.transact(input.propertyId, (state, tx) => {
      authorize(principal, state, "source:write", true);
      if (!state.sourceGrants.some((grant) => grant.active && grant.grantId === principal.grantId &&
        grant.sourceSystem === input.sourceSystem && grant.sourceAccount === input.sourceAccount))
        reject("FORBIDDEN", 403);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response;
      if (state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      if (state.channel.mode !== "none") reject("SOURCE_FACTS_CHANNEL_ACTIVE", 409);
      const key = sourceOrderKey(input.sourceSystem, input.sourceAccount, input.externalOrderId);
      const link = state.sourceLinks.find((item) => item.key === key);
      const booking = link?.bookingId ? state.bookings.find((item) => item.id === link.bookingId) : null;
      if (!link || !booking || booking.sweetfunSnapshot || link.diverged || link.tombstoneNights.length ||
        link.sourceVersion !== input.sourceVersion ||
        link.lastAppliedBookingVersion !== input.expectedBookingVersion ||
        booking.version !== input.expectedBookingVersion || booking.status !== "confirmed")
        reject("SOURCE_FACTS_STALE", 409);
      if ((booking.totalCents !== null && booking.totalCents !== input.totalCents) ||
        (booking.sourceCalendar?.platform && booking.sourceCalendar.platform !== input.platform) ||
        (booking.sourceCalendar?.externalOrderNo &&
          booking.sourceCalendar.externalOrderNo !== input.externalOrderNo))
        reject("SOURCE_FACTS_CONFLICT", 409);
      const changed = booking.totalCents !== input.totalCents ||
        booking.sourceCalendar?.platform !== input.platform ||
        (booking.sourceCalendar?.externalOrderNo ?? null) !== input.externalOrderNo;
      if (changed) {
        booking.totalCents = input.totalCents;
        booking.sourceCalendar = { platform: input.platform,
          externalOrderNo: input.externalOrderNo };
        booking.version++;
        link.lastAppliedBookingVersion = booking.version;
        state.version++;
        emit(tx, state, "source.facts_enriched", booking, principal, requestKey);
      }
      const response = { state: changed ? "applied" : "already_current",
        bookingId: booking.id, bookingVersion: booking.version,
        inventoryVersion: state.version };
      saveReceipt(state, principal, requestKey, "source:write", hash, response);
      return response;
    });
  }
}
