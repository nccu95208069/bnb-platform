import { randomUUID } from "node:crypto";
import { accountKey, digest } from "./auth.ts";
import { bookingsOverlap, propertyReadiness, staysOverlap } from "./domain.ts";
import type { CustomerStore } from "./store.ts";
import type {
  Account,
  Booking,
  Membership,
  Property,
  Workspace,
  WorkspaceView,
} from "./types.ts";
export function textValue(
  value: unknown,
  max: number,
  required = false,
): string | null {
  if (value == null || value === "") {
    if (required) throw new Error("INVALID_INPUT");
    return null;
  }
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (required && !value.trim())
  )
    throw new Error("INVALID_INPUT");
  return value.trim() || null;
}
export function validSlug(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9-]{2,47}$/.test(value) ||
    ["sweetfun", "offland", "admin", "api"].includes(value)
  )
    throw new Error("INVALID_INPUT");
  return value;
}
export function requestKey(value: unknown) {
  if (typeof value !== "string" || !/^[\w-]{16,80}$/.test(value))
    throw new Error("INVALID_INPUT");
  return value;
}
export async function createWorkspace(
  store: CustomerStore,
  account: Account,
  input: Record<string, unknown>,
  onboarding?: Workspace["onboarding"],
) {
  const key = accountKey(account.email),
    current = await store.read<Account>(key);
  if (!current.value || current.value.id !== account.id)
    throw new Error("UNAUTHORIZED");
  const creationKey = requestKey(input.requestKey);
  const name = textValue(input.name, 80, true)!,
    slug = validSlug(input.slug);
  const kind = input.kind;
  if (
    !["villa", "rooms", "mixed"].includes(kind as string) ||
    !Array.isArray(input.rooms) ||
    input.rooms.length < 1 ||
    input.rooms.length > 100
  )
    throw new Error("INVALID_INPUT");
  const roomNames = input.rooms.map((r) => textValue(r, 40, true)!);
  if (new Set(roomNames).size !== roomNames.length)
    throw new Error("INVALID_INPUT");
  const creationHash = digest(
    JSON.stringify({
      name,
      slug,
      kind,
      rooms: roomNames,
      ...(onboarding ? { onboarding } : {}),
    }),
  );
  const repeated = current.value.workspaces.find(
    (w) => w.creationKey === creationKey,
  );
  if (repeated) {
    if (repeated.creationHash !== creationHash)
      throw new Error("IDEMPOTENCY_CONFLICT");
    return repeated;
  }
  if (current.value.workspaces.length >= 10) throw new Error("LIMIT_REACHED");
  const property: Property = {
    id: randomUUID(),
    name,
    kind: kind as Property["kind"],
    rooms: roomNames.map((name) => ({ id: randomUUID(), name })),
    villaRoomIds: [],
    sourceMode: "native",
    ...(onboarding?.calendarKind
      ? {
          setup: {
            mode: "calendar" as const,
            calendarKind: onboarding.calendarKind,
            unresolvedCount: 1,
          },
        }
      : {}),
  };
  if (kind !== "rooms") property.villaRoomIds = property.rooms.map((r) => r.id);
  const workspace: Workspace = {
    id: randomUUID(),
    slug,
    name,
    version: 1,
    ...(onboarding ? { onboarding } : {}),
    members: [
      {
        accountId: account.id,
        email: account.email,
        role: "owner",
        active: true,
        allProperties: true,
        propertyIds: [],
      },
    ],
    properties: [property],
    bookings: [],
    audit: [],
  };
  workspace.audit.push({
    at: new Date().toISOString(),
    actor: account.id,
    action: "workspace.created",
    targetId: workspace.id,
  });
  const existing = await store.read<string>(`slug:${slug}`);
  if (existing.value) throw new Error("SLUG_EXISTS");
  const reference = { id: workspace.id, slug, name, creationKey, creationHash };
  await store.commit([
    {
      key,
      before: current.raw,
      after: {
        ...current.value,
        workspaces: [...current.value.workspaces, reference],
      },
    },
    { key: `slug:${slug}`, before: null, after: workspace.id },
    { key: `workspace:${workspace.id}`, before: null, after: workspace },
  ]);
  const verified = await store.read<Workspace>(`workspace:${workspace.id}`);
  if (verified.value?.id !== workspace.id) throw new Error("WRITE_UNCONFIRMED");
  return reference;
}
export function memberFor(workspace: Workspace, accountId: string): Membership {
  const member = workspace.members.find(
    (m) => m.accountId === accountId && m.active,
  );
  if (!member) throw new Error("NOT_FOUND");
  return member;
}
export async function loadWorkspace(
  store: CustomerStore,
  accountId: string,
  slug: string,
) {
  validSlug(slug);
  const id = (await store.read<string>(`slug:${slug}`)).value;
  if (!id) throw new Error("NOT_FOUND");
  const snapshot = await store.read<Workspace>(`workspace:${id}`);
  if (
    !snapshot.value ||
    snapshot.value.id !== id ||
    snapshot.value.slug !== slug
  )
    throw new Error("NOT_FOUND");
  return {
    raw: snapshot.raw,
    workspace: snapshot.value,
    member: memberFor(snapshot.value, accountId),
  };
}
export function view(workspace: Workspace, member: Membership): WorkspaceView {
  const allowedProperties = workspace.properties.filter(
    (p) => member.allProperties || member.propertyIds.includes(p.id),
  );
  const properties = allowedProperties.map((p) => {
    const { setup: _setup, pricing, ...property } = p;
    void _setup;
    return member.role === "viewer_no_price"
      ? property
      : { ...property, pricing };
  });
  const bookings = workspace.bookings
    .filter((b) => properties.some((p) => p.id === b.propertyId))
    .map((b) => {
      const {
        requestKey: _key,
        requestHash: _hash,
        actor: _actor,
        ...booking
      } = b;
      void _key;
      void _hash;
      void _actor;
      return member.role === "viewer_no_price"
        ? {
            ...booking,
            total: null,
            payments: [],
            notes: null,
            contact: null,
            importedFinance: undefined,
            imported: undefined,
            calendar: undefined,
            expectedDeposit: undefined,
            openingReceived: undefined,
            nightlyPrices: undefined,
          }
        : booking;
    });
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    version: workspace.version,
    role: member.role,
    ...(workspace.onboarding
      ? {
          onboarding: {
            complete:
              Boolean(workspace.onboarding.readyAt) &&
              workspace.onboarding.unresolvedCount === 0,
            unresolvedCount: workspace.onboarding.unresolvedCount ?? 0,
          },
        }
      : {}),
    properties,
    bookings,
    blocks: (workspace.blocks ?? [])
      .filter((b) => properties.some((p) => p.id === b.propertyId))
      .map(({ calendar: _calendar, ...block }) => {
        void _calendar;
        return {
          ...block,
          reason: member.role === "viewer_no_price" ? "封房" : block.reason,
        };
      }),
    readiness: Object.fromEntries(
      allowedProperties.map((p) => [p.id, propertyReadiness(workspace, p)]),
    ),
  };
}
export function dateValue(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "2000-01-01" ||
    value > "2100-12-31"
  )
    throw new Error("INVALID_INPUT");
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new Error("INVALID_INPUT");
  return value;
}
export function money(value: unknown) {
  if (value === "" || value == null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100000000 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 0.000001
  )
    throw new Error("INVALID_INPUT");
  return value;
}
export function receiptTime(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    throw new Error("INVALID_INPUT");
  dateValue(value.slice(0, 10));
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("INVALID_INPUT");
  if (time > Date.now() + 5 * 60000) throw new Error("FUTURE_RECEIPT");
  return new Date(time).toISOString();
}
export function normalizeStays(
  property: Property,
  input: Record<string, unknown>,
) {
  const values = input.stays === undefined ? [input] : input.stays;
  if (!Array.isArray(values) || values.length < 1 || values.length > 50)
    throw new Error("INVALID_INPUT");
  const stays = values
    .map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("INVALID_INPUT");
      const stay = value as Record<string, unknown>;
      const checkIn = dateValue(stay.checkIn),
        checkOut = dateValue(stay.checkOut);
      if (
        checkOut <= checkIn ||
        (Date.parse(checkOut) - Date.parse(checkIn)) / 86400000 > 366
      )
        throw new Error("INVALID_INPUT");
      if (
        !Array.isArray(stay.roomIds) ||
        stay.roomIds.length < 1 ||
        stay.roomIds.length > 100 ||
        stay.roomIds.some(
          (id) =>
            typeof id !== "string" || !property.rooms.some((r) => r.id === id),
        )
      )
        throw new Error("INVALID_INPUT");
      const roomIds = [...new Set(stay.roomIds as string[])].sort();
      if (
        property.kind === "villa" &&
        property.villaRoomIds.some((id) => !roomIds.includes(id))
      )
        throw new Error("INVALID_INPUT");
      return { checkIn, checkOut, roomIds };
    })
    .sort(
      (a, b) =>
        a.checkIn.localeCompare(b.checkIn) ||
        a.checkOut.localeCompare(b.checkOut) ||
        a.roomIds.join().localeCompare(b.roomIds.join()),
    );
  if (
    stays.some((stay, i) =>
      stays.slice(i + 1).some((other) => staysOverlap(stay, other)),
    )
  )
    throw new Error("ROOM_CONFLICT");
  return stays;
}
export async function createBooking(
  store: CustomerStore,
  accountId: string,
  slug: string,
  input: Record<string, unknown>,
) {
  const { raw, workspace, member } = await loadWorkspace(
    store,
    accountId,
    slug,
  );
  if (!["owner", "admin", "housekeeper"].includes(member.role))
    throw new Error("FORBIDDEN");
  const property = workspace.properties.find(
    (p) =>
      p.id === input.propertyId &&
      (member.allProperties || member.propertyIds.includes(p.id)),
  );
  if (!property) throw new Error("NOT_FOUND");
  if (!propertyReadiness(workspace, property).complete)
    throw new Error("IMPORT_INCOMPLETE");
  if (
    workspace.calendarSources?.some(
      (b) => b.propertyId === property.id && b.mode === "connected",
    )
  )
    throw new Error("CALENDAR_SOURCE_OWNS_OCCUPANCY");
  const key = requestKey(input.requestKey),
    stays = normalizeStays(property, input);
  if (
    stays.some(
      (s) =>
        (property.setup?.coverageFrom &&
          s.checkIn < property.setup.coverageFrom) ||
        (property.setup?.coverageTo && s.checkOut > property.setup.coverageTo),
    )
  )
    throw new Error("SOURCE_COVERAGE");
  const checkIn = stays.reduce(
    (d, s) => (d < s.checkIn ? d : s.checkIn),
    stays[0].checkIn,
  );
  const checkOut = stays.reduce(
    (d, s) => (d > s.checkOut ? d : s.checkOut),
    stays[0].checkOut,
  );
  const roomIds = [...new Set(stays.flatMap((s) => s.roomIds))].sort();
  const data = {
    propertyId: property.id,
    checkIn,
    checkOut,
    roomIds,
    ...(input.stays !== undefined ? { stays } : {}),
    expectedDeposit:
      input.expectedDeposit === undefined
        ? undefined
        : money(input.expectedDeposit),
    total: money(input.total),
    guestName: textValue(input.guestName, 100),
    notes: textValue(input.notes, 2000),
    contact: textValue(input.contact, 200),
    payment: null as null | Omit<Booking["payments"][number], "id" | "actor">,
  };
  if (input.payment != null) {
    const p = input.payment as Record<string, unknown>,
      amount = money(p.amount);
    if (
      amount === null ||
      amount <= 0 ||
      !["deposit", "balance", "full", "other"].includes(p.kind as string) ||
      typeof p.receivedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(p.receivedAt) ||
      !Number.isFinite(Date.parse(p.receivedAt))
    )
      throw new Error("INVALID_INPUT");
    data.payment = {
      amount,
      kind: p.kind as "deposit" | "balance" | "full" | "other",
      receivedAt: receiptTime(p.receivedAt),
      method: textValue(p.method, 100),
    };
  }
  if (
    data.expectedDeposit != null &&
    data.total != null &&
    data.expectedDeposit > data.total
  )
    throw new Error("INVALID_INPUT");
  if (
    data.payment &&
    data.total !== null &&
    data.payment.amount > data.total &&
    input.allowOverpayment !== true
  )
    throw new Error("OVERPAYMENT_CONFIRMATION_REQUIRED");
  const hash = digest(JSON.stringify(data));
  const repeated = workspace.bookings.find(
    (b) => b.requestKey === key && b.actor === accountId,
  );
  if (repeated) {
    if (repeated.requestHash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
    return { booking: repeated, workspace: view(workspace, member) };
  }
  if (workspace.version !== input.version) throw new Error("VERSION_CONFLICT");
  if (workspace.bookings.length >= 5000) throw new Error("LIMIT_REACHED");
  const conflict = workspace.bookings.some(
    (b) =>
      b.propertyId === property.id &&
      b.status !== "cancelled" &&
      bookingsOverlap(b, { checkIn, checkOut, roomIds, stays }),
  );
  if (
    conflict ||
    workspace.blocks?.some(
      (b) =>
        b.propertyId === property.id &&
        b.status === "active" &&
        bookingsOverlap(b, { checkIn, checkOut, roomIds, stays }),
    )
  )
    throw new Error("ROOM_CONFLICT");
  const { payment, ...fields } = data;
  const booking: Booking = {
    ...fields,
    id: randomUUID(),
    version: 1,
    payments: payment
      ? [{ ...payment, id: randomUUID(), actor: accountId }]
      : [],
    status: "confirmed",
    guestNotified: false,
    createdAt: new Date().toISOString(),
    actor: accountId,
    entry: "os",
    requestKey: key,
    requestHash: hash,
  };
  const next: Workspace = {
    ...workspace,
    version: workspace.version + 1,
    bookings: [...workspace.bookings, booking],
    audit: [
      ...workspace.audit,
      {
        at: booking.createdAt,
        actor: accountId,
        action: "booking.created",
        targetId: booking.id,
      },
    ],
  };
  await store.commit([
    { key: `workspace:${workspace.id}`, before: raw, after: next },
  ]);
  const verified = await loadWorkspace(store, accountId, slug);
  const saved = verified.workspace.bookings.find((b) => b.id === booking.id);
  if (
    !saved ||
    saved.requestHash !== hash ||
    saved.payments.length !== booking.payments.length
  )
    throw new Error("WRITE_UNCONFIRMED");
  return {
    booking: saved,
    workspace: view(verified.workspace, verified.member),
  };
}
