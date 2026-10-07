import { randomUUID } from "node:crypto";
import { occupiesInventory } from "./hold-state.ts";
import { isCalendarKind } from "./calendar-types.ts";
import {
  businessDate,
  cents,
  financeSummary,
  propertyReadiness,
  staysOf,
} from "./domain.ts";
import { mutationContext, saveMutation } from "./mutations.ts";
import {
  dateValue,
  loadWorkspace,
  money,
  receiptTime,
  textValue,
  view,
} from "./service.ts";
import type { CustomerStore } from "./store.ts";
import type {
  AvailabilityList,
  Booking,
  Pricing,
  Property,
  Workspace,
} from "./types.ts";

function scopedProperty(
  workspace: Workspace,
  member: Workspace["members"][number],
  id: unknown,
) {
  const property = workspace.properties.find(
    (p) =>
      p.id === id &&
      (member.allProperties || member.propertyIds.includes(p.id)),
  );
  if (!property) throw new Error("NOT_FOUND");
  return property;
}
function requiredMoney(value: unknown) {
  const amount = money(value);
  if (amount === null) throw new Error("INVALID_INPUT");
  return amount;
}
export async function addProperty(
  store: CustomerStore,
  accountId: string,
  slug: string,
  input: Record<string, unknown>,
) {
  const name = textValue(input.name, 80, true)!,
    kind = input.kind;
  if (
    !["villa", "rooms", "mixed"].includes(String(kind)) ||
    !Array.isArray(input.rooms) ||
    input.rooms.length < 1 ||
    input.rooms.length > 100 ||
    (!["empty", "sheet"].includes(String(input.mode)) &&
      !isCalendarKind(input.mode))
  )
    throw new Error("INVALID_INPUT");
  const rooms = input.rooms.map((r) => textValue(r, 40, true)!);
  if (
    new Set(rooms).size !== rooms.length ||
    (input.mode === "empty" && input.confirmedEmpty !== true)
  )
    throw new Error("INVALID_INPUT");
  const data = { name, kind, rooms, mode: input.mode };
  const context = await mutationContext(
    store,
    accountId,
    slug,
    input,
    "property.created",
    data,
    ["owner"],
  );
  if (context.previous)
    return {
      workspace: view(context.workspace, context.member),
      propertyId: context.previous.targetId,
    };
  if (context.workspace.properties.length >= 30)
    throw new Error("LIMIT_REACHED");
  const property: Property = {
    id: randomUUID(),
    name,
    kind: kind as Property["kind"],
    rooms: rooms.map((name) => ({ id: randomUUID(), name })),
    villaRoomIds: [],
    sourceMode: "native",
    setup: {
      mode: isCalendarKind(input.mode)
        ? "calendar"
        : (input.mode as "empty" | "sheet"),
      ...(isCalendarKind(input.mode)
        ? { calendarKind: input.mode, unresolvedCount: 1 }
        : {}),
      ...(input.mode === "empty"
        ? { readyAt: new Date().toISOString(), unresolvedCount: 0 }
        : {}),
    },
  };
  if (kind !== "rooms") property.villaRoomIds = property.rooms.map((r) => r.id);
  const verified = await saveMutation(
    store,
    context,
    {
      ...context.workspace,
      properties: [...context.workspace.properties, property],
    },
    property.id,
  );
  if (
    !verified.workspace.properties.some(
      (p) => p.id === property.id && p.name === name,
    )
  )
    throw new Error("WRITE_UNCONFIRMED");
  return {
    workspace: view(verified.workspace, verified.member),
    propertyId: property.id,
  };
}

