import type {
  Action, AmendBookingInput, Booking, BookingReceipt, CreateBookingInput, CreateHoldInput,
  ExtendHoldInput,
  DesiredCell, Night, PaymentEventInput, Principal, PropertyRepository, PropertyState,
  ReadbackInput, RequestReceipt, SourceEventInput, SourceFactsInput, SourceOrderLookupInput, Stay,
  TransactionContext, EventType,
} from "./types.ts";
import { GateError } from "./errors.ts";
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
  propertyId: string, inventoryVersion: number, inputHash: string): Promise<{
    token: string; expiresAt: string;
  }> {
  const issuedAtMs = Date.now(), expiresAtMs = issuedAtMs + LINE_PREVIEW_LIFETIME_MS;
  const claims = { v: 1, aud: "iron-gate-line-create-preview-v1",
    workspaceId: principal.workspaceId, propertyId,
    actorId: principal.subjectId, clientId: principal.clientId,
    grantId: principal.grantId, authorityEpoch: principal.authorityEpoch,
    inventoryVersion, inputHash, issuedAtMs, expiresAtMs,
    nonce: crypto.randomUUID() };
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC",
    await linePreviewKey(secret), new TextEncoder().encode(encoded)));
  return { token: `${encoded}.${base64url(signature)}`,
    expiresAt: new Date(expiresAtMs).toISOString() };
}
async function verifyLinePreview(secret: string, token: string | null | undefined,
  principal: Principal, propertyId: string, inventoryVersion: number,
  inputHash: string): Promise<number | null> {
  try {
    if (typeof token !== "string" || token.length > 2048) return null;
    const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!parts) return null;
    const key = await linePreviewKey(secret);
    if (!await crypto.subtle.verify("HMAC", key, decodeBase64url(parts[2]),
      new TextEncoder().encode(parts[1]))) return null;
    const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64url(parts[1])));
    const now = Date.now();
    const valid = claims?.v === 1 && claims.aud === "iron-gate-line-create-preview-v1" &&
      claims.workspaceId === principal.workspaceId && claims.propertyId === propertyId &&
      claims.actorId === principal.subjectId && claims.clientId === principal.clientId &&
      claims.grantId === principal.grantId &&
      claims.authorityEpoch === principal.authorityEpoch &&
      claims.inventoryVersion === inventoryVersion && claims.inputHash === inputHash &&
      typeof claims.nonce === "string" && UUID.test(claims.nonce) &&
      Number.isSafeInteger(claims.issuedAtMs) &&
      Number.isSafeInteger(claims.expiresAtMs) &&
      claims.expiresAtMs - claims.issuedAtMs === LINE_PREVIEW_LIFETIME_MS &&
      claims.issuedAtMs <= now + 2_000 && claims.expiresAtMs > now;
    return valid ? claims.expiresAtMs : null;
  } catch { return null; }
}

