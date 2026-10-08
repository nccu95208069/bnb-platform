import { randomUUID } from "node:crypto";
import { bookingsOverlap, cents, financeSummary, propertyReadiness } from "./domain.ts";
import { holdPhase, occupiesInventory, requireHoldsEnabled } from "./hold-state.ts";
import { mutationContext, saveMutation } from "./mutations.ts";
import { money, receiptTime, textValue, view } from "./service.ts";
import type { CustomerStore } from "./store.ts";
import type { Booking, Payment, Property, Workspace } from "./types.ts";
import { holdNotificationChanges } from "../website-booking/lifecycle.ts";

export const HOLD_ACTIONS = ["hold-extend", "hold-convert", "hold-release", "hold-late-payment", "hold-refund"] as const;

function assertOccupancy(workspace: Workspace, property: Property, booking: Booking) {
  if (!propertyReadiness(workspace, property).complete) throw new Error("IMPORT_INCOMPLETE");
  if (workspace.calendarSources?.some(s => s.propertyId === property.id && s.mode === "connected"))
    throw new Error("CALENDAR_SOURCE_OWNS_OCCUPANCY");
  if (workspace.bookings.some(b => b.id !== booking.id && b.propertyId === property.id && occupiesInventory(b) && bookingsOverlap(b, booking)) ||
      workspace.blocks?.some(b => b.propertyId === property.id && b.status === "active" && bookingsOverlap(b, booking)))
    throw new Error("ROOM_CONFLICT");
}

function extensionTime(value: unknown, now: Date) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value ||
      Date.parse(value) <= now.getTime() || Date.parse(value) > now.getTime() + 366 * 86400000)
    throw new Error("INVALID_HOLD_DEADLINE");
  return value;
}

function receipt(input: Record<string, unknown>, booking: Booking, property: Property, actor: string, refund: boolean): Payment {
  if (input.confirmedReceipt !== true) throw new Error("RECEIPT_CONFIRMATION_REQUIRED");
  const amount = money(input.amount);
  if (amount === null || amount <= 0) throw new Error("INVALID_INPUT");
  const method = textValue(input.method, 100, true)!;
  if (!["cash", "bank", "card", "other"].includes(method)) throw new Error("INVALID_INPUT");
  const account = input.receiptAccountId ? property.receiptAccounts?.find(a => a.id === input.receiptAccountId) : undefined;
  if (input.receiptAccountId && !account) throw new Error("NOT_FOUND");
  if (["bank", "card"].includes(method) && !account) throw new Error("RECEIPT_ACCOUNT_REQUIRED");
  const summary = financeSummary(booking);
  if (summary.received === null || summary.remaining === null) throw new Error("OPENING_BALANCE_REQUIRED");
  if (refund && cents(amount) > cents(summary.received)) throw new Error("REFUND_TOO_LARGE");
  if (!refund && cents(amount) > cents(summary.remaining) && input.allowOverpayment !== true)
    throw new Error("OVERPAYMENT_CONFIRMATION_REQUIRED");
  if (booking.payments.length >= 1000) throw new Error("LIMIT_REACHED");
  const time = String(input.receivedAt);
  if (!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(time)) throw new Error("INVALID_INPUT");
  return {
    id: randomUUID(), amount, kind: refund ? "refund" : "deposit", allocation: "room",
    receivedAt: receiptTime(input.receivedAt), method: ({ cash: "現金", bank: "匯款", card: "信用卡", other: "其他" } as Record<string, string>)[method], actor,
    ...(account ? { receiptAccount: { ...account } } : {}),
    note: textValue(input.note, 500),
  };
}

