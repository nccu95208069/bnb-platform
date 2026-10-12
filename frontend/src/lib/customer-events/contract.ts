import { timingSafeEqual } from "node:crypto";
import { digest } from "../customer-workspaces/auth.ts";
import type { CustomerStore } from "../customer-workspaces/store.ts";
import type { Workspace } from "../customer-workspaces/types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const SOURCE_VERSION = /^[A-Za-z0-9._:-]{1,128}$/;
const SOURCES = ["website", "line", "gmail", "owlnest"] as const;
const KINDS = ["booking.created", "booking.changed", "booking.cancelled", "hold.converted"] as const;
type Source = (typeof SOURCES)[number];
type Kind = (typeof KINDS)[number];
export type EventClient = {
  id: string;
  token_sha256: string;
  scopes: { workspace_id: string; property_ids: string[] }[];
  sources: Source[];
};
export type TenantEvent = {
  schema: 1;
  event_id: string;
  workspace_id: string;
  property_id: string;
  order_id: string;
  order_version: number;
  source_version: string;
  source: Source;
  kind: Kind;
  occurred_at: string;
  verified: true;
  check_in: string;
  check_out: string;
  room_ids: string[];
};
type Receipt = {
  schema: 1;
  clientId: string;
  bodyHash: string;
  eventId: string;
  workspaceId: string;
  propertyId: string;
  orderId: string;
  orderVersion: number;
  sourceVersion: string;
  source: Source;
  kind: Kind;
  workspaceVersion: number;
  completedAt: string;
};

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function configuredClients(): EventClient[] {
  if (process.env.CUSTOMER_EVENTS_ENABLED !== "true") throw new Error("EVENTS_UNAVAILABLE");
  let clients: unknown;
  try { clients = JSON.parse(process.env.CUSTOMER_EVENT_CLIENTS ?? "null"); }
  catch { throw new Error("EVENTS_UNAVAILABLE"); }
  if (!Array.isArray(clients) || clients.length < 1 || clients.length > 50)
    throw new Error("EVENTS_UNAVAILABLE");
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const item of clients) {
    const client = item as EventClient;
    if (
      !client || typeof client !== "object" ||
      typeof client.id !== "string" || !EVENT_ID.test(client.id) || ids.has(client.id) ||
      typeof client.token_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(client.token_sha256) || hashes.has(client.token_sha256) ||
      !Array.isArray(client.sources) || !client.sources.length ||
      new Set(client.sources).size !== client.sources.length ||
      client.sources.some((source) => !SOURCES.includes(source)) ||
      !Array.isArray(client.scopes) || !client.scopes.length ||
      client.scopes.some((scope) =>
        !scope || !uuid(scope.workspace_id) || !Array.isArray(scope.property_ids) ||
        !scope.property_ids.length || new Set(scope.property_ids).size !== scope.property_ids.length ||
        scope.property_ids.some((property) => !uuid(property))
      )
    ) throw new Error("EVENTS_UNAVAILABLE");
    ids.add(client.id);
    hashes.add(client.token_sha256);
  }
  return clients as EventClient[];
}
export function eventClient(authorization: string | null): EventClient {
  const match = /^Bearer ([A-Za-z0-9._~+/-]{32,256})$/.exec(authorization ?? "");
  if (!match) throw new Error("UNAUTHORIZED");
  const supplied = Buffer.from(digest(match[1]), "hex");
  const client = configuredClients().find((candidate) =>
    timingSafeEqual(Buffer.from(candidate.token_sha256, "hex"), supplied)
  );
  if (!client) throw new Error("UNAUTHORIZED");
  return client;
}
function scope(client: EventClient, workspaceId: string, propertyId: string, source?: Source) {
  if (
    !client.scopes.some((s) => s.workspace_id === workspaceId && s.property_ids.includes(propertyId)) ||
    (source && !client.sources.includes(source))
  ) throw new Error("FORBIDDEN");
}
function eventInput(value: unknown): TenantEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_INPUT");
  const input = value as Record<string, unknown>;
  const keys = ["schema", "event_id", "workspace_id", "property_id", "order_id", "order_version", "source_version", "source", "kind", "occurred_at", "verified", "check_in", "check_out", "room_ids"];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key)))
    throw new Error("INVALID_INPUT");
  if (
    input.schema !== 1 || typeof input.event_id !== "string" || !EVENT_ID.test(input.event_id) ||
    !uuid(input.workspace_id) || !uuid(input.property_id) || !uuid(input.order_id) ||
    !Number.isSafeInteger(input.order_version) || Number(input.order_version) < 1 ||
    typeof input.source_version !== "string" || !SOURCE_VERSION.test(input.source_version) ||
    !SOURCES.includes(input.source as Source) || !KINDS.includes(input.kind as Kind) ||
    input.verified !== true ||
    typeof input.occurred_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.occurred_at) ||
    !Number.isFinite(Date.parse(input.occurred_at)) ||
    !calendarDate(input.check_in) || !calendarDate(input.check_out) || input.check_in >= input.check_out ||
    !Array.isArray(input.room_ids) || !input.room_ids.length || input.room_ids.length > 30 ||
    input.room_ids.some((id: unknown) => !uuid(id)) || new Set(input.room_ids).size !== input.room_ids.length
  ) throw new Error("INVALID_INPUT");
  return input as TenantEvent;
}
function receiptKey(client: EventClient, eventId: string) {
  if (!EVENT_ID.test(eventId)) throw new Error("INVALID_INPUT");
  return `customer-event:${client.id}:${eventId}`;
}
function output(receipt: Receipt) {
  return {
    schema: 1, event_id: receipt.eventId, order_id: receipt.orderId,
    order_version: receipt.orderVersion, source_version: receipt.sourceVersion,
    workspace_version: receipt.workspaceVersion, verified: true,
    completed_at: receipt.completedAt,
    status_url: `/api/integration/customer-events/v1?event_id=${encodeURIComponent(receipt.eventId)}`,
  };
}
export async function eventReceipt(store: CustomerStore, client: EventClient, eventId: string) {
  const receipt = (await store.read<Receipt>(receiptKey(client, eventId))).value;
  if (!receipt || receipt.clientId !== client.id) throw new Error("NOT_FOUND");
  scope(client, receipt.workspaceId, receipt.propertyId, receipt.source);
  return output(receipt);
}
export async function acceptTenantEvent(store: CustomerStore, client: EventClient, value: unknown) {
  const input = eventInput(value);
  scope(client, input.workspace_id, input.property_id, input.source);
  await store.limit(`customer-event:${client.id}:${input.property_id}`, 300);
  const key = receiptKey(client, input.event_id);
  const bodyHash = digest(JSON.stringify(input));
  const existing = (await store.read<Receipt>(key)).value;
  if (existing) {
    if (existing.bodyHash !== bodyHash) throw new Error("IDEMPOTENCY_CONFLICT");
    return output(existing);
  }
  const workspaceKey = `workspace:${input.workspace_id}`;
  const snapshot = await store.read<Workspace>(workspaceKey);
  const workspace = snapshot.value;
  const property = workspace?.properties.find((item) => item.id === input.property_id);
  const booking = workspace?.bookings.find((item) => item.id === input.order_id && item.propertyId === input.property_id);
  if (!workspace || !property || !booking) throw new Error("SOURCE_NOT_VERIFIED");
  const sameRooms = booking.roomIds.length === input.room_ids.length &&
    booking.roomIds.every((roomId) => input.room_ids.includes(roomId));
  if (
    booking.version !== input.order_version || !sameRooms ||
    booking.checkIn !== input.check_in || booking.checkOut !== input.check_out ||
    input.room_ids.some((roomId) => !property.rooms.some((room) => room.id === roomId)) ||
    (input.kind === "booking.cancelled" && booking.status !== "cancelled") ||
    (input.kind === "hold.converted" && (booking.status !== "confirmed" || booking.hold?.state !== "converted")) ||
    (input.kind === "booking.created" && booking.status === "cancelled")
  ) throw new Error("SOURCE_NOT_VERIFIED");
  const receipt: Receipt = {
    schema: 1, clientId: client.id, bodyHash, eventId: input.event_id,
    workspaceId: input.workspace_id, propertyId: input.property_id,
    orderId: input.order_id, orderVersion: input.order_version,
    sourceVersion: input.source_version, source: input.source, kind: input.kind,
    workspaceVersion: workspace.version, completedAt: new Date().toISOString(),
  };
  try {
    await store.commit([
      { key, before: null, after: receipt, ttlSeconds: 30 * 86400 },
      // This unchanged write fences any concurrent order mutation at readback.
      { key: workspaceKey, before: snapshot.raw, after: workspace },
    ]);
  } catch (error) {
    const replay = (await store.read<Receipt>(key)).value;
    if (replay) {
      if (replay.bodyHash !== bodyHash) throw new Error("IDEMPOTENCY_CONFLICT");
      return output(replay);
    }
    throw error;
  }
  return output(receipt);
}