export function validatePricing(property: Property, value: unknown): Pricing {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_INPUT");
  const p = value as Pricing;
  if (
    p.currency !== "TWD" ||
    typeof p.enabled !== "boolean" ||
    !p.base ||
    typeof p.base !== "object" ||
    Array.isArray(p.base) ||
    !Array.isArray(p.overrides) ||
    p.overrides.length > 500
  )
    throw new Error("INVALID_INPUT");
  const allowed = new Set([
    ...property.rooms.map((r) => r.id),
    ...(property.kind !== "rooms" ? ["villa"] : []),
  ]);
  const base: Record<string, number> = {};
  for (const [id, amount] of Object.entries(p.base)) {
    if (!allowed.has(id)) throw new Error("INVALID_INPUT");
    base[id] = requiredMoney(amount);
  }
  const overrides = p.overrides.map((row) => {
    if (!row || !allowed.has(row.roomId)) throw new Error("INVALID_INPUT");
    const from = dateValue(row.from),
      to = dateValue(row.to);
    if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000)
      throw new Error("INVALID_INPUT");
    return { roomId: row.roomId, from, to, amount: requiredMoney(row.amount) };
  });
  if (
    overrides.some((row, i) =>
      overrides
        .slice(i + 1)
        .some(
          (other) =>
            row.roomId === other.roomId &&
            row.from <= other.to &&
            other.from <= row.to,
        ),
    )
  )
    throw new Error("RATE_CONFLICT");
  return { currency: "TWD", enabled: p.enabled, base, overrides };
}
export async function setPricing(
  store: CustomerStore,
  accountId: string,
  slug: string,
  input: Record<string, unknown>,
) {
  const loaded = await loadWorkspace(store, accountId, slug);
  const property = scopedProperty(
    loaded.workspace,
    loaded.member,
    input.propertyId,
  );
  const pricing = validatePricing(property, input.pricing);
  const context = await mutationContext(
    store,
    accountId,
    slug,
    input,
    "pricing.updated",
    { propertyId: property.id, pricing },
    ["owner", "admin"],
  );
  scopedProperty(context.workspace, context.member, property.id);
  if (context.previous) return view(context.workspace, context.member);
  const verified = await saveMutation(
    store,
    context,
    {
      ...context.workspace,
      properties: context.workspace.properties.map((p) =>
        p.id === property.id ? { ...p, pricing } : p,
      ),
    },
    property.id,
  );
  if (
    JSON.stringify(
      verified.workspace.properties.find((p) => p.id === property.id)?.pricing,
    ) !== JSON.stringify(pricing)
  )
    throw new Error("WRITE_UNCONFIRMED");
  return view(verified.workspace, verified.member);
}

export async function saveAvailabilityList(
  store: CustomerStore,
  accountId: string,
  slug: string,
  input: Record<string, unknown>,
) {
  const title = textValue(input.title, 80, true)!,
    from = dateValue(input.from),
    to = dateValue(input.to);
  if (
    from > to ||
    Date.parse(to) - Date.parse(from) > 89 * 86400000 ||
    typeof input.showPrices !== "boolean"
  )
    throw new Error("INVALID_INPUT");
  const normalized = {
    title,
    propertyId: input.propertyId,
    from,
    to,
    showPrices: input.showPrices,
  };
  const context = await mutationContext(
    store,
    accountId,
    slug,
    input,
    "availability-list.created",
    normalized,
    ["owner", "admin"],
  );
  const property = scopedProperty(
    context.workspace,
    context.member,
    input.propertyId,
  );
  if (!propertyReadiness(context.workspace, property).complete)
    throw new Error("IMPORT_INCOMPLETE");
  if (
    (property.setup?.coverageFrom && from < property.setup.coverageFrom) ||
    (property.setup?.coverageTo && to >= property.setup.coverageTo)
  )
    throw new Error("SOURCE_COVERAGE");
  if (input.showPrices && !property.pricing?.enabled)
    throw new Error("PRICING_NOT_ENABLED");
  if (context.previous) return { listId: context.previous.targetId };
  if ((context.workspace.availabilityLists?.length ?? 0) >= 100)
    throw new Error("LIMIT_REACHED");
  const list: AvailabilityList = {
    ...normalized,
    propertyId: property.id,
    id: randomUUID(),
  };
  const verified = await saveMutation(
    store,
    context,
    {
      ...context.workspace,
      availabilityLists: [...(context.workspace.availabilityLists ?? []), list],
    },
    list.id,
  );
  if (!verified.workspace.availabilityLists?.some((l) => l.id === list.id))
    throw new Error("WRITE_UNCONFIRMED");
  return { listId: list.id };
}