// Only native workspace data is mutated here. INT-01/02 bind website/LINE actors;
// INT-03 owns legacy Sheet and channel-manager writes. No request can assert that
// an external room was closed or reopened through this platform-only command.
export async function holdOperation(
  store: CustomerStore, accountId: string, slug: string,
  input: Record<string, unknown>, now = new Date(),
) {
  requireHoldsEnabled();
  const action = String(input.action);
  if (!HOLD_ACTIONS.includes(action as typeof HOLD_ACTIONS[number])) throw new Error("INVALID_INPUT");
  const { requestKey: _key, version: _version, ...normalized } = input;
  void _key; void _version;
  const context = await mutationContext(store, accountId, slug, input, action, normalized, ["owner", "admin"]);
  const booking = context.workspace.bookings.find(b => b.id === input.bookingId);
  const property = context.workspace.properties.find(p => p.id === booking?.propertyId &&
    (context.member.allProperties || context.member.propertyIds.includes(p.id)));
  if (!booking?.hold || !property) throw new Error("NOT_FOUND");
  if (booking.hold.scope !== "platform_only" || booking.entry !== "os") throw new Error("HOLD_INTEGRATION_REQUIRED");
  if (context.previous) return {
    workspace: view(context.workspace, context.member), bookingId: booking.id,
    operation: { key: context.key, verified: true, replayed: true },
  };
  if (booking.version !== input.bookingVersion) throw new Error("VERSION_CONFLICT");
  if (input.confirmPlatformOnly !== true) throw new Error("HOLD_SCOPE_CONFIRMATION_REQUIRED");
  const at = now.toISOString();
  let next: Booking = { ...booking, version: booking.version + 1, hold: { ...booking.hold } };
  if (action === "hold-late-payment") {
    if (booking.status !== "cancelled" || booking.hold.state !== "released") throw new Error("HOLD_STATE_CONFLICT");
    next.payments = [...booking.payments, receipt(input, booking, property, accountId, false)];
    next.hold!.latePaymentReview = true;
    // Received money is retained, but this never reclaims someone else's room.
  } else if (action === "hold-refund") {
    if (booking.status === "confirmed") throw new Error("HOLD_STATE_CONFLICT");
    next.payments = [...booking.payments, receipt(input, booking, property, accountId, true)];
    if (financeSummary(next).received === 0) next.hold!.latePaymentReview = false;
  } else {
    if (booking.status !== "held") throw new Error("HOLD_STATE_CONFLICT");
    if (action === "hold-release") {
      if (financeSummary(booking).received !== 0) throw new Error("CANCELLATION_REQUIRES_SETTLEMENT");
      next.status = "cancelled";
      next.hold = { ...booking.hold, state: "released", releasedAt: at };
      // Releasing this order removes only its own native occupancy reason. No
      // other booking/block is changed, and no external stock is set to one.
    } else {
      assertOccupancy(context.workspace, property, booking);
      if (action === "hold-extend") {
        if (input.hours !== undefined && input.expiresAt !== undefined) throw new Error("INVALID_INPUT");
        const expiresAt = input.expiresAt !== undefined ? extensionTime(input.expiresAt, now) :
          [12, 24].includes(Number(input.hours)) && typeof input.hours === "number"
            ? new Date(Math.max(now.getTime(), Date.parse(booking.hold.expiresAt)) + Number(input.hours) * 3600000).toISOString()
            : null;
        if (!expiresAt || Date.parse(expiresAt) <= Date.parse(booking.hold.expiresAt)) throw new Error("INVALID_HOLD_DEADLINE");
        next.hold = { ...booking.hold, state: "active", expiresAt };
      } else {
        next.payments = [...booking.payments, receipt(input, booking, property, accountId, false)];
        next.status = "confirmed";
        next.hold = { ...booking.hold, state: "converted", convertedAt: at };
      }
    }
  }
  const event = action === "hold-extend" ? "hold_extended" : action === "hold-convert" ? "hold_converted" : action === "hold-release" ? "hold_released" : null;
  const notifications = event ? await holdNotificationChanges(store, context.workspace, next, event, now) : { booking: next, changes: [] };
  next = notifications.booking;
  const verified = await saveMutation(store, context, {
    ...context.workspace,
    bookings: context.workspace.bookings.map(b => b.id === next.id ? next : b),
  }, next.id, notifications.changes);
  const saved = verified.workspace.bookings.find(b => b.id === next.id);
  if (!saved || saved.version < next.version ||
      (saved.version === next.version && JSON.stringify(saved) !== JSON.stringify(next))) throw new Error("WRITE_UNCONFIRMED");
  return {
    workspace: view(verified.workspace, verified.member), bookingId: next.id,
    operation: { key: context.key, verified: true, replayed: false },
  };
}

export function pendingHoldTasks(workspace: Pick<Workspace, "bookings">, now = new Date()) {
  return workspace.bookings.filter(b => holdPhase(b, now) === "awaiting_owner" || b.hold?.latePaymentReview)
    .map(b => ({
      id: `hold:${b.id}:${b.version}`, bookingId: b.id, propertyId: b.propertyId,
      bookingVersion: b.version, expiresAt: b.hold!.expiresAt,
      kind: b.hold?.latePaymentReview ? "late_payment_review" as const : "expiry_decision" as const,
    }));
}
