import { createHash } from "node:crypto";
import { auditOfflandSnapshot } from "./offland-sheet-audit.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_SYSTEM = "offland-calendar-sheet";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value) => String(value ?? "").trim();
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Q groups proved orders; a blank Q keeps its J room-night as a separate booking. */
export function prepareOfflandGroups(snapshot) {
  const audit = auditOfflandSnapshot(snapshot);
  const rows = new Map(snapshot.rows.map((row) => [row.rowNumber, row]));
  const groups = new Map();
  for (const record of audit.records) {
    const key = record.parentId ? `Q:${record.parentId}` : `J:${record.sourceId}`;
    const group = groups.get(key) ?? { key, rows: [], issues: [] };
    const source = rows.get(record.rowNumber);
    group.rows.push({ rowNumber: record.rowNumber,
      values: structuredClone(source.values),
      entered: structuredClone(source.entered ?? source.values),
      notes: structuredClone(source.notes ?? Array(17).fill(null)),
      sourceId: record.sourceId, parentId: record.parentId,
      room: record.room, checkIn: record.checkIn, checkOut: record.checkOut,
      bookedAt: record.bookedAt, platform: record.platform,
      roomFeeCents: record.roomFeeCents,
      rowHash: hash(source) });
    group.issues.push(...record.issues);
    groups.set(key, group);
  }
  const candidates = [...groups.values()].map((group) => {
    const distinct = (index) => [...new Set(group.rows.map((row) => text(row.values[index])))];
    if (distinct(1).length > 1) group.issues.push("PARENT_GUEST_INCONSISTENT");
    if (distinct(2).length > 1) group.issues.push("PARENT_PLATFORM_INCONSISTENT");
    if (distinct(5).length > 1) group.issues.push("PARENT_BOOKED_DATE_INCONSISTENT");
    const roomFeeCents = group.rows.every((row) => row.roomFeeCents !== null)
      ? group.rows.reduce((sum, row) => sum + BigInt(row.roomFeeCents), 0n) : null;
    return { ...group, sourceIds: group.rows.map((row) => row.sourceId),
      roomFeeCents: roomFeeCents !== null &&
        roomFeeCents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(roomFeeCents) : null,
      issues: [...new Set(group.issues)].sort() };
  });
  const sourceRows = audit.summary.sourceRows;
  const projected = candidates.flatMap((group) => group.rows);
  if (projected.length !== sourceRows ||
    new Set(projected.map((row) => row.rowNumber)).size !== sourceRows ||
    projected.some((row) => hash(rows.get(row.rowNumber)) !== row.rowHash))
    throw Error("OFFLAND_GROUP_COVERAGE_MISMATCH");
  return { sourceHash: audit.sourceHash, candidates,
    summary: { sourceRows, groups: candidates.length,
      flaggedGroups: candidates.filter((group) => group.issues.length).length,
      issues: Object.fromEntries([...new Set(candidates.flatMap((group) => group.issues))]
        .sort().map((issue) => [issue,
          candidates.filter((group) => group.issues.includes(issue)).length])),
      occupiedVillaNights: audit.summary.occupiedVillaNights,
      paymentEventsCreated: 0, canCutover: false } };
}

function validConfig(config) {
  const capturedMs = typeof config?.capturedAt === "string"
    ? Date.parse(config.capturedAt) : NaN;
  return config && UUID.test(config.workspaceId ?? "") &&
    UUID.test(config.propertyId ?? "") && UUID.test(config.roomId ?? "") &&
    new Set([config.workspaceId, config.propertyId, config.roomId]).size === 3 &&
    Number.isSafeInteger(config.inventoryVersion) && config.inventoryVersion >= 1 &&
    config.authorityEpoch === 0 && SHA256.test(config.expectedSourceHash ?? "") &&
    typeof config.sourceId === "string" && config.sourceId.length > 0 &&
    typeof config.sourceCopyId === "string" && config.sourceCopyId.length > 0 &&
    config.sourceCopyId !== config.sourceId &&
    Number.isFinite(capturedMs) &&
    new Date(capturedMs).toISOString() === config.capturedAt &&
    config.capturedAt === config.sourceCopyCreatedAt &&
    config.bookingIds && typeof config.bookingIds === "object" &&
    !Array.isArray(config.bookingIds);
}