export function nightsFor(stays: Stay[], roomIds: string[]): Night[] {
  if (!Array.isArray(stays) || stays.length < 1 || stays.length > 32) reject("INVALID_STAY");
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
function occupies(booking: Booking): boolean { return booking.status === "held" || booking.status === "confirmed"; }
function hasConflict(state: PropertyState, cells: Night[], exceptBookingId?: string, exceptFenceKey?: string): boolean {
  const asked = new Set(cells.map(keyOf));
  if (state.manualBlocks.some((cell) => asked.has(keyOf(cell)))) return true;
  if (state.fences.some((fence) => fence.key !== exceptFenceKey && fence.cells.some((cell) => asked.has(keyOf(cell))))) return true;
  return state.bookings.some((booking) => booking.id !== exceptBookingId && occupies(booking) &&
    nightsFor(booking.stays, state.roomIds).some((cell) => asked.has(keyOf(cell))));
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
function publicBooking(booking: Booking, principal: Principal): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: booking.id, workspaceId: booking.workspaceId, propertyId: booking.propertyId,
    version: booking.version, status: booking.status, channelSyncState: booking.channelSyncState,
    stays: booking.stays, createdAt: booking.createdAt, source: booking.source,
  };
  // Field grants are server-authenticated. Public website queries use a separate order credential.
  if ((principal.origin === "os" || principal.origin === "line") &&
    principal.fields.includes("guest_name")) {
    result.guestName = booking.guestName;
    if (principal.origin === "os" && booking.sourceCalendar) {
      result.sourceCalendar = { ...booking.sourceCalendar, bookedAt: booking.bookedAt };
    }
    // The imported rows remain private evidence. Only unambiguous calendar
    // labels may leave that evidence, under the same OS guest grant.
    const rows = principal.origin === "os" ? booking.sweetfunSnapshot?.rows : null;
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
      result.sourceCalendar = { platform, externalOrderNo,
        bookedAt: bookedAt && Number.isFinite(Date.parse(`${bookedAt}T00:00:00Z`)) &&
          new Date(`${bookedAt}T00:00:00Z`).toISOString().slice(0, 10) === bookedAt
          ? bookedAt : null };
    }
  }
  if ((principal.origin === "os" || principal.origin === "line") &&
    principal.fields.includes("contact")) result.contact = booking.contact;
  if ((principal.origin === "os" || principal.origin === "line") &&
    principal.fields.includes("notes")) result.notes = booking.notes;
  if ((principal.origin === "os" || principal.origin === "finance") &&
    principal.fields.includes("money")) {
    result.totalCents = booking.totalCents;
    result.currency = booking.currency;
    result.paymentSummary = paymentTotals(booking);
  }
  if (principal.origin === "line" && principal.fields.includes("money")) {
    result.totalCents = booking.totalCents;
    result.currency = booking.currency;
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
  // A newer source event supplies only a whole-order amount. Historical
  // imported rows cannot prove its current per-night distribution.
  if (booking.sourceCalendar) return null;
  const rows = booking.sweetfunSnapshot?.rows;
  if (!Array.isArray(rows) || rows.length !== booking.stays.length ||
    new Set(booking.stays.map((stay) => stay.checkIn)).size !== booking.stays.length) return null;
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
}
function operationState(state: PropertyState, booking: Booking): BookingReceipt["operationState"] {
  if (state.channel.mode === "none") return "local_only";
  return booking.channelSyncState === "verified" ? "sync_verified" :
    booking.channelSyncState === "review_required" ? "review_required" : "sync_pending";
}
function makeBookingReceipt(state: PropertyState, booking: Booking): BookingReceipt {
  return { bookingId: booking.id, bookingVersion: booking.version, inventoryVersion: state.version,
    operationState: operationState(state, booking), operationKey: booking.channelOperationKey,
    refundReviewRequired: netReceived(booking) > 0 &&
      (booking.status === "cancelled" ||
        (booking.totalCents !== null && netReceived(booking) > booking.totalCents)) };
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
  booking: Booking | null, principal: Principal, requestKey: string | null): void {
  const at = new Date().toISOString();
  tx.emit({ eventId: crypto.randomUUID(), at, type,
    propertyId: state.propertyId, bookingId: booking?.id ?? null,
    bookingVersion: booking?.version ?? null, inventoryVersion: state.version });
  tx.audit({ auditId: crypto.randomUUID(), at, type, workspaceId: state.workspaceId,
    propertyId: state.propertyId, bookingId: booking?.id ?? null,
    bookingVersion: booking?.version ?? null, bookingStatus: booking?.status ?? null,
    inventoryVersion: state.version, actorOrigin: principal.origin,
    actorClientId: principal.clientId, actorSubjectId: principal.subjectId,
    actorGrantId: principal.grantId ?? null, requestKey });
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
    if (principal.origin !== "line" || !this.linePreviewSecret)
      reject("LINE_PREVIEW_UNAVAILABLE", 503);
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "booking:create");
    if (state.readOnly !== false || principal.authorityEpoch !== state.authorityEpoch ||
      state.channel.mode !== "owlnest" || !state.channel.ready ||
      state.channel.sourceReadbackEnabled !== true || !state.channel.grantId)
      reject("LINE_CHANNEL_NOT_READY", 409);
    if (state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
    if (hasConflict(state, nightsFor(input.stays, state.roomIds))) reject("ROOM_CONFLICT", 409);
    const hash = await digest({ action: "booking:create", input });
    const signed = await signLinePreview(this.linePreviewSecret, principal,
      propertyId, state.version, hash);
    return { propertyId, inventoryVersion: state.version,
      authorityEpoch: state.authorityEpoch, expiresAt: signed.expiresAt,
      previewToken: signed.token, channelSyncState: "preview_only" };
  }

  async createBooking(principal: Principal, propertyId: string, requestKey: string,
    input: CreateBookingInput, linePreviewToken: string | null = null): Promise<BookingReceipt> {
    uuid(propertyId); uuid(requestKey); verifyCreate(input, principal);
    const hash = await digest({ action: "booking:create", input });
    const linePreviewExpiry = principal.origin === "line" && this.linePreviewSecret !== null ?
      await verifyLinePreview(this.linePreviewSecret, linePreviewToken, principal,
        propertyId, input.expectedInventoryVersion, hash) : null;
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "booking:create", true);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response as BookingReceipt;
      if (principal.origin === "line") {
        if (linePreviewExpiry === null || Date.now() >= linePreviewExpiry)
          reject("LINE_PREVIEW_REQUIRED", 409);
        if (state.readOnly !== false || state.channel.mode !== "owlnest" || !state.channel.ready ||
          state.channel.sourceReadbackEnabled !== true || !state.channel.grantId)
          reject("LINE_CHANNEL_NOT_READY", 409);
      }
      if (state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      // Direct website writes require a one-use server-issued quote, including
      // local-only properties. A binding alone is never sale authorization.
      if (principal.origin === "website") reject("WEBSITE_QUOTE_REQUIRED", 409);
      if (state.channel.mode === "owlnest" && !state.channel.ready) reject("SOURCE_UNAVAILABLE", 503);
      const cells = nightsFor(input.stays, state.roomIds);
      if (hasConflict(state, cells)) reject("ROOM_CONFLICT", 409);
      const operationKey = state.channel.mode === "owlnest" ? crypto.randomUUID() : null;
      const booking: Booking = {
        id: crypto.randomUUID(), workspaceId: state.workspaceId, propertyId, version: 1,
        status: "confirmed", channelSyncState: operationKey ? "pending" : "not_required",
        channelOperationKey: operationKey, stays: structuredClone(input.stays),
        guestName: input.guestName, contact: input.contact, notes: input.notes,
        totalCents: input.totalCents, currency: "TWD", bookedAt: input.bookedAt,
        createdAt: new Date().toISOString(), source: input.source,
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

  async amendBooking(principal: Principal, propertyId: string, bookingId: string, requestKey: string,
    input: AmendBookingInput): Promise<BookingReceipt> {
    uuid(propertyId); uuid(bookingId); uuid(requestKey);
    if (!Number.isSafeInteger(input.expectedBookingVersion) || input.expectedBookingVersion < 1 ||
      !Number.isSafeInteger(input.expectedInventoryVersion) || input.expectedInventoryVersion < 0)
      reject("INVALID_VERSION");
    if (!input.changes || Array.isArray(input.changes) || typeof input.changes !== "object") reject("INVALID_INPUT");
    const fields = Object.keys(input.changes);
    if (!fields.length || fields.some((field) => !["stays", "guestName", "contact", "notes", "totalCents"].includes(field)))
      reject("INVALID_INPUT");
    if ("guestName" in input.changes) nullableText(input.changes.guestName, 200);
    if ("contact" in input.changes) nullableText(input.changes.contact, 256);
    if ("notes" in input.changes) nullableText(input.changes.notes, 2048);
    if ("totalCents" in input.changes && input.changes.totalCents !== null &&
      (!Number.isSafeInteger(input.changes.totalCents) || input.changes.totalCents! < 0)) reject("INVALID_AMOUNT");
    const hash = await digest({ action: "booking:amend", bookingId, input });
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "booking:amend", true);
      if (principal.origin !== "os") reject("FORBIDDEN", 403);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response as BookingReceipt;
      if (state.version !== input.expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      const booking = state.bookings.find((item) => item.id === bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      if (booking.version !== input.expectedBookingVersion) reject("VERSION_CONFLICT", 409);
      if (booking.status === "cancelled") reject("ORDER_CANCELLED", 409);
      let roomNightsChanged = false;
      if ("stays" in input.changes) {
        const next = nightsFor(input.changes.stays!, state.roomIds);
        const current = nightsFor(booking.stays, state.roomIds);
        roomNightsChanged = changedNights(current, next);
        if (roomNightsChanged && state.channel.mode !== "none") reject("CHANNEL_AMENDMENT_UNIMPLEMENTED", 409);
        if (roomNightsChanged && hasConflict(state, next, booking.id)) reject("ROOM_CONFLICT", 409);
        booking.stays = structuredClone(input.changes.stays!);
      }
      if ("guestName" in input.changes) booking.guestName = input.changes.guestName!;
      if ("contact" in input.changes) booking.contact = input.changes.contact!;
      if ("notes" in input.changes) booking.notes = input.changes.notes!;
      if ("totalCents" in input.changes) booking.totalCents = input.changes.totalCents!;
      booking.version++;
      if (roomNightsChanged) state.version++;
      const response = makeBookingReceipt(state, booking);
      saveReceipt(state, principal, requestKey, "booking:amend", hash, { ...response });
      emit(tx, state, "booking.amended", booking, principal, requestKey);
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
    nonempty(input.evidenceRef, 256);
    if (timestamp(input.occurredAt) > Date.now()) reject("FUTURE_RECEIPT");
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
      if (input.kind === "refunded" && input.amountCents > netReceived(booking))
        reject("REFUND_EXCEEDS_RECEIVED", 409);
      booking.paymentEvents ??= [];
      booking.paymentEvents.push({ id: input.eventId, kind: input.kind, amountCents: input.amountCents,
        currency: input.currency, evidenceRef: input.evidenceRef, occurredAt: input.occurredAt,
        recordedAt: new Date().toISOString(), actorId: principal.subjectId });
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
    if (principal.origin === "line" &&
      (booking.source !== "line" || booking.sourceKey !== `line:${principal.grantId}`))
      reject("BOOKING_NOT_FOUND", 404);
    const projection = publicBooking(booking, principal);
    return principal.origin === "line" ? { ...projection,
      inventoryVersion: state.version, authorityEpoch: state.authorityEpoch,
      readOnly: state.readOnly === true,
      lineScope: { grantId: principal.grantId } } : projection;
  }

  async listBookings(principal: Principal, propertyId: string, options: {
    limit: number; cursor: string | null; status: Booking["status"] | null;
    from: string | null; to: string | null;
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
          typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") throw Error();
        timestamp(parsed.createdAt); uuid(parsed.id);
        seek = { createdAt: parsed.createdAt, id: parsed.id };
      } catch { reject("INVALID_CURSOR"); }
    }
    const state = await this.repository.read(propertyId);
    if (!state) reject("PROPERTY_NOT_FOUND", 404);
    authorize(principal, state, "booking:read");
    if (principal.origin !== "os" && principal.origin !== "line") reject("FORBIDDEN", 403);
    const result = state.bookings.filter((booking) =>
      (principal.origin !== "line" || booking.source === "line" &&
        booking.sourceKey === `line:${principal.grantId}`) &&
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
        to: options.to, createdAt: last.createdAt, id: last.id }))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
    const snapshot = state.readOnly === true && state.authorityEpoch === 0 &&
      state.sweetfunImport && typeof state.sweetfunImport.capturedAt === "string" &&
      typeof state.sweetfunImport.sourceHash === "string"
      ? { capturedAt: state.sweetfunImport.capturedAt,
        sourceHash: state.sweetfunImport.sourceHash } : null;
    return { propertyId, inventoryVersion: state.version,
      authorityEpoch: state.authorityEpoch, readOnly: state.readOnly === true,
      snapshot, bookings: page.map((booking) => publicBooking(booking, principal)), nextCursor,
      ...(principal.origin === "line" ? { lineScope: { grantId: principal.grantId } } : {}) };
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
        saleReady: false });
    }
    return { propertyId, inventoryVersion: state.version, authorityEpoch: state.authorityEpoch,
      readOnly: state.readOnly === true, cells,
      ...(principal.origin === "line" ? { lineScope: { grantId: principal.grantId } } : {}),
      note: "unsold means no local occupancy; it does not prove external channel stock" };
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
        const projected = publicBooking(booking, principal);
        return { id: projected.id, propertyId: projected.propertyId,
          workspaceId: projected.workspaceId, status: projected.status,
          stays: projected.stays,
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
    expectedBookingVersion: number, expectedInventoryVersion: number): Promise<BookingReceipt> {
    uuid(propertyId); uuid(bookingId); uuid(requestKey);
    if (!Number.isSafeInteger(expectedBookingVersion) || !Number.isSafeInteger(expectedInventoryVersion))
      reject("INVALID_VERSION");
    const hash = await digest({ action: "booking:cancel", bookingId, expectedBookingVersion, expectedInventoryVersion });
    return this.repository.transact(propertyId, (state, tx) => {
      authorize(principal, state, "booking:cancel", true);
      if (principal.origin === "line") reject("LINE_PREVIEW_REQUIRED", 409);
      if (principal.origin !== "os") reject("FORBIDDEN", 403);
      const prior = receiptFor(state, principal, requestKey, hash);
      if (prior) return prior.response as BookingReceipt;
      if (state.version !== expectedInventoryVersion) reject("VERSION_CONFLICT", 409);
      const booking = state.bookings.find((item) => item.id === bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      if (booking.version !== expectedBookingVersion) reject("VERSION_CONFLICT", 409);
      if (booking.status === "cancelled") reject("ORDER_CANCELLED", 409);
      if (booking.status === "held") reject("HOLD_RELEASE_REQUIRED", 409);
      if (booking.source === "external") reject("SOURCE_CANCEL_REQUIRES_REVIEW", 409);
      if (principal.origin === "os" && netReceived(booking) !== 0)
        reject("CANCELLATION_REQUIRES_SETTLEMENT", 409);
      const previousSync = booking.channelSyncState;
      booking.status = "cancelled";
      booking.version++;
      if (state.channel.mode === "owlnest") {
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
            state: "sync_pending", cells: cells.map((cell) => ({ ...cell, desired: "open" })),
            createdAt: new Date().toISOString(), verifiedAt: null, providerVersion: null });
          state.fences.push({ key: operationKey, cells, reason: "channel_pending" });
        }
      }
      state.version++;
      const response = makeBookingReceipt(state, booking);
      saveReceipt(state, principal, requestKey, "booking:cancel", hash, { ...response });
      emit(tx, state, "booking.cancelled", booking, principal, requestKey);
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
      cells: operation.cells, verifiedAt: operation.verifiedAt, providerVersion: operation.providerVersion };
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
    const pending = state.operations.filter((operation) => operation.state === "sync_pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
        left.key.localeCompare(right.key));
    return { propertyId, inventoryVersion: state.version,
      operations: pending.slice(0, limit).map((operation) => ({
        key: operation.key, bookingId: operation.bookingId,
        bookingVersion: operation.bookingVersion, state: operation.state,
        createdAt: operation.createdAt, cells: operation.cells,
      })), hasMore: pending.length > limit };
  }

  async recordChannelReadback(principal: Principal, input: ReadbackInput): Promise<Record<string, unknown>> {
    uuid(input.propertyId); uuid(input.operationKey); nonempty(input.providerVersion, 128);
    const observed = timestamp(input.observedAt), now = Date.now();
    if (observed > now + 60_000 || observed < now - 300_000) reject("STALE_READBACK", 409);
    if (!Array.isArray(input.cells) || input.cells.length > 4096) reject("INVALID_INPUT");
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
      const operation = state.operations.find((item) => item.key === input.operationKey);
      if (!operation) reject("OPERATION_NOT_FOUND", 404);
      if (observed < timestamp(operation.createdAt)) reject("STALE_READBACK", 409);
      const booking = state.bookings.find((item) => item.id === operation.bookingId);
      if (!booking) reject("BOOKING_NOT_FOUND", 404);
      if (operation.state === "sync_verified") return { operationKey: operation.key, state: operation.state,
        bookingId: booking.id, bookingVersion: booking.version, inventoryVersion: state.version };
      const expected = operation.cells.map(keyOf).sort();
      const actual = input.cells.map(keyOf).sort();
      const complete = actual.length === expected.length &&
        actual.every((cell, index) => cell === expected[index]);
      const desiredByCell = new Map(operation.cells.map((cell) => [keyOf(cell), cell.desired]));
      const providerMatches = complete && input.cells.every((cell) =>
        desiredByCell.get(keyOf(cell)) === "closed" ? cell.count === 0 || cell.isLock :
          cell.count > 0 && !cell.isLock);
      const currentNights = new Set(booking.status === "confirmed" ?
        nightsFor(booking.stays, state.roomIds).map(keyOf) : []);
      // Payment or guest-detail edits may advance the booking version while
      // the same channel operation still owns these exact room nights.
      const correctBooking = booking.channelOperationKey === operation.key && operation.cells.every((cell) =>
        cell.desired === "closed" ?
          booking.status === "confirmed" && currentNights.has(keyOf(cell)) ||
          !currentNights.has(keyOf(cell)) && hasConflict(state, [cell], booking.id, operation.key) :
          (booking.status === "confirmed" || booking.status === "cancelled") &&
          !currentNights.has(keyOf(cell)) &&
          !hasConflict(state, [cell], booking.id, operation.key));
      operation.observations ??= [];
      if (operation.observations.length >= 1000) reject("READBACK_LIMIT_REACHED", 409);
      operation.observations.push({ observedAt: input.observedAt, providerVersion: input.providerVersion,
        cells: structuredClone(input.cells), exact: providerMatches, accepted: providerMatches && correctBooking });
      if (!providerMatches || !correctBooking) {
        operation.state = "review_required";
        booking.channelSyncState = "review_required";
      } else {
        operation.state = "sync_verified";
        operation.verifiedAt = input.observedAt;
        operation.providerVersion = input.providerVersion;
        booking.channelSyncState = "verified";
        const sourceLink = state.sourceLinks.find((link) => link.bookingId === booking.id);
        const sourceVersionCurrent = sourceLink && !sourceLink.diverged &&
          sourceLink.lastAppliedBookingVersion === booking.version;
        booking.version++;
        if (sourceVersionCurrent) sourceLink.lastAppliedBookingVersion = booking.version;
        state.fences = state.fences.filter((fence) => fence.key !== operation.key);
      }
      state.version++;
      emit(tx, state, operation.state === "sync_verified" ? "channel.verified" :
        "channel.review_required", booking, principal, operation.key);
      return { operationKey: operation.key, state: operation.state, bookingId: booking.id,
        bookingVersion: booking.version, inventoryVersion: state.version };
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
      ...(booking ? { sourceFacts: { totalCents: booking.totalCents,
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
      if ((link?.sourceVersion ?? null) !== input.previousSourceVersion ||
        link?.sourceVersion === input.sourceVersion)
        return review("SOURCE_VERSION_CONFLICT", [...cells,
          ...(linkedBooking ? nightsFor(linkedBooking.stays, state.roomIds) : [])]);
      if (link?.diverged) return review("SOURCE_REVIEW_OPEN", [...cells,
        ...(linkedBooking ? nightsFor(linkedBooking.stays, state.roomIds) : [])]);
      if (link?.bookingId && (!linkedBooking || linkedBooking.version !== link.lastAppliedBookingVersion))
        return review("SOURCE_DIVERGED", [...cells, ...(linkedBooking ? nightsFor(linkedBooking.stays, state.roomIds) : [])]);
      if (input.kind === "upsert" && link && link.tombstoneNights.length)
        return review("SOURCE_TOMBSTONE_REACTIVATION", [...cells, ...link.tombstoneNights]);
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
      if (!link || !booking || link.diverged || link.tombstoneNights.length ||
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
