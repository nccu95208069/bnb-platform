import { randomUUID } from "node:crypto";
import { digest } from "../customer-workspaces/auth.ts";
import { bookingsOverlap, businessDate } from "../customer-workspaces/domain.ts";
import { occupiesInventory } from "../customer-workspaces/hold-state.ts";
import type { Change, CustomerStore } from "../customer-workspaces/store.ts";
import type { Booking, Workspace } from "../customer-workspaces/types.ts";
import { authorizedGrant, grantOwnerActive, type SourceGrant } from "./grants.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[A-Za-z0-9._:-]{1,128}$/;
const EXTERNAL_ID = /^[^\x00-\x1f\x7f]{1,160}$/;
type SourceOrder = { workspaceId: string; propertyId: string; provider: "gmail" | "line";
  sourceAccount: string; externalOrderId: string; bookingId: string | null; sourceVersion: string; requestHash: string };
type Receipt = { bodyHash: string; eventId: string; requestKey: string; grantId: string; workspaceId: string;
  propertyId: string; bookingId: string | null; orderVersion: number; workspaceVersion: number;
  kind: "upsert" | "cancel"; sourceVersion: string; sourceAccount: string; externalOrderId: string;
  status: "confirmed" | "cancelled"; guestName: string | null;
  checkIn: string; checkOut: string; roomIds: string[]; verifiedAt: string };
const requestReceiptKey = (grantId: string, key: string) => `source:booking-request:${grantId}:${key}`;
const eventReceiptKey = (grantId: string, key: string) => `source:booking-event:${grantId}:${key}`;
const orderKey = (workspaceId: string, propertyId: string, provider: string, sourceAccount: string, externalId: string) =>
  `source:order:${workspaceId}:${propertyId}:${digest(JSON.stringify([provider, sourceAccount, externalId]))}`;