/** Make a property-scoped, read-only candidate from a hash-bound private copy. */
export function prepareOfflandShadow(snapshot, config) {
  if (!validConfig(config)) throw Error("INVALID_OFFLAND_SHADOW_CONFIG");
  const prepared = prepareOfflandGroups(snapshot);
  if (prepared.sourceHash !== config.expectedSourceHash)
    throw Error("OFFLAND_SOURCE_HASH_MISMATCH");
  // An inconsistent booked date changes only the display label. Identity and
  // occupied nights remain exact; every other issue needs source review.
  const allowed = new Set(["PARENT_BOOKED_DATE_INCONSISTENT"]);
  const blocked = prepared.candidates.filter((group) =>
    group.issues.some((issue) => !allowed.has(issue)));
  if (blocked.length || prepared.summary.occupiedVillaNights !== prepared.summary.sourceRows)
    throw Error("OFFLAND_SOURCE_REVIEW_REQUIRED");
  const keys = new Set(prepared.candidates.map((group) => group.key));
  if (Object.keys(config.bookingIds).length !== keys.size ||
    Object.entries(config.bookingIds).some(([key, id]) => !keys.has(key) || !UUID.test(id)) ||
    new Set(Object.values(config.bookingIds)).size !== keys.size ||
    Object.values(config.bookingIds).some((id) =>
      [config.workspaceId, config.propertyId, config.roomId].includes(id)))
    throw Error("INCOMPLETE_OFFLAND_BOOKING_ID_MAP");

  const bookings = prepared.candidates.map((group) => {
    const names = [...new Set(group.rows.map((row) => text(row.values[1])))];
    const dates = [...new Set(group.rows.map((row) => row.bookedAt))];
    const notes = [...new Set(group.rows.map((row) => text(row.values[10])))].filter(Boolean);
    const stays = group.rows.map((row) => ({ checkIn: row.checkIn,
      checkOut: row.checkOut, roomIds: [config.roomId] }));
    const roomNightPrices = group.rows.map((row) => ({ roomId: config.roomId,
      date: row.checkIn, amountCents: row.roomFeeCents }));
    return { id: config.bookingIds[group.key], workspaceId: config.workspaceId,
      propertyId: config.propertyId, version: 1, status: "confirmed",
      channelSyncState: "not_required", channelOperationKey: null, stays,
      guestName: names.length === 1 ? names[0] : null, contact: null,
      notes: notes.length === 1 ? notes[0] : null,
      totalCents: group.roomFeeCents, roomNightPrices, currency: "TWD",
      bookedAt: dates.length === 1 ? dates[0] : null,
      createdAt: config.capturedAt, source: "external", sourceKey: null,
      paymentEvents: [], offlandSnapshot: { sourceHash: prepared.sourceHash,
        groupKey: group.key, issues: group.issues, rows: group.rows } };
  });
  const sourceLinks = prepared.candidates.map((group) => ({
    key: JSON.stringify([SOURCE_SYSTEM, config.sourceId, group.key]),
    sourceSystem: SOURCE_SYSTEM, sourceAccount: config.sourceId,
    externalOrderId: group.key, bookingId: config.bookingIds[group.key],
    sourceVersion: `sheet-v1:${hash({ sourceHash: prepared.sourceHash,
      groupKey: group.key, rows: group.rows.map((row) => row.rowHash) })}`,
    lastAppliedBookingVersion: 1, diverged: false, tombstoneNights: [],
  })).sort((a, b) => a.key.localeCompare(b.key));
  const state = { workspaceId: config.workspaceId, propertyId: config.propertyId,
    roomIds: [config.roomId], version: config.inventoryVersion,
    authorityEpoch: 0, readOnly: true,
    offlandImport: { sourceHash: prepared.sourceHash, sourceId: config.sourceId,
      sourceCopyId: config.sourceCopyId, capturedAt: config.capturedAt,
      headers: structuredClone(snapshot.headers), sourceRows: prepared.summary.sourceRows,
      flaggedGroups: prepared.summary.flaggedGroups,
      paymentEventsCreated: 0 },
    channel: { mode: "none", ready: false, websiteSalesEnabled: false,
      grantId: null, websiteBindingId: null },
    sourceGrants: [], bookings, sourceLinks, operations: [], fences: [],
    manualBlocks: [], receipts: [] };
  return { state, sourceHash: prepared.sourceHash,
    summary: { sourceRows: prepared.summary.sourceRows,
      bookingGroups: bookings.length, occupiedVillaNights: prepared.summary.occupiedVillaNights,
      flaggedGroups: prepared.summary.flaggedGroups,
      paymentEventsCreated: 0, readOnly: true, canCutover: false } };
}

export function verifyOfflandShadow(snapshot, config, observedState) {
  const expected = prepareOfflandShadow(snapshot, config);
  return { sourceRows: expected.summary.sourceRows,
    projectedRows: (observedState?.bookings ?? []).reduce((sum, booking) =>
      sum + (booking.offlandSnapshot?.rows?.length ?? 0), 0),
    sourceHash: expected.sourceHash,
    matches: canonical(observedState) === canonical(expected.state),
    canCutover: false };
}
