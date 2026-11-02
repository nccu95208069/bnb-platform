import type { RetainedNightPrice, RetainedStay } from "@/lib/booking-sources/retained-booking-contract";

export type RetainedOrderAction = "retain" | "reschedule";
export type RetainedCommand = {
  reason: string;
  expectedBookingVersion: number;
  expectedInventoryVersion: number;
  stays?: RetainedStay[];
  totalCents?: number;
  roomNightPrices?: RetainedNightPrice[];
};
export type PendingRetainedOrder = {
  schema: 1;
  requestKey: string;
  bookingId: string;
  action: RetainedOrderAction;
  createdAt: number;
  payload: RetainedCommand;
};
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = (scope: string) => `offland-retained-request:v1:${encodeURIComponent(scope)}`;
function validPayload(value: unknown, action: unknown): value is RetainedCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as RetainedCommand;
  if (Object.keys(command).some(key => !["reason", "expectedBookingVersion", "expectedInventoryVersion", "stays", "totalCents", "roomNightPrices"].includes(key)) ||
    typeof command.reason !== "string" || !command.reason.trim() || command.reason.length > 500 ||
    !Number.isSafeInteger(command.expectedBookingVersion) || command.expectedBookingVersion < 0 ||
    !Number.isSafeInteger(command.expectedInventoryVersion) || command.expectedInventoryVersion < 0) return false;
  if (action === "retain") return !command.stays && command.totalCents === undefined && !command.roomNightPrices;
  return Array.isArray(command.stays) && command.stays.length > 0 && command.stays.length <= 32 && command.stays.every(stay =>
    typeof stay.checkIn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(stay.checkIn) &&
    typeof stay.checkOut === "string" && /^\d{4}-\d{2}-\d{2}$/.test(stay.checkOut) && stay.checkOut > stay.checkIn &&
    Array.isArray(stay.roomNumbers) && stay.roomNumbers.length === 1 && stay.roomNumbers[0] === "包棟") &&
    Number.isSafeInteger(command.totalCents) && command.totalCents! >= 0 &&
    Array.isArray(command.roomNightPrices) && command.roomNightPrices.length > 0 && command.roomNightPrices.length <= 120 && command.roomNightPrices.every(price =>
      price.roomNumber === "包棟" && typeof price.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(price.date) &&
      Number.isSafeInteger(price.amountCents) && price.amountCents >= 0);
}

export function readPendingRetainedOrder(storage: StorageLike, scope: string): PendingRetainedOrder | null {
  const raw = storage.getItem(key(scope));
  if (!raw) return null;
  const value = JSON.parse(raw) as Partial<PendingRetainedOrder>;
  if (value.schema !== 1 || typeof value.requestKey !== "string" || !uuid.test(value.requestKey) ||
    typeof value.bookingId !== "string" || !uuid.test(value.bookingId) ||
    !["retain", "reschedule"].includes(value.action ?? "") ||
    typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || !validPayload(value.payload, value.action)) {
    throw Error("PENDING_REQUEST_INVALID");
  }
  return value as PendingRetainedOrder;
}

export function savePendingRetainedOrder(storage: StorageLike, scope: string, request: PendingRetainedOrder) {
  if (!validPayload(request.payload, request.action)) throw Error("PENDING_REQUEST_INVALID");
  const previous = readPendingRetainedOrder(storage, scope);
  if (previous && previous.requestKey !== request.requestKey) throw Error("PENDING_REQUEST_EXISTS");
  if (previous && JSON.stringify(previous) !== JSON.stringify(request)) throw Error("PENDING_REQUEST_CHANGED");
  storage.setItem(key(scope), JSON.stringify(request));
  if (readPendingRetainedOrder(storage, scope)?.requestKey !== request.requestKey) throw Error("PENDING_STORAGE_UNAVAILABLE");
}

export function clearPendingRetainedOrder(storage: StorageLike, scope: string, requestKey: string) {
  if (readPendingRetainedOrder(storage, scope)?.requestKey === requestKey) storage.removeItem(key(scope));
}