export async function availability(
  store: CustomerStore,
  accountId: string,
  slug: string,
  input: Record<string, unknown>,
) {
  const { workspace, member } = await loadWorkspace(store, accountId, slug);
  const saved = input.listId
    ? workspace.availabilityLists?.find((l) => l.id === input.listId)
    : null;
  if (input.listId && !saved) throw new Error("NOT_FOUND");
  const query = saved ?? input,
    property = scopedProperty(workspace, member, query.propertyId);
  const from = dateValue(query.from),
    to = dateValue(query.to);
  if (from > to || Date.parse(to) - Date.parse(from) > 89 * 86400000)
    throw new Error("INVALID_INPUT");
  if (!propertyReadiness(workspace, property).complete)
    throw new Error("IMPORT_INCOMPLETE");
  if (
    (property.setup?.coverageFrom && from < property.setup.coverageFrom) ||
    (property.setup?.coverageTo && to >= property.setup.coverageTo)
  )
    throw new Error("SOURCE_COVERAGE");
  const showPrices =
    member.role !== "viewer_no_price" &&
    query.showPrices === true &&
    property.pricing?.enabled === true;
  const units =
    property.kind === "villa"
      ? [{ id: "villa", name: "包棟", ids: property.villaRoomIds }]
      : [
          ...property.rooms.map((r) => ({
            id: r.id,
            name: r.name,
            ids: [r.id],
          })),
          ...(property.kind === "mixed"
            ? [{ id: "villa", name: "包棟", ids: property.villaRoomIds }]
            : []),
        ];
  const occupied = [
    ...workspace.bookings.filter(
      (b) => b.propertyId === property.id && occupiesInventory(b),
    ),
    ...(workspace.blocks ?? []).filter(
      (b) => b.propertyId === property.id && b.status === "active",
    ),
  ].flatMap(staysOf);
  const rows: {
    date: string;
    roomId: string;
    roomName: string;
    amount?: number | null;
  }[] = [];
  for (let time = Date.parse(from); time <= Date.parse(to); time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10);
    for (const unit of units) {
      if (
        occupied.some(
          (s) =>
            s.checkIn <= date &&
            date < s.checkOut &&
            unit.ids.some((id) => s.roomIds.includes(id)),
        )
      )
        continue;
      const amount =
        property.pricing?.overrides.find(
          (r) => r.roomId === unit.id && r.from <= date && date <= r.to,
        )?.amount ??
        property.pricing?.base[unit.id] ??
        null;
      rows.push({
        date,
        roomId: unit.id,
        roomName: unit.name,
        ...(showPrices ? { amount } : {}),
      });
    }
  }
  return {
    property: { id: property.id, name: property.name },
    title: saved?.title ?? "尚未出售清單",
    from,
    to,
    showPrices,
    currency: "TWD" as const,
    rows,
    lists: (workspace.availabilityLists ?? [])
      .filter(
        (l) =>
          member.allProperties || member.propertyIds.includes(l.propertyId),
      )
      .map((l) => ({
        ...l,
        showPrices: member.role !== "viewer_no_price" && l.showPrices,
      })),
    verifiedAt: new Date().toISOString(),
    version: workspace.version,
  };
}

