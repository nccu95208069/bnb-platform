import { randomUUID } from "node:crypto";
import { digest } from "../customer-workspaces/auth.ts";
import { bookingsOverlap, businessDate, financeSummary, propertyReadiness } from "../customer-workspaces/domain.ts";
import { occupiesInventory } from "../customer-workspaces/hold-state.ts";
import type { Change, CustomerStore } from "../customer-workspaces/store.ts";
import type { Booking, Workspace } from "../customer-workspaces/types.ts";
import { authorizedGrant, grantOwnerActive, type SourceGrant } from "./grants.ts";

// The wire objects in this file intentionally match TenantLineCommands' injected
// client protocol. The LINE adapter still authenticates with its private grant
// token; chat IDs and the grant object are only selectors, never credentials.
const REAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER = /^U[a-f0-9]{32}$/;
const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;
const FIELDS = ["guest_name", "guest_phone", "check_in", "check_out", "room_ids", "guest_count", "total", "note"] as const;
type Field = typeof FIELDS[number];
type Draft = { action: "create" | "update" | "cancel"; request_key: string; order_id: string | null;
  expected_order_version: number; changes: Partial<Record<Field, unknown>> };
type Scope = { account_id: string; workspace_id: string; property_id: string };
type Snapshot = Scope & { order_id: string; order_version: number; status: Booking["status"];
  source: string; guest_name: string; guest_phone: string; guest_count: number; room_ids: string[];
  check_in: string; check_out: string; total: string; received: string; note: string;
  refund_review_required?: true };
type Preview = Scope & { verified: true; request_key: string; preview_token: string;
  expires_at: number; workspace_version: number; order_version: number;
  before: Snapshot | null; after: Snapshot; refund_review_allowed: boolean };
type PreviewRecord = { grant_id: string; grant_version: number; draft_hash: string;
  preview_hash: string; preview: Preview; draft: Draft; state: "preview" | "rejected" };
type Receipt = Scope & { verified: true; state: "committed"; request_key: string;
  preview_hash: string; order_id: string; order_version: number; workspace_version: number;
  grant_id: string; applied_at: string };
const previewKey = (grant: string, key: string) => `source:line-preview:${grant}:${key}`;
const receiptKey = (grant: string, key: string) => `source:line-receipt:${grant}:${key}`;
function requireUuid(value: unknown) {
  if (typeof value !== "string" || !REAL_UUID.test(value)) throw Error("INVALID_INPUT");
  return value;
}
function exact(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(k => !keys.includes(k))) throw Error("INVALID_INPUT");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("INVALID_INPUT");
  return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw Error("INVALID_INPUT");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
function money(value: number) {
  if (!Number.isSafeInteger(Math.round(value * 100)) || value < 0 || value > 100_000_000 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) throw Error("ORDER_UNVERIFIED");
  return (Math.round(value * 100) / 100).toFixed(2);
}
function amount(value: unknown) {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw Error("INVALID_INPUT");
  const number = Number(value);
  money(number);
  return number;
}
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw Error("INVALID_INPUT");
  return value;
}
function stay(checkIn: string, checkOut: string) {
  const nights = (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000;
  if (nights < 1 || nights > 365) throw Error("INVALID_INPUT");
}
function rooms(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10 ||
    value.some(v => typeof v !== "string" || !REAL_UUID.test(v)) || new Set(value).size !== value.length)
    throw Error("INVALID_INPUT");
  return value as string[];
}
function validateDraft(value: unknown): Draft {
  const d = record(value);
  exact(d, ["action", "request_key", "order_id", "expected_order_version", "changes"]);
  if (!["create", "update", "cancel"].includes(String(d.action))) throw Error("INVALID_INPUT");
  requireUuid(d.request_key);
  if (d.action === "create" ? d.order_id !== null || d.expected_order_version !== 0 :
    !REAL_UUID.test(String(d.order_id)) || !Number.isSafeInteger(d.expected_order_version) || Number(d.expected_order_version) < 1)
    throw Error("INVALID_INPUT");
  const changes = record(d.changes);
  if (Object.keys(changes).some(k => !FIELDS.includes(k as Field)) ||
    (d.action === "cancel" && Object.keys(changes).length !== 0) ||
    (d.action === "update" && Object.keys(changes).length === 0) ||
    (d.action === "create" && ["guest_name", "guest_phone", "check_in", "check_out", "room_ids", "guest_count", "total"].some(k => !(k in changes))))
    throw Error("INVALID_INPUT");
  for (const [key, field] of Object.entries(changes)) {
    if (key === "check_in" || key === "check_out") date(field);
    else if (key === "room_ids") rooms(field);
    else if (key === "guest_count") {
      if (!Number.isSafeInteger(field) || Number(field) < 1 || Number(field) > 100) throw Error("INVALID_INPUT");
    } else if (key === "total") amount(field);
    else if (typeof field !== "string" || !field || field.length > (key === "note" ? 1000 : 100) ||
      [...field].some(c => c.charCodeAt(0) < 32)) throw Error("INVALID_INPUT");
  }
  return d as Draft;
}
function ownerActor(grant: SourceGrant) {
  return `line-owner:${digest(JSON.stringify([grant.propertyId, grant.sourceAccount, grant.ownerSubject]))}`;
}
function source(booking: Booking) { return booking.actor.startsWith("line-owner:") ? "line" :
  booking.platform || booking.entry; }
