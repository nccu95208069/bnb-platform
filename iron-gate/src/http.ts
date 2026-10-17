import { GateError, IronGateService } from "./service.ts";
import type { AmendBookingInput, CreateBookingInput, CreateHoldInput, ExtendHoldInput, PaymentEventInput,
  Principal, ReadbackInput, SourceEventInput } from "./types.ts";

export type Authenticate = (request: Request) => Promise<Principal | null>;
const MAX_BODY_BYTES = 64 * 1024;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  } });
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new GateError("UNSUPPORTED_MEDIA_TYPE", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new GateError("INVALID_JSON", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new GateError("BODY_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== "object") throw Error("INVALID_JSON");
    return value as Record<string, unknown>;
  } catch { throw new GateError("INVALID_JSON", 400); }
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((field) => !(field in value)) || Object.keys(value).some((field) => !allowed.has(field)))
    throw new GateError("INVALID_INPUT", 400);
}
function requestKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (!value) throw new GateError("IDEMPOTENCY_KEY_REQUIRED", 400);
  return value;
}

/** Route adapter. Production must inject a durable repository and current, independently verified auth. */
export function createHandler(service: IronGateService, authenticate: Authenticate) {
  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "v1") return json({ error: { code: "NOT_FOUND" } }, 404);
      const principal = await authenticate(request);
      if (!principal) return json({ error: { code: "UNAUTHORIZED" } }, 401);

      if (parts[1] === "properties" && parts[2] && parts[3] === "bookings") {
        const propertyId = parts[2];
        if (parts.length === 4 && request.method === "GET") {
          return json(await service.listBookings(principal, propertyId, {
            limit: Number(url.searchParams.get("limit") ?? "50"),
            cursor: url.searchParams.get("cursor"),
            status: url.searchParams.get("status") as "held" | "confirmed" | "cancelled" | null,
            from: url.searchParams.get("from"), to: url.searchParams.get("to"),
          }));
        }
        if (parts.length === 4 && request.method === "POST") {
          const value = await body(request);
          exact(value, ["expectedInventoryVersion", "stays", "guestName", "contact", "notes", "totalCents", "bookedAt", "source"]);
          const result = await service.createBooking(principal, propertyId, requestKey(request), value as CreateBookingInput);
          return json(result, result.operationState === "sync_pending" ? 202 : 201);
        }
        if (parts.length === 5 && request.method === "GET") {
          return json(await service.getBooking(principal, propertyId, parts[4]));
        }
        if (parts.length === 5 && request.method === "PATCH") {
          const value = await body(request);
          exact(value, ["expectedBookingVersion", "expectedInventoryVersion", "changes"]);
          return json(await service.amendBooking(principal, propertyId, parts[4], requestKey(request),
            value as AmendBookingInput));
        }
        if (parts.length === 6 && parts[5] === "cancel" && request.method === "POST") {
          const value = await body(request);
          exact(value, ["expectedBookingVersion", "expectedInventoryVersion"]);
          const result = await service.cancelBooking(principal, propertyId, parts[4], requestKey(request),
            value.expectedBookingVersion as number, value.expectedInventoryVersion as number);
          return json(result, result.operationState === "sync_pending" ? 202 : 200);
        }
        if (parts.length === 6 && parts[5] === "payment-events" && request.method === "POST") {
          const value = await body(request);
          exact(value, ["expectedBookingVersion", "eventId", "kind", "amountCents", "currency",
            "evidenceRef", "occurredAt"]);
          return json(await service.recordPaymentEvent(principal, propertyId, parts[4], requestKey(request),
            value as PaymentEventInput), 201);
        }
      }
      if (parts[1] === "properties" && parts[2] && parts[3] === "events" &&
        parts.length === 4 && request.method === "GET") {
        return json(await service.listEvents(principal, parts[2],
          Number(url.searchParams.get("after") ?? "0"), Number(url.searchParams.get("limit") ?? "50")));
      }
      if (parts[1] === "properties" && parts[2] && parts[3] === "finance" &&
        parts[4] === "ledger" && parts.length === 5 && request.method === "GET") {
        return json(await service.financeLedger(principal, parts[2], {
          limit: Number(url.searchParams.get("limit") ?? "50"),
          cursor: url.searchParams.get("cursor"),
        }));
      }
      if (parts[1] === "properties" && parts[2] && parts[3] === "holds") {
        const propertyId = parts[2];
        if (parts.length === 4 && request.method === "POST") {
          const value = await body(request);
          exact(value, ["expectedInventoryVersion", "stays", "guestName", "contact", "notes",
            "totalCents", "bookedAt"]);
          return json(await service.createHold(principal, propertyId, requestKey(request),
            value as CreateHoldInput), 201);
        }
        if (parts.length === 6 && parts[5] === "convert" && request.method === "POST") {
          const value = await body(request);
          exact(value, ["expectedBookingVersion"]);
          return json(await service.convertHold(principal, propertyId, parts[4], requestKey(request),
            value.expectedBookingVersion as number));
        }
        if (parts.length === 6 && parts[5] === "extend" && request.method === "POST") {
          const value = await body(request);
          exact(value, ["expectedBookingVersion", "newExpiresAt"]);
          return json(await service.extendHold(principal, propertyId, parts[4], requestKey(request),
            value as ExtendHoldInput));
        }
        if (parts.length === 6 && parts[5] === "release" && request.method === "POST") {
          const value = await body(request);
          exact(value, ["expectedBookingVersion", "expectedInventoryVersion"]);
          return json(await service.releaseHold(principal, propertyId, parts[4], requestKey(request),
            value.expectedBookingVersion as number, value.expectedInventoryVersion as number));
        }
      }
      if (parts[1] === "properties" && parts[2] && parts[3] === "availability" && parts.length === 4 &&
        request.method === "GET") {
        return json(await service.availability(principal, parts[2], url.searchParams.get("from") ?? "",
          url.searchParams.get("to") ?? ""));
      }
      if (parts[1] === "properties" && parts[2] && parts[3] === "occupancy-summary" &&
        parts.length === 4 && request.method === "GET") {
        return json(await service.occupancySummary(principal, parts[2],
          url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? ""));
      }
      if (parts[1] === "properties" && parts[2] && parts[3] === "housekeeping-turnovers" &&
        parts.length === 4 && request.method === "GET") {
        return json(await service.housekeepingTurnovers(principal, parts[2],
          url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? ""));
      }
      if (parts[1] === "properties" && parts[2] && parts[3] === "requests" && parts[4] &&
        parts.length === 5 && request.method === "GET") {
        return json(await service.requestResult(principal, parts[2], parts[4]));
      }
      if (parts[1] === "source-events" && parts.length === 2 && request.method === "POST") {
        const value = await body(request);
        exact(value, ["propertyId", "sourceSystem", "sourceAccount", "externalOrderId", "sourceVersion",
          "previousSourceVersion", "kind", "expectedInventoryVersion", "stays", "guestName", "bookedAt"]);
        const result = await service.applySourceEvent(principal, requestKey(request), value as SourceEventInput);
        return json(result, result.state === "review_required" ? 409 : 200);
      }
      if (parts[1] === "inventory-operations" && parts[2] && parts.length === 3 && request.method === "GET") {
        const propertyId = url.searchParams.get("propertyId") ?? "";
        return json(await service.channelOperation(principal, propertyId, parts[2]));
      }
      if (parts[1] === "inventory-operations" && parts[2] && parts[3] === "readback" &&
        parts.length === 4 && request.method === "POST") {
        const value = await body(request);
        exact(value, ["propertyId", "providerVersion", "observedAt", "cells"]);
        const result = await service.recordChannelReadback(principal,
          { ...value, operationKey: parts[2] } as ReadbackInput);
        return json(result, result.state === "review_required" ? 409 : 200);
      }
      return json({ error: { code: "NOT_FOUND" } }, 404);
    } catch (error) {
      if (error instanceof GateError) return json({ error: { code: error.code } }, error.status);
      return json({ error: { code: "INTERNAL_ERROR" } }, 500);
    }
  };
}