export async function bookingOperation(
  store: CustomerStore,
  accountId: string,
  slug: string,
  input: Record<string, unknown>,
) {
  const action = String(input.action);
  if (!["payment", "opening", "terms", "cancel"].includes(action))
    throw new Error("INVALID_INPUT");
  const normalized = { ...input };
  delete normalized.requestKey;
  delete normalized.version;
  const roles =
    action === "payment"
      ? (["owner", "admin", "housekeeper"] as const)
      : (["owner", "admin"] as const);
  const context = await mutationContext(
    store,
    accountId,
    slug,
    input,
    `booking.${action}`,
    normalized,
    [...roles],
  );
  const booking = context.workspace.bookings.find(
    (b) => b.id === input.bookingId,
  );
  if (!booking) throw new Error("NOT_FOUND");
  const property = scopedProperty(
    context.workspace,
    context.member,
    booking.propertyId,
  );
  if (context.previous)
    return {
      workspace: view(context.workspace, context.member),
      summary: financeSummary(booking),
    };
  if (booking.status === "held") throw new Error("HOLD_ACTION_REQUIRED");
  if (booking.status !== "confirmed") throw new Error("ORDER_CANCELLED");
  if (booking.version !== input.bookingVersion)
    throw new Error("VERSION_CONFLICT");
  let next: Booking = { ...booking, version: booking.version + 1 };
  if (action === "payment") {
    if (
      !["deposit", "balance", "full", "other", "refund"].includes(
        String(input.kind),
      )
    )
      throw new Error("INVALID_INPUT");
    const amount = requiredMoney(input.amount);
    if (
      amount <= 0 ||
      typeof input.receivedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(input.receivedAt) ||
      !Number.isFinite(Date.parse(input.receivedAt))
    )
      throw new Error("INVALID_INPUT");
    const receivedAt = receiptTime(input.receivedAt);
    if (booking.payments.length >= 1000) throw new Error("LIMIT_REACHED");
    const allocation =
      input.kind === "other" ||
      (input.kind === "refund" && input.allocation === "extra")
        ? "extra"
        : "room";
    const account = input.receiptAccountId
      ? property.receiptAccounts?.find((a) => a.id === input.receiptAccountId)
      : undefined;
    if (input.receiptAccountId && !account) throw new Error("NOT_FOUND");
    const previous = financeSummary(booking);
    if (input.kind === "refund") {
      if (!["owner", "admin"].includes(context.member.role))
        throw new Error("FORBIDDEN");
      if (allocation === "room" && previous.received === null)
        throw new Error("OPENING_BALANCE_REQUIRED");
      if (
        cents(amount) >
        cents(
          allocation === "extra" ? previous.extraReceived : previous.received!,
        )
      )
        throw new Error("REFUND_TOO_LARGE");
    } else if (
      allocation === "room" &&
      previous.remaining !== null &&
      amount > previous.remaining &&
      input.allowOverpayment !== true
    )
      throw new Error("OVERPAYMENT_CONFIRMATION_REQUIRED");
    next.payments = [
      ...booking.payments,
      {
        id: randomUUID(),
        actor: accountId,
        amount,
        kind: input.kind as Booking["payments"][number]["kind"],
        receivedAt,
        method: textValue(input.method, 100),
        allocation,
        ...(account ? { receiptAccount: { ...account } } : {}),
        note: textValue(input.note, 500),
      },
    ];
  } else if (action === "opening") {
    if (
      (booking.entry !== "sheet" && booking.entry !== "calendar") ||
      booking.openingReceived ||
      booking.importedFinance?.propertyReceived != null
    )
      throw new Error("OPENING_ALREADY_CONFIRMED");
    const amount = requiredMoney(input.amount),
      asOf = dateValue(input.asOf);
    // The opening amount describes receipts before import. New receipts remain
    // separate immutable transactions and can never be replaced by this value.
    if (asOf > businessDate(booking.createdAt))
      throw new Error("INVALID_INPUT");
    next.openingReceived = { amount, asOf, note: textValue(input.note, 500) };
  } else if (action === "terms") {
    const total = requiredMoney(input.total),
      expectedDeposit = money(input.expectedDeposit);
    if (expectedDeposit !== null && expectedDeposit > total)
      throw new Error("INVALID_INPUT");
    next = { ...next, total, expectedDeposit };
    const summary = financeSummary(next);
    if (
      summary.credit !== null &&
      summary.credit > 0 &&
      input.allowOverpayment !== true
    )
      throw new Error("OVERPAYMENT_CONFIRMATION_REQUIRED");
  } else {
    if (
      context.workspace.calendarSources?.some(
        (b) => b.propertyId === booking.propertyId && b.mode === "connected",
      )
    )
      throw new Error("CALENDAR_SOURCE_OWNS_OCCUPANCY");
    const summary = financeSummary(booking);
    if (
      summary.received === null ||
      summary.received !== 0 ||
      summary.extraReceived !== 0
    )
      throw new Error("CANCELLATION_REQUIRES_SETTLEMENT");
    next.status = "cancelled";
  }
  const verified = await saveMutation(
    store,
    context,
    {
      ...context.workspace,
      bookings: context.workspace.bookings.map((b) =>
        b.id === booking.id ? next : b,
      ),
    },
    booking.id,
  );
  const result = verified.workspace.bookings.find((b) => b.id === booking.id);
  if (
    !result ||
    result.version < next.version ||
    (action === "payment" &&
      !result.payments.some((p) => p.id === next.payments.at(-1)?.id))
  )
    throw new Error("WRITE_UNCONFIRMED");
  return {
    workspace: view(verified.workspace, verified.member),
    summary: financeSummary(result),
  };
}