function snapshot(booking: Booking, scope: Scope): Snapshot {
  const received = financeSummary(booking).received;
  if (!booking.guestName || !booking.contact || !booking.lineOwner?.guestCount ||
    booking.total === null || received === null ||
    !booking.roomIds.length || !REAL_UUID.test(booking.id)) throw Error("ORDER_UNVERIFIED");
  const result: Snapshot = { ...scope, order_id: booking.id, order_version: booking.version,
    status: booking.status, source: source(booking), guest_name: booking.guestName,
    guest_phone: booking.contact, guest_count: booking.lineOwner.guestCount,
    room_ids: booking.roomIds, check_in: booking.checkIn, check_out: booking.checkOut,
    total: money(booking.total), received: money(received), note: booking.notes ?? "" };
  if (booking.lineOwner.refundReviewRequired) result.refund_review_required = true;
  return result;
}
function lineScope(grant: SourceGrant): Scope {
  return { account_id: grant.ownerAccountId, workspace_id: grant.workspaceId, property_id: grant.propertyId };
}
async function resolve(store: CustomerStore, grantInput: unknown, authorization: string | null) {
  const selection = record(grantInput);
  exact(selection, ["account_id", "grant_id", "grant_version", "channel_id", "user_id", "workspace_id", "property_id", "property_name"]);
  const { saved, grant } = await authorizedGrant(store, selection.grant_id, authorization, selection.grant_version, true);
  const wsKey = `workspace:${grant.workspaceId}`, wsSnapshot = await store.read<Workspace>(wsKey), workspace = wsSnapshot.value;
  const property = workspace?.properties.find(p => p.id === grant.propertyId);
  if (grant.provider !== "line" || !grant.sourceAccount?.startsWith("line:") ||
    !USER.test(grant.ownerSubject ?? "") || !property || !workspace ||
    !grantOwnerActive(workspace, grant) ||
    selection.account_id !== grant.ownerAccountId || selection.workspace_id !== grant.workspaceId ||
    selection.property_id !== grant.propertyId || selection.grant_id !== grant.id ||
    selection.channel_id !== grant.sourceAccount.slice(5) || selection.user_id !== grant.ownerSubject ||
    selection.property_name !== property.name || !SAFE.test(String(selection.channel_id))) throw Error("FORBIDDEN");
  return { grant, saved, workspace, wsSnapshot, wsKey, property, scope: lineScope(grant) };
}
function afterDraft(draft: Draft, before: Snapshot | null, scope: Scope, newId: string): Snapshot {
  const c = draft.changes;
  const after: Snapshot = { ...(before ?? { ...scope, order_id: newId, order_version: 0,
    status: "confirmed", source: "line", received: "0.00", note: "" } as Snapshot),
    order_version: draft.expected_order_version + 1 };
  for (const [key, value] of Object.entries(c)) (after as unknown as Record<string, unknown>)[key] = value;
  if (draft.action === "cancel") {
    after.status = "cancelled";
    if (Number(after.received) > 0) after.refund_review_required = true;
  }
  stay(date(after.check_in), date(after.check_out));
  rooms(after.room_ids);
  if (after.guest_count < 1 || after.guest_count > 100) throw Error("INVALID_INPUT");
  after.total = money(amount(after.total));
  return after;
}
function authorizeMutation(workspace: Workspace, grant: SourceGrant, after: Snapshot, before: Snapshot | null, action: Draft["action"]) {
  const property = workspace.properties.find(p => p.id === grant.propertyId)!;
  if (!propertyReadiness(workspace, property).complete ||
    workspace.reviewRecords?.some(r => r.propertyId === property.id)) throw Error("IMPORT_INCOMPLETE");
  if (workspace.calendarSources?.some(s => s.propertyId === property.id && s.mode === "connected"))
    throw Error("CALENDAR_SOURCE_OWNS_OCCUPANCY");
  if (after.room_ids.some(id => !property.rooms.some(r => r.id === id)) ||
    (property.setup?.coverageFrom && after.check_in < property.setup.coverageFrom) ||
    (property.setup?.coverageTo && after.check_out > property.setup.coverageTo)) throw Error("SOURCE_COVERAGE");
  const existing = before && workspace.bookings.find(b => b.id === before.order_id && b.propertyId === property.id);
  if (action !== "create" && (!existing || existing.version !== before?.order_version ||
    existing.actor !== ownerActor(grant) || existing.status !== "confirmed")) throw Error("VERSION_CONFLICT");
  if (action !== "cancel") {
    const window = { checkIn: after.check_in, checkOut: after.check_out, roomIds: after.room_ids };
    if (workspace.bookings.some(b => b.id !== existing?.id && b.propertyId === property.id && occupiesInventory(b) && bookingsOverlap(b, window)) ||
      workspace.blocks?.some(b => b.propertyId === property.id && b.status === "active" && bookingsOverlap(b, window)) ||
      workspace.integrationFences?.some(f => f.propertyId === property.id && bookingsOverlap(f, window))) throw Error("ROOM_CONFLICT");
    if (existing && (financeSummary(existing).received ?? Infinity) > Number(after.total)) throw Error("CANCELLATION_REQUIRES_SETTLEMENT");
  }
  return existing ?? null;
}
function receiptResponse(receipt: Receipt) {
  const { grant_id: _grantId, applied_at: _at, ...response } = receipt;
  void _grantId; void _at;
  return response;
}
export async function sourceOwnerRead(store: CustomerStore, input: Record<string, unknown>, authorization: string | null) {
  const action = input.action;
  if (action === "list") exact(input, ["action", "grant"]);
  else if (action === "inspect") exact(input, ["action", "grant", "order_id"]);
  else if (action === "status") exact(input, ["action", "grant", "request_key"]);
  else throw Error("INVALID_INPUT");
  const { grant, workspace, scope } = await resolve(store, input.grant, authorization);
  if (action === "status") {
    const requestKey = requireUuid(input.request_key), receipt = (await store.read<Receipt>(receiptKey(grant.id, requestKey))).value;
    if (receipt) return receiptResponse(receipt);
    const pending = (await store.read<PreviewRecord>(previewKey(grant.id, requestKey))).value;
    return { verified: true, ...scope, request_key: requestKey, state: pending?.state === "rejected" ? "rejected" : "not_found",
      ...(pending?.state === "rejected" ? { preview_hash: pending.preview_hash } : {}) };
  }
  const bookings = workspace.bookings.filter(b => b.propertyId === grant.propertyId);
  if (action === "list") {
    if (bookings.length > 100) throw Error("LIMIT_REACHED");
    const manageable = bookings.filter(b => b.actor === ownerActor(grant) && !!b.lineOwner);
    return { verified: true, ...scope, orders: manageable.map(b => snapshot(b, scope)),
      unavailable_count: bookings.length - manageable.length };
  }
  const booking = bookings.find(b => b.id === requireUuid(input.order_id));
  if (!booking) throw Error("NOT_FOUND");
  return snapshot(booking, scope);
}
export async function sourceOwnerCommand(store: CustomerStore, input: Record<string, unknown>,
  authorization: string | null, now = new Date()) {
  if (input.action === "preview") exact(input, ["action", "grant", "draft"]);
  else if (input.action === "commit") exact(input, ["action", "grant", "confirmation"]);
  else throw Error("INVALID_INPUT");
  const context = await resolve(store, input.grant, authorization);
  const { grant, workspace, wsSnapshot, wsKey, scope } = context;
  if (input.action === "preview") {
    const draft = validateDraft(input.draft), key = previewKey(grant.id, draft.request_key);
    const draftHash = digest(canonical(draft)), previous = await store.read<PreviewRecord>(key);
    if (previous.value) {
      if (previous.value.draft_hash !== draftHash) throw Error("IDEMPOTENCY_CONFLICT");
      if (previous.value.state === "rejected" || previous.value.preview.expires_at <= now.getTime()/1000) throw Error("CONNECTION_EXPIRED");
      return previous.value.preview;
    }
    const beforeBooking = draft.order_id ? workspace.bookings.find(b => b.id === draft.order_id && b.propertyId === grant.propertyId) : null;
    if (draft.order_id && !beforeBooking) throw Error("NOT_FOUND");
    const before = beforeBooking ? snapshot(beforeBooking, scope) : null;
    if (draft.action !== "create" && (before?.order_version !== draft.expected_order_version ||
      beforeBooking?.actor !== ownerActor(grant) || beforeBooking.status !== "confirmed")) throw Error("VERSION_CONFLICT");
    const after = afterDraft(draft, before, scope, randomUUID());
    authorizeMutation(workspace, grant, after, before, draft.action);
    const preview: Preview = { verified: true, ...scope, request_key: draft.request_key,
      preview_token: randomUUID(), expires_at: Math.floor(now.getTime()/1000)+600,
      workspace_version: workspace.version, order_version: draft.expected_order_version,
      before, after, refund_review_allowed: draft.action === "cancel" };
    const next: PreviewRecord = { grant_id: grant.id, grant_version: grant.version,
      draft_hash: draftHash, preview_hash: digest(canonical(preview)), preview, draft, state: "preview" };
    await store.limit(`source-line-preview:${grant.id}`, 150);
    await store.commit([{ key, before: null, after: next, ttlSeconds: 86400 },
      { key: `source:grant:${grant.id}`, before: context.saved.raw, after: grant }]);
    return preview;
  }
  const confirmation = record(input.confirmation);
  exact(confirmation, ["request_key", "preview_token", "preview_hash", "expected_workspace_version", "expected_order_version"]);
  const requestKey = requireUuid(confirmation.request_key), key = previewKey(grant.id, requestKey);
  if (typeof confirmation.preview_hash !== "string" || !/^[a-f0-9]{64}$/.test(confirmation.preview_hash)) throw Error("INVALID_INPUT");
  const already = (await store.read<Receipt>(receiptKey(grant.id, requestKey))).value;
  if (already) {
    if (already.preview_hash !== confirmation.preview_hash) throw Error("IDEMPOTENCY_CONFLICT");
    return receiptResponse(already);
  }
  const saved = await store.read<PreviewRecord>(key), pending = saved.value;
  if (!pending || pending.grant_id !== grant.id || pending.grant_version !== grant.version ||
    pending.preview_hash !== confirmation.preview_hash || pending.preview.preview_token !== confirmation.preview_token ||
    pending.preview.workspace_version !== confirmation.expected_workspace_version ||
    pending.preview.order_version !== confirmation.expected_order_version ||
    digest(canonical(pending.preview)) !== pending.preview_hash) throw Error("PREVIEW_CHANGED");
  if (pending.state !== "preview" || pending.preview.expires_at <= now.getTime()/1000) throw Error("CONNECTION_EXPIRED");
  const { draft, preview } = pending;
  if (workspace.version !== preview.workspace_version) {
    await store.commit([{ key, before: saved.raw, after: { ...pending, state: "rejected" } }]);
    return { verified: true, ...scope, request_key: requestKey, state: "rejected", preview_hash: pending.preview_hash };
  }
  const beforeBooking = draft.order_id ? workspace.bookings.find(b => b.id === draft.order_id && b.propertyId === grant.propertyId) : null;
  const before = beforeBooking ? snapshot(beforeBooking, scope) : null;
  if (canonical(before) !== canonical(preview.before)) throw Error("PREVIEW_CHANGED");
  const after = preview.after;
  authorizeMutation(workspace, grant, after, before, draft.action);
  await store.limit(`source-line-commit:${grant.id}`, 100);
  if (workspace.bookings.length >= 5000) throw Error("LIMIT_REACHED");
  const at = now.toISOString(), booking: Booking = beforeBooking ? {
    ...beforeBooking, version: after.order_version, status: after.status,
    guestName: after.guest_name, contact: after.guest_phone, checkIn: after.check_in,
    checkOut: after.check_out, roomIds: after.room_ids, total: amount(after.total),
    notes: after.note || null,
    lineOwner: { guestCount: after.guest_count,
      ...(after.refund_review_required ? { refundReviewRequired: true } : {}) },
  } : { id: after.order_id, version: 1, propertyId: grant.propertyId,
    guestName: after.guest_name, contact: after.guest_phone, checkIn: after.check_in,
    checkOut: after.check_out, roomIds: after.room_ids, total: amount(after.total),
    notes: after.note || null, payments: [], status: "confirmed", lineOwner: { guestCount: after.guest_count },
    guestNotified: false, createdAt: at, bookedAt: businessDate(at), bookedAtSource: "manual",
    bookedAtTimeZone: "Asia/Taipei", platform: "LINE", actor: ownerActor(grant), entry: "os",
    requestKey, requestHash: pending.preview_hash };
  if (canonical(snapshot(booking, scope)) !== canonical(after)) throw Error("PREVIEW_CHANGED");
  const next: Workspace = { ...workspace, version: workspace.version+1,
    bookings: beforeBooking ? workspace.bookings.map(b => b.id === booking.id ? booking : b) : [...workspace.bookings, booking],
    audit: [...workspace.audit, { at, actor: ownerActor(grant), action: `line-owner.${draft.action}`, targetId: booking.id }] };
  const receipt: Receipt = { verified: true, state: "committed", ...scope, request_key: requestKey,
    preview_hash: pending.preview_hash, order_id: booking.id, order_version: booking.version,
    workspace_version: next.version, grant_id: grant.id, applied_at: at };
  const changes: Change[] = [
    { key: wsKey, before: wsSnapshot.raw, after: next },
    { key: receiptKey(grant.id, requestKey), before: null, after: receipt },
    { key, before: saved.raw, after: pending },
    { key: `source:grant:${grant.id}`, before: context.saved.raw, after: grant },
  ];
  try { await store.commit(changes); }
  catch (error) {
    const recovered = (await store.read<Receipt>(receiptKey(grant.id, requestKey))).value;
    if (!recovered) throw error;
    if (recovered.preview_hash !== pending.preview_hash) throw Error("IDEMPOTENCY_CONFLICT");
    return receiptResponse(recovered);
  }
  const verified = (await store.read<Receipt>(receiptKey(grant.id, requestKey))).value;
  const readback = (await store.read<Workspace>(wsKey)).value?.bookings.find(b => b.id === booking.id);
  if (!verified || !readback || verified.preview_hash !== pending.preview_hash ||
    readback.version < booking.version || readback.version === booking.version &&
    canonical(snapshot(readback, scope)) !== canonical(after)) throw Error("WRITE_UNCONFIRMED");
  return receiptResponse(verified);
}
