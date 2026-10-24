import { createHash } from "node:crypto";
import { nightsFor } from "./service.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const preservedOnly = ["website", "lineOwner", "channelClose", "platform", "calendar",
  "imported", "importedFinance", "openingReceived", "expectedDeposit", "nightlyPrices"];
const knownBookingFields = new Set(["lineOwner", "channelClose", "website", "platform", "bookedAt",
  "bookedAtSource", "bookedAtTimeZone", "tagIds", "id", "version", "propertyId", "guestName",
  "checkIn", "checkOut", "roomIds", "stays", "nightlyPrices", "total", "expectedDeposit",
  "openingReceived", "payments", "contact", "notes", "status", "hold", "guestNotified",
  "createdAt", "actor", "entry", "calendar", "imported", "importedFinance", "requestKey",
  "requestHash"]);

function cents(value) {
  if (value === null || value === undefined) return null;
  const result = value * 100;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    !Number.isSafeInteger(Math.round(result)) || Math.abs(result - Math.round(result)) > 1e-6)
    throw Error("INVALID_OS_AMOUNT");
  return Math.round(result);
}

function validDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validTimestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function validNullableText(value) {
  return value === null || typeof value === "string";
}

/**
 * Read-only inventory and field-coverage report. This does not write an Iron
 * Gate property state or claim that any OS writer has been redirected.
 */
export function analyzeOsWorkspace(workspace) {
  if (!workspace || !uuid.test(workspace.id ?? "") || !Array.isArray(workspace.properties) ||
    !Array.isArray(workspace.bookings)) throw Error("INVALID_OS_WORKSPACE");
  const sourceHash = createHash("sha256").update(JSON.stringify(workspace)).digest("hex");
  const propertyIds = workspace.properties.map((property) => property?.id);
  if (propertyIds.some((id) => !uuid.test(id ?? "")) ||
    new Set(propertyIds).size !== propertyIds.length) throw Error("INVALID_OS_PROPERTY");
  const allBookingIds = new Set();
  for (const booking of workspace.bookings) {
    if (!uuid.test(booking?.id ?? "") || allBookingIds.has(booking.id))
      throw Error("INVALID_OS_BOOKING_ID");
    if (!propertyIds.includes(booking.propertyId)) throw Error("ORPHAN_OS_BOOKING");
    allBookingIds.add(booking.id);
  }
  const properties = [];
  for (const property of workspace.properties) {
    if (!uuid.test(property?.id ?? "") || !Array.isArray(property.rooms))
      throw Error("INVALID_OS_PROPERTY");
    const roomIds = property.rooms.map((room) => room?.id);
    if (roomIds.some((id) => !uuid.test(id)) || new Set(roomIds).size !== roomIds.length)
      throw Error("INVALID_OS_ROOM");
    const bookingIds = new Set();
    const occupied = new Map();
    const collisions = new Map();
    const unsupported = [];
    let activeRoomNights = 0;
    for (const booking of workspace.bookings.filter((item) => item.propertyId === property.id)) {
      bookingIds.add(booking.id);
      if (!["held", "confirmed", "cancelled"].includes(booking.status))
        throw Error("INVALID_OS_BOOKING_STATUS");
      const stays = booking.stays ?? [{ checkIn: booking.checkIn,
        checkOut: booking.checkOut, roomIds: booking.roomIds }];
      const nights = nightsFor(stays, roomIds);
      const unmapped = preservedOnly.filter((field) => booking[field] !== undefined);
      for (const field of Object.keys(booking)) {
        if (!knownBookingFields.has(field) && !unmapped.includes("unknown_field"))
          unmapped.push("unknown_field");
      }
      if (booking.hold) unmapped.push("hold.history");
      if (booking.hold?.state === "awaiting_owner") unmapped.push("hold.awaiting_owner");
      if (booking.hold?.scope && booking.hold.scope !== "platform_only") unmapped.push("hold.scope");
      if (Array.isArray(booking.payments) && booking.payments.length)
        unmapped.push("payments.detail");
      if (booking.entry !== undefined && booking.entry !== "os") unmapped.push("entry.external");
      if (booking.guestNotified === true) unmapped.push("guestNotified");
      if (Array.isArray(booking.tagIds) && booking.tagIds.length) unmapped.push("tagIds");
      cents(booking.total);
      for (const payment of booking.payments ?? []) cents(payment.amount);
      if (unmapped.length) unsupported.push({ bookingId: booking.id, fields: unmapped });
      if (booking.status === "cancelled") continue;
      activeRoomNights += nights.length;
      for (const night of nights) {
        const key = `${night.roomId}:${night.date}`;
        const previous = occupied.get(key);
        if (previous) collisions.set(key, [...new Set([...(collisions.get(key) ?? [previous]), booking.id])]);
        else occupied.set(key, booking.id);
      }
    }
    properties.push({ propertyId: property.id, bookingCount: bookingIds.size,
      activeRoomNights, uniqueOccupiedRoomNights: occupied.size,
      activeBlockCount: workspace.blocks?.filter((block) =>
        block.propertyId === property.id && block.status === "active").length ?? 0,
      integrationFenceCount: workspace.integrationFences?.filter((fence) =>
        fence.propertyId === property.id).length ?? 0,
      collisions: [...collisions].map(([cell, ids]) => {
        const [roomId, date] = cell.split(":");
        return { roomId, date, bookingIds: ids };
      }), unsupported,
      externalSourceConnected: Boolean(workspace.calendarSources?.some((source) =>
        source.propertyId === property.id && source.mode === "connected") ||
        workspace.sourceConnections?.some((source) => source.propertyId === property.id &&
          source.status !== "revoked")),
    });
  }
  return { workspaceId: workspace.id, sourceHash, properties,
    canCutover: false, reason: "WRITER_FENCE_AND_FIELD_PARITY_NOT_VERIFIED" };
}

