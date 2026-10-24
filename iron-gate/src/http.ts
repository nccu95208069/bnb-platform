import { GateError, IronGateService } from "./service.ts";
import type { AmendBookingInput, CreateBookingInput, CreateHoldInput, ExtendHoldInput, LineInventoryInput, LineInventoryBatchInput, LineBulkCancelInput, LineChannelActionInput, PaymentEventInput,
  Principal, ReadbackInput, SourceEventInput, SourceFactsInput, SourceOrderLookupInput } from "./types.ts";

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

      if (parts[1] === "properties" && parts[2] && parts[3] === "line-create-previews" &&
        parts.length === 4 && request.method === "POST") {
        const value = await body(request);
        exact(value, ["expectedInventoryVersion", "stays", "guestName", "contact", "notes", "totalCents", "bookedAt", "source"],
          ["roomNightPrices", "channelPolicy"]);
        return json(await service.previewLineCreate(principal, parts[2], value as CreateBookingInput));
      }
      if (parts[1] === "properties" && parts[2] && parts.length === 4 &&
        parts[3] === "line-bulk-cancel-previews" && request.method === "POST") {
        const value = await body(request);
        exact(value, ["expectedInventoryVersion", "bookings"], ["channelPolicy"]);
        return json(await service.previewLineBulkCancel(principal, parts[2],
          value as LineBulkCancelInput));
      }
      if (parts[1] === "properties" && parts[2] && parts.length === 4 &&
        parts[3] === "line-bulk-cancels" && request.method === "POST") {
        const value = await body(request);
        exact(value, ["expectedInventoryVersion", "bookings"], ["channelPolicy"]);
        return json(await service.bulkCancelLineBookings(principal, parts[2],
          requestKey(request), value as LineBulkCancelInput,
          request.headers.get("x-iron-gate-line-preview")), 202);
      }
      if (parts[1] === "properties" && parts[2] && parts.length === 4 &&
        parts[3] === "inventory-batch-previews" && request.method === "POST") {
        const value = await body(request);
        exact(value, ["expectedInventoryVersion", "cells", "desired"]);
        return json(await service.previewLineInventoryBatch(principal, parts[2],
          value as LineInventoryBatchInput));
      }
      if (parts[1] === "properties" && parts[2] && parts.length === 4 &&
        parts[3] === "inventory-batches" && request.method === "POST") {
        const value = await body(request);
        exact(value, ["expectedInventoryVersion", "cells", "desired"]);
        return json(await service.setLineInventoryBatch(principal, parts[2],
          requestKey(request), value as LineInventoryBatchInput,
          request.headers.get("x-iron-gate-line-preview")), 202);
      }
      if (parts[1] === "properties" && parts[2] && parts.length === 4 &&
        parts[3] === "inventory-previews" && request.method === "POST") {
        const value = await body(request);
        exact(value, ["expectedInventoryVersion", "roomId", "date", "desired"]);
        return json(await service.previewLineInventory(principal, parts[2],
          value as LineInventoryInput));
      }
      if (parts[1] === "properties" && parts[2] && parts.length === 4 &&
        parts[3] === "inventory" && request.method === "POST") {
        const value = await body(request);
        exact(value, ["expectedInventoryVersion", "roomId", "date", "desired"]);
        return json(await service.setLineInventory(principal, parts[2], requestKey(request),
          value as LineInventoryInput, request.headers.get("x-iron-gate-line-preview")), 202);
      }
      if (parts[1] === "properties" && parts[2] && parts.length === 4 &&
        parts[3] === "line-capabilities" && request.method === "GET") {
        return json(await service.lineCapabilities(principal, parts[2]));
      }
      if (parts[1] === "properties" && parts[2] && parts[3] === "line-channel-actions") {
        if (parts.length === 6 && parts[4] === "requests" && request.method === "GET") {
          const result = await service.requestResult(principal, parts[2], parts[5]);
          if (!result.bookingId || !result.operationKey || !Array.isArray(result.cells))
            throw new GateError("REQUEST_NOT_FOUND", 404);
          return json(result);
        }
        if (parts.length === 5 && request.method === "GET")
          return json(await service.lineChannelAction(principal, parts[2], parts[4]));
      }
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
          exact(value, ["expectedInventoryVersion", "stays", "guestName", "contact", "notes", "totalCents", "bookedAt", "source"],
            ["roomNightPrices", "channelPolicy"]);
          const result = await service.createBooking(principal, propertyId, requestKey(request),
            value as CreateBookingInput, request.headers.get("x-iron-gate-line-preview"));
          return json(result, result.operationState === "sync_pending" ? 202 : 201);
        }
        if (parts.length === 5 && request.method === "GET") {
          return json(await service.getBooking(principal, propertyId, parts[4]));
        }
        if (parts.length === 5 && request.method === "PATCH") {
          const value = await body(request);
          exact(value, ["expectedBookingVersion", "expectedInventoryVersion", "changes"],
            ["channelPolicy"]);
          const result = await service.amendBooking(principal, propertyId, parts[4], requestKey(request),
            value as AmendBookingInput, request.headers.get("x-iron-gate-line-preview"));
          return json(result, result.operationState === "sync_pending" ? 202 : 200);
        }
        if (parts.length === 6 && parts[5] === "line-action-previews" && request.method === "POST") {
          const value = await body(request);
          exact(value, ["action", "input"]);
          if (value.action !== "amend" && value.action !== "cancel")
            throw new GateError("INVALID_INPUT", 400);
          const input = value.input;
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw new GateError("INVALID_INPUT", 400);
          exact(input as Record<string, unknown>, ["expectedBookingVersion", "expectedInventoryVersion"],
            value.action === "amend" ? ["changes", "channelPolicy"] : ["channelPolicy"]);
          if (value.action === "amend" && !("changes" in input))
            throw new GateError("INVALID_INPUT", 400);
          return json(await service.previewLineAction(principal, propertyId, parts[4],
            value.action, input as AmendBookingInput));
        }
        if (parts.length === 6 && parts[5] === "line-channel-action-previews" && request.method === "POST") {
          const value = await body(request);
          exact(value, ["expectedBookingVersion", "expectedInventoryVersion", "desired", "cells"]);
          return json(await service.previewLineChannelAction(principal, propertyId, parts[4],
            value as LineChannelActionInput));
        }
        if (parts.length === 6 && parts[5] === "line-channel-actions" && request.method === "POST") {
          const value = await body(request);
          exact(value, ["expectedBookingVersion", "expectedInventoryVersion", "desired", "cells"]);
          return json(await service.requestLineChannelAction(principal, propertyId, parts[4],
            requestKey(request), value as LineChannelActionInput,
            request.headers.get("x-iron-gate-line-preview")), 202);
        }
        if (parts.length === 6 && parts[5] === "cancel" && request.method === "POST") {
          const value = await body(request);
          exact(value, ["expectedBookingVersion", "expectedInventoryVersion"], ["channelPolicy"]);
          const result = await service.cancelBooking(principal, propertyId, parts[4], requestKey(request),
            value.expectedBookingVersion as number, value.expectedInventoryVersion as number,
            request.headers.get("x-iron-gate-line-preview"),
            value.channelPolicy as "manual" | undefined);
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
      if (parts[1] === "properties" && parts[2] && parts[3] === "calendar-snapshot" &&
        parts.length === 4 && request.method === "GET") {
        return json(await service.calendarSnapshot(principal, parts[2],
          url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? ""));
      }
      if (parts[1] === "properties" && parts[2] && parts[3] === "business-report" &&
        parts.length === 4 && request.method === "GET") {
        return json(await service.businessReport(principal, parts[2]));
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
          "previousSourceVersion", "kind", "expectedInventoryVersion", "stays", "guestName", "bookedAt"],
          ["totalCents", "currency", "platform", "externalOrderNo"]);
        const result = await service.applySourceEvent(principal, requestKey(request), value as SourceEventInput);
        return json(result, result.state === "review_required" ? 409 : 200);
      }
      if (parts[1] === "source-orders" && parts[2] === "facts" &&
        parts.length === 3 && request.method === "POST") {
        const value = await body(request);
        exact(value, ["propertyId", "sourceSystem", "sourceAccount", "externalOrderId",
          "sourceVersion", "expectedInventoryVersion", "expectedBookingVersion",
          "totalCents", "currency", "platform", "externalOrderNo"]);
        return json(await service.enrichSourceFacts(principal, requestKey(request),
          value as SourceFactsInput));
      }
      if (parts[1] === "source-orders" && parts[2] === "lookup" &&
        parts.length === 3 && request.method === "POST") {
        const value = await body(request);
        exact(value, ["propertyId", "sourceSystem", "sourceAccount", "externalOrderId"]);
        return json(await service.sourceOrderLookup(principal, value as SourceOrderLookupInput));
      }
      if (parts[1] === "inventory-operations" && parts.length === 2 && request.method === "GET") {
        return json(await service.pendingChannelOperations(principal,
          url.searchParams.get("propertyId") ?? "", Number(url.searchParams.get("limit") ?? "50")));
      }
      if (parts[1] === "inventory-operations" && parts[2] && parts.length === 3 && request.method === "GET") {
        const propertyId = url.searchParams.get("propertyId") ?? "";
        return json(await service.channelOperation(principal, propertyId, parts[2]));
      }
      if (parts[1] === "inventory-operations" && parts[2] && parts[3] === "readback" &&
        parts.length === 4 && request.method === "POST") {
        const value = await body(request);
        exact(value, ["propertyId", "providerVersion", "observedAt", "cells"],
          ["appliedClosedCells"]);
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
