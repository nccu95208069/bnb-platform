import { randomUUID } from "node:crypto";
import { accountKey, digest } from "./auth.ts";
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
function requestKey(value: unknown) {
  if (typeof value !== "string" || !/^[\w-]{16,80}$/.test(value))
    throw new Error("INVALID_INPUT");
  return value;
}
export async function createWorkspace(
  store: CustomerStore,
  account: Account,
  input: Record<string, unknown>,
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
    JSON.stringify({ name, slug, kind, rooms: roomNames }),
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
  };
  if (kind !== "rooms") property.villaRoomIds = property.rooms.map((r) => r.id);
  const workspace: Workspace = {
    id: randomUUID(),
    slug,
    name,
    version: 1,
    members: [
      {
        accountId: account.id,
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
  const properties = workspace.properties.filter(
    (p) => member.allProperties || member.propertyIds.includes(p.id),
  );
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
          }
        : booking;
    });
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    version: workspace.version,
    role: member.role,
    properties,
    bookings,
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
function money(value: unknown) {
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
  const key = requestKey(input.requestKey),
    checkIn = dateValue(input.checkIn),
    checkOut = dateValue(input.checkOut);
  if (
    checkOut <= checkIn ||
    (Date.parse(checkOut) - Date.parse(checkIn)) / 86400000 > 366
  )
    throw new Error("INVALID_INPUT");
  if (
    !Array.isArray(input.roomIds) ||
    input.roomIds.length < 1 ||
    input.roomIds.length > 100 ||
    input.roomIds.some(
      (id) =>
        typeof id !== "string" || !property.rooms.some((r) => r.id === id),
    )
  )
    throw new Error("INVALID_INPUT");
  const roomIds = [...new Set(input.roomIds as string[])].sort();
  if (
    property.kind === "villa" &&
    property.villaRoomIds.some((id) => !roomIds.includes(id))
  )
    throw new Error("INVALID_INPUT");
  const data = {
    propertyId: property.id,
    checkIn,
    checkOut,
    roomIds,
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
      !["deposit", "balance", "full", "other"].includes(p.kind as string) ||
      typeof p.receivedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(p.receivedAt) ||
      !Number.isFinite(Date.parse(p.receivedAt))
    )
      throw new Error("INVALID_INPUT");
    data.payment = {
      amount,
      kind: p.kind as "deposit" | "balance" | "full" | "other",
      receivedAt: new Date(p.receivedAt).toISOString(),
      method: textValue(p.method, 100),
    };
  }
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
      b.checkIn < checkOut &&
      checkIn < b.checkOut &&
      b.roomIds.some((id) => roomIds.includes(id)),
  );
  if (conflict) throw new Error("ROOM_CONFLICT");
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