/**
 * Produce a private, read-only per-property candidate for a very narrow native
 * OS subset. This only transforms a supplied snapshot; it never reads OS or
 * seeds a repository. A caller must separately prove a frozen backup, writer
 * drain, account verification, channel sync, and rollback before activation.
 */
export function prepareOsPropertyCandidate(workspace, propertyId, options) {
  const report = analyzeOsWorkspace(workspace);
  const property = workspace.properties.find((item) => item.id === propertyId);
  const summary = report.properties.find((item) => item.propertyId === propertyId);
  if (!property || !summary) throw Error("OS_PROPERTY_NOT_FOUND");
  if (!options || !Number.isSafeInteger(options.authorityEpoch) || options.authorityEpoch < 0 ||
    !Number.isSafeInteger(options.inventoryVersion) || options.inventoryVersion < 1 ||
    !Number.isSafeInteger(workspace.version) || workspace.version < 1)
    throw Error("INVALID_OS_VERSION");
  if (summary.collisions.length || summary.unsupported.length || summary.activeBlockCount ||
    summary.integrationFenceCount || summary.externalSourceConnected ||
    property.setup?.mode && property.setup.mode !== "empty" ||
    property.setup?.unresolvedCount ||
    workspace.reviewRecords?.some((item) => item.propertyId === propertyId))
    throw Error("OS_FIELD_PARITY_REQUIRED");
  const roomIds = property.rooms.map((room) => room.id);
  const bookings = workspace.bookings.filter((item) => item.propertyId === propertyId).map((booking) => {
    if (!["confirmed", "cancelled"].includes(booking.status) || booking.entry !== "os" ||
      !Number.isSafeInteger(booking.version) || booking.version < 1 ||
      !validTimestamp(booking.createdAt) ||
      booking.bookedAt != null && !validDay(booking.bookedAt) ||
      !validNullableText(booking.guestName) || !validNullableText(booking.contact) ||
      !validNullableText(booking.notes) || !Array.isArray(booking.roomIds) ||
      !Array.isArray(booking.payments) || booking.payments.length ||
      typeof booking.actor !== "string" || !booking.actor ||
      typeof booking.requestKey !== "string" || !booking.requestKey ||
      typeof booking.requestHash !== "string" || !booking.requestHash ||
      booking.hold || booking.guestNotified !== false)
      throw Error("OS_FIELD_PARITY_REQUIRED");
    const stays = structuredClone(booking.stays ?? [{ checkIn: booking.checkIn,
      checkOut: booking.checkOut, roomIds: booking.roomIds }]);
    const occupied = nightsFor(stays, roomIds);
    const checkIns = stays.map((stay) => stay.checkIn).sort();
    const checkOuts = stays.map((stay) => stay.checkOut).sort();
    const unionRooms = [...new Set(stays.flatMap((stay) => stay.roomIds))].sort();
    if (booking.checkIn !== checkIns[0] || booking.checkOut !== checkOuts.at(-1) ||
      JSON.stringify([...booking.roomIds].sort()) !== JSON.stringify(unionRooms) ||
      occupied.length < 1) throw Error("OS_STAY_MISMATCH");
    return {
      id: booking.id, workspaceId: workspace.id, propertyId, version: booking.version,
      status: booking.status, channelSyncState: "not_required", channelOperationKey: null,
      stays, guestName: booking.guestName, contact: booking.contact, notes: booking.notes,
      totalCents: cents(booking.total), currency: "TWD", bookedAt: booking.bookedAt ?? null,
      createdAt: booking.createdAt, source: "os", sourceKey: null, paymentEvents: [],
      osSnapshot: structuredClone(booking),
    };
  });
  const state = {
    workspaceId: workspace.id, propertyId, roomIds, version: options.inventoryVersion,
    authorityEpoch: options.authorityEpoch, readOnly: true,
    osImport: { sourceHash: report.sourceHash, workspaceVersion: workspace.version,
      propertySnapshot: structuredClone(property) },
    channel: { mode: "none", ready: false, websiteSalesEnabled: false,
      grantId: null, websiteBindingId: null },
    sourceGrants: [], bookings, sourceLinks: [], operations: [], fences: [],
    manualBlocks: [], receipts: [],
  };
  return { state, summary: structuredClone(summary), sourceHash: report.sourceHash };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Compare a frozen OS snapshot with a prepared read-only Iron Gate state. No PII is returned. */
export function compareOsPropertyCandidate(workspace, propertyId, persistedState, options) {
  const { state: expected, summary, sourceHash } =
    prepareOsPropertyCandidate(workspace, propertyId, options);
  const observed = persistedState;
  if (!observed || observed.propertyId !== propertyId ||
    observed.workspaceId !== workspace.id) throw Error("SHADOW_PROPERTY_MISMATCH");
  const expectedBookings = new Map(expected.bookings.map((booking) => [booking.id, booking]));
  const observedBookings = new Map((observed.bookings ?? []).map((booking) => [booking.id, booking]));
  if (observedBookings.size !== (observed.bookings ?? []).length)
    throw Error("DUPLICATE_SHADOW_BOOKING_ID");
  const missingBookingIds = [...expectedBookings.keys()].filter((id) => !observedBookings.has(id)).sort();
  const extraBookingIds = [...observedBookings.keys()].filter((id) => !expectedBookings.has(id)).sort();
  const changedBookingIds = [...expectedBookings.keys()].filter((id) => observedBookings.has(id) &&
    canonical(expectedBookings.get(id)) !== canonical(observedBookings.get(id))).sort();
  const stateSafe = observed.readOnly === true &&
    canonical({ ...observed, bookings: [] }) === canonical({ ...expected, bookings: [] });
  return { propertyId, sourceHash, matches: stateSafe && !missingBookingIds.length &&
    !extraBookingIds.length && !changedBookingIds.length,
    readOnly: observed.readOnly === true, sourceChanged: observed.osImport?.sourceHash !== sourceHash,
    expectedBookingCount: summary.bookingCount, observedBookingCount: observedBookings.size,
    missingBookingIds, extraBookingIds, changedBookingIds, canCutover: false };
}