function uuid(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) throw Error("INVALID_INPUT");
  return value;
}
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw Error("INVALID_INPUT");
  return value;
}
function inputShape(input: Record<string, unknown>) {
  const keys = ["schemaVersion", "grantId", "grantVersion", "eventId", "requestKey", "kind",
    "sourceAccount", "externalOrderId", "sourceVersion", "previousSourceVersion", "guestName",
    "expectedWorkspaceVersion", "checkIn", "checkOut", "roomIds"];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key)) ||
    input.schemaVersion !== 1 || !["upsert", "cancel"].includes(String(input.kind)) ||
    !VERSION.test(String(input.sourceVersion)) ||
    !(input.previousSourceVersion === null ||
      (typeof input.previousSourceVersion === "string" && VERSION.test(input.previousSourceVersion))) ||
    !EXTERNAL_ID.test(String(input.externalOrderId)) ||
    !(input.guestName === null || (typeof input.guestName === "string" &&
      input.guestName.length >= 1 && input.guestName.length <= 100 &&
      ![...input.guestName].some(c => c.charCodeAt(0) < 32))) ||
    !Number.isSafeInteger(input.expectedWorkspaceVersion) || Number(input.expectedWorkspaceVersion) < 1 ||
    !Array.isArray(input.roomIds) || input.roomIds.length < 1 || input.roomIds.length > 30 ||
    input.roomIds.some(id => typeof id !== "string" || !UUID.test(id)) ||
    new Set(input.roomIds).size !== input.roomIds.length) throw Error("INVALID_INPUT");
  uuid(input.grantId); uuid(input.eventId); uuid(input.requestKey);
  const checkIn = date(input.checkIn), checkOut = date(input.checkOut);
  if (checkIn >= checkOut || Date.parse(checkOut) - Date.parse(checkIn) > 365 * 86400000) throw Error("INVALID_INPUT");
  return { checkIn, checkOut, roomIds: input.roomIds as string[] };
}
async function output(store: CustomerStore, receipt: Receipt) {
  const workspace = (await store.read<Workspace>(`workspace:${receipt.workspaceId}`)).value;
  const booking = receipt.bookingId ? workspace?.bookings.find(b => b.id === receipt.bookingId && b.propertyId === receipt.propertyId) : null;
  if (!workspace || (receipt.bookingId && !booking)) throw Error("WRITE_UNCONFIRMED");
  return { schemaVersion: 1, verified: true, eventId: receipt.eventId, requestKey: receipt.requestKey,
    workspaceId: receipt.workspaceId, propertyId: receipt.propertyId, orderId: receipt.bookingId,
    orderVersion: receipt.orderVersion, workspaceVersion: receipt.workspaceVersion,
    sourceVersion: receipt.sourceVersion, appliedOrderVersion: receipt.orderVersion,
    appliedWorkspaceVersion: receipt.workspaceVersion, appliedAt: receipt.verifiedAt,
    sourceAccount: receipt.sourceAccount, externalOrderId: receipt.externalOrderId,
    status: receipt.status, guestName: receipt.guestName,
    checkIn: receipt.checkIn, checkOut: receipt.checkOut, roomIds: receipt.roomIds,
    current: booking ? { orderVersion: booking.version, workspaceVersion: workspace.version,
      status: booking.status, guestName: booking.guestName,
      checkIn: booking.checkIn, checkOut: booking.checkOut, roomIds: booking.roomIds } : null };
}
export async function sourceBookingStatus(store: CustomerStore, grantId: unknown,
  authorization: string | null, requestKey: unknown) {
  const id = uuid(grantId), key = uuid(requestKey);
  await authorizedGrant(store, id, authorization);
  const receipt = (await store.read<Receipt>(requestReceiptKey(id, key))).value;
  if (!receipt || receipt.grantId !== id) throw Error("NOT_FOUND");
  return output(store, receipt);
}
export async function sourceBookingLink(store: CustomerStore, grantId: unknown, grantVersion: unknown,
  authorization: string | null, sourceAccount: unknown, externalOrderId: unknown) {
  const id = uuid(grantId);
  if (!EXTERNAL_ID.test(String(externalOrderId))) throw Error("INVALID_INPUT");
  const { grant, saved, workspace, workspaceSnapshot } = await authorizedGrant(store, id, authorization, grantVersion, true);
  if ((grant.provider !== "gmail" && grant.provider !== "line") ||
    grant.sourceAccount !== sourceAccount) throw Error("FORBIDDEN");
  const key = orderKey(workspace.id, grant.propertyId, grant.provider, grant.sourceAccount!, String(externalOrderId));
  const linked = (await store.read<SourceOrder>(key)).value;
  // A source-link lookup and the workspace are separate keys. If either scope
  // changed during the read, return conflict rather than a mixed-version answer.
  const currentWorkspace = await store.read<Workspace>(`workspace:${workspace.id}`);
  const currentGrant = await store.read<SourceGrant>(`source:grant:${grant.id}`);
  if (currentWorkspace.raw !== workspaceSnapshot.raw || currentGrant.raw !== saved.raw) throw Error("VERSION_CONFLICT");
  if (linked && (linked.workspaceId !== workspace.id || linked.propertyId !== grant.propertyId ||
    linked.provider !== grant.provider || linked.sourceAccount !== grant.sourceAccount ||
    linked.externalOrderId !== externalOrderId)) throw Error("SOURCE_CONFLICT");
  const booking = linked?.bookingId ? workspace.bookings.find(b => b.id === linked.bookingId && b.propertyId === grant.propertyId) : null;
  if (linked?.bookingId && (!booking ||
    booking.actor !== `source:${grant.provider}:${digest(JSON.stringify([grant.sourceAccount, externalOrderId]))}`))
    throw Error("SOURCE_CONFLICT");
  return { schemaVersion: 1, verified: true, accountId: grant.ownerAccountId,
    workspaceId: workspace.id, propertyId: grant.propertyId, workspaceVersion: workspace.version,
    provider: grant.provider, sourceAccount: grant.sourceAccount, externalOrderId,
    exists: !!linked, sourceVersion: linked?.sourceVersion ?? null,
    orderId: linked?.bookingId ?? null, orderVersion: booking?.version ?? 0,
    status: booking?.status ?? (linked ? "cancelled" : null), guestName: booking?.guestName ?? null };
}
export async function mutateSourceBooking(store: CustomerStore, input: Record<string, unknown>,
  authorization: string | null, now = new Date()) {
  const stay = inputShape(input);
  const { saved: grantSnapshot, grant } = await authorizedGrant(store, input.grantId, authorization, input.grantVersion, true);
  if ((grant.provider !== "gmail" && grant.provider !== "line") || grant.sourceAccount !== input.sourceAccount)
    throw Error("FORBIDDEN");
  const bodyHash = digest(JSON.stringify(input)), requestKey = String(input.requestKey), eventId = String(input.eventId);
  const receiptKey = requestReceiptKey(grant.id, requestKey), prior = await store.read<Receipt>(receiptKey);
  if (prior.value) {
    if (prior.value.bodyHash !== bodyHash) throw Error("IDEMPOTENCY_CONFLICT");
    return output(store, prior.value);
  }
  const priorEvent = await store.read<Receipt>(eventReceiptKey(grant.id, eventId));
  if (priorEvent.value) throw Error("IDEMPOTENCY_CONFLICT");
  await store.limit(`source-booking:${grant.id}`, 600);
  const workspaceKey = `workspace:${grant.workspaceId}`, snapshot = await store.read<Workspace>(workspaceKey), workspace = snapshot.value;
  if (!workspace || !grantOwnerActive(workspace, grant)) throw Error("FORBIDDEN");
  if (workspace.version !== input.expectedWorkspaceVersion) throw Error("VERSION_CONFLICT");
  if (workspace.bookings.length >= 5000) throw Error("LIMIT_REACHED");
  const property = workspace.properties.find(p => p.id === grant.propertyId);
  if (!property || stay.roomIds.some(id => !property.rooms.some(r => r.id === id))) throw Error("INVALID_INPUT");
  const sourceKey = orderKey(workspace.id, property.id, grant.provider, grant.sourceAccount!, String(input.externalOrderId));
  const priorSource = await store.read<SourceOrder>(sourceKey), linked = priorSource.value;
  if (linked && (linked.workspaceId !== workspace.id || linked.propertyId !== property.id ||
    linked.provider !== grant.provider || linked.sourceAccount !== grant.sourceAccount ||
    linked.externalOrderId !== input.externalOrderId)) throw Error("SOURCE_CONFLICT");
  if ((linked?.sourceVersion ?? null) !== input.previousSourceVersion ||
    linked?.sourceVersion === input.sourceVersion) throw Error("SOURCE_VERSION_CONFLICT");
  const existing = linked?.bookingId ? workspace.bookings.find(b => b.id === linked.bookingId && b.propertyId === property.id) : null;
  if (linked?.bookingId && (!existing || existing.actor !== `source:${grant.provider}:${digest(JSON.stringify([grant.sourceAccount, input.externalOrderId]))}`))
    throw Error("SOURCE_CONFLICT");
  // A cancellation may arrive before its create event. Persist its source
  // version as a tombstone so an older create cannot later revive the room.
  if (input.kind === "cancel" && !existing) {
    const at = now.toISOString();
    const tombstone: SourceOrder = { workspaceId: workspace.id, propertyId: property.id,
      provider: grant.provider, sourceAccount: grant.sourceAccount!, externalOrderId: String(input.externalOrderId),
      bookingId: null, sourceVersion: String(input.sourceVersion), requestHash: bodyHash };
    const next: Workspace = { ...workspace, version: workspace.version + 1,
      audit: [...workspace.audit, { at, actor: `source:${grant.provider}`, action: "source.booking.cancelled.unmatched", targetId: grant.id }] };
    const receipt: Receipt = { bodyHash, eventId, requestKey, grantId: grant.id, workspaceId: workspace.id,
      propertyId: property.id, bookingId: null, orderVersion: 0, workspaceVersion: next.version,
      kind: "cancel", sourceVersion: String(input.sourceVersion), sourceAccount: grant.sourceAccount!,
      externalOrderId: String(input.externalOrderId), status: "cancelled", guestName: input.guestName as string | null,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut, roomIds: stay.roomIds, verifiedAt: at };
    try { await store.commit([
      { key: workspaceKey, before: snapshot.raw, after: next },
      { key: sourceKey, before: priorSource.raw, after: tombstone },
      { key: receiptKey, before: null, after: receipt },
      { key: eventReceiptKey(grant.id, eventId), before: null, after: receipt },
      { key: `source:grant:${grant.id}`, before: grantSnapshot.raw, after: grant },
    ]); }
    catch (error) {
      const recovered = (await store.read<Receipt>(receiptKey)).value;
      if (!recovered) throw error;
      if (recovered.bodyHash !== bodyHash) throw Error("IDEMPOTENCY_CONFLICT");
      return output(store, recovered);
    }
    return output(store, receipt);
  }
  if (existing && (existing.checkIn !== stay.checkIn || existing.checkOut !== stay.checkOut ||
    (input.kind === "cancel" && (existing.roomIds.length !== stay.roomIds.length ||
      existing.roomIds.some(id => !stay.roomIds.includes(id)))))) {
    // An amendment may change the room/date; cancellation must identify the
    // latest imported stay to avoid releasing an unrelated room-night.
    if (input.kind === "cancel") throw Error("SOURCE_CONFLICT");
  }
  const at = now.toISOString(), bookingId = existing?.id ?? randomUUID();
  const actor = `source:${grant.provider}:${digest(JSON.stringify([grant.sourceAccount, input.externalOrderId]))}`;
  const booking: Booking = existing ? { ...existing, version: existing.version + 1,
    checkIn: stay.checkIn, checkOut: stay.checkOut, roomIds: stay.roomIds,
    guestName: input.kind === "upsert" ? (input.guestName as string | null) ?? existing.guestName : existing.guestName,
    status: input.kind === "cancel" ? "cancelled" : "confirmed" } :
    { id: bookingId, version: 1, propertyId: property.id, guestName: input.guestName as string | null,
      checkIn: stay.checkIn, checkOut: stay.checkOut, roomIds: stay.roomIds, total: null, payments: [],
      contact: null, notes: null, status: "confirmed", guestNotified: false, createdAt: at,
      bookedAt: businessDate(at), bookedAtSource: "manual", bookedAtTimeZone: "Asia/Taipei",
      platform: grant.provider === "line" ? "LINE" : "OTA email", actor, entry: "os",
      requestKey, requestHash: bodyHash };
  const overlapping = input.kind === "upsert" && workspace.bookings.some(b =>
    b.id !== bookingId && b.propertyId === property.id && occupiesInventory(b) && bookingsOverlap(b, booking)) ||
    (input.kind === "upsert" && workspace.blocks?.some(b =>
      b.propertyId === property.id && b.status === "active" && bookingsOverlap(b, booking)) === true) ||
    (input.kind === "upsert" && workspace.integrationFences?.some(f =>
      f.propertyId === property.id && bookingsOverlap(f, booking)) === true);
  const reviewId = digest(`source-conflict:${workspace.id}:${bookingId}`);
  const reviews = (workspace.reviewRecords ?? []).filter(r => r.id !== reviewId);
  if (overlapping) reviews.push({ id: reviewId, propertyId: property.id, sourceId: grant.id,
    source: "external", label: `${grant.provider} 來源房晚衝突`, guestName: null,
    checkIn: stay.checkIn, checkOut: stay.checkOut, roomIds: stay.roomIds,
    issues: ["OCCUPANCY_CONFLICT"] });
  const nextWorkspace: Workspace = { ...workspace, version: workspace.version + 1,
    bookings: existing ? workspace.bookings.map(b => b.id === booking.id ? booking : b) :
      [...workspace.bookings, booking], reviewRecords: reviews,
    audit: [...workspace.audit, { at, actor, action: input.kind === "cancel" ? "source.booking.cancelled" :
      existing ? "source.booking.changed" : "source.booking.created", targetId: booking.id }] };
  const nextSource: SourceOrder = { workspaceId: workspace.id, propertyId: property.id,
    provider: grant.provider, sourceAccount: grant.sourceAccount!, externalOrderId: String(input.externalOrderId),
    bookingId, sourceVersion: String(input.sourceVersion), requestHash: bodyHash };
  const receipt: Receipt = { bodyHash, eventId, requestKey, grantId: grant.id, workspaceId: workspace.id,
    propertyId: property.id, bookingId, orderVersion: booking.version, workspaceVersion: nextWorkspace.version,
    kind: input.kind as "upsert" | "cancel", sourceVersion: String(input.sourceVersion),
    sourceAccount: grant.sourceAccount!, externalOrderId: String(input.externalOrderId),
    status: booking.status === "cancelled" ? "cancelled" : "confirmed", guestName: booking.guestName,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut, roomIds: booking.roomIds, verifiedAt: at };
  const changes: Change[] = [
    { key: workspaceKey, before: snapshot.raw, after: nextWorkspace },
    { key: sourceKey, before: priorSource.raw, after: nextSource },
    { key: receiptKey, before: null, after: receipt },
    { key: eventReceiptKey(grant.id, eventId), before: null, after: receipt },
    { key: `source:grant:${grant.id}`, before: grantSnapshot.raw, after: grant },
  ];
  try { await store.commit(changes); }
  catch (error) {
    const recovered = (await store.read<Receipt>(receiptKey)).value;
    if (!recovered) throw error;
    if (recovered.bodyHash !== bodyHash) throw Error("IDEMPOTENCY_CONFLICT");
    return output(store, recovered);
  }
  const verified = (await store.read<Receipt>(receiptKey)).value;
  if (!verified || verified.bodyHash !== bodyHash || verified.bookingId !== bookingId) throw Error("WRITE_UNCONFIRMED");
  return output(store, verified);
}
