import { createHash } from "node:crypto";
import { prepareSweetfunGroups, verifySweetfunGroups } from "./sweetfun-sheet-candidate.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roomNames = ["101", "102", "201", "202", "301", "302"];
const reviewOnly = new Set(["OTA_WITHOUT_PARENT_ALIAS", "PARENT_GUEST_INCONSISTENT"]);

function validConfig(config) {
  if (!config || !uuid.test(config.workspaceId ?? "") || !uuid.test(config.propertyId ?? "") ||
    config.workspaceId === config.propertyId ||
    !Number.isSafeInteger(config.inventoryVersion) || config.inventoryVersion < 1 ||
    !Number.isSafeInteger(config.authorityEpoch) || config.authorityEpoch < 0 ||
    typeof config.sourceId !== "string" || !config.sourceId.trim() ||
    typeof config.expectedSourceHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(config.expectedSourceHash) ||
    typeof config.capturedAt !== "string" || !Number.isFinite(Date.parse(config.capturedAt)) ||
    typeof config.roomIds !== "object" || config.roomIds === null ||
    JSON.stringify(Object.keys(config.roomIds).sort()) !== JSON.stringify(roomNames) ||
    roomNames.some((name) => !uuid.test(config.roomIds[name] ?? "")) ||
    new Set(Object.values(config.roomIds)).size !== roomNames.length ||
    typeof config.bookingIds !== "object" || config.bookingIds === null ||
    Array.isArray(config.bookingIds)) throw Error("INVALID_SWEETFUN_SHADOW_CONFIG");
  if (config.cancellationTombstones !== undefined &&
    (!Array.isArray(config.cancellationTombstones) ||
      new Set(config.cancellationTombstones.map((item) => item?.sourceId)).size !==
        config.cancellationTombstones.length ||
      config.cancellationTombstones.some((item) =>
        typeof item?.sourceId !== "string" || !item.sourceId ||
        item.before?.values?.[9] !== item.sourceId ||
        !Number.isSafeInteger(item.before?.rowNumber) ||
        item.evidenceType !== "owner_attestation" ||
        typeof item.evidenceRef !== "string" || !item.evidenceRef.trim() ||
        !/^[0-9a-f]{64}$/.test(item.beforeHash ?? "") ||
        !/^[0-9a-f]{64}$/.test(item.afterHash ?? "") ||
        item.writerReceiptVerified !== false)))
    throw Error("INVALID_SWEETFUN_CANCELLATION_TOMBSTONES");
  if (config.retainedCancellationDecisions !== undefined &&
    (!Array.isArray(config.retainedCancellationDecisions) ||
      new Set(config.retainedCancellationDecisions.map((item) => item?.sourceId)).size !==
        config.retainedCancellationDecisions.length ||
      config.retainedCancellationDecisions.some((item) =>
        item?.outcome !== "cancelled" || item.evidenceType !== "owner_attestation" ||
        typeof item.evidenceRef !== "string" || !item.evidenceRef.trim() ||
        typeof item.sourceId !== "string" || !item.sourceId ||
        !Number.isSafeInteger(item.rowNumber) || item.rowNumber < 2 ||
        !/^[0-9a-f]{64}$/.test(item.sourceHash ?? "") ||
        !/^[0-9a-f]{64}$/.test(item.rowHash ?? ""))))
    throw Error("INVALID_SWEETFUN_RETAINED_CANCELLATION_DECISION");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function cell(values, index) {
  return String(values[index] ?? "").trim();
}

export function sweetfunRowHash(row) {
  return createHash("sha256").update(canonical({ rowNumber: row.rowNumber,
    values: row.values, notes: row.notes })).digest("hex");
}

/**
 * Prepare a lossless, read-only Iron Gate state from a frozen private Sheet copy.
 * An explicit, persistent UUID map and frozen source hash are required;
 * this function never invents IDs or accepts another snapshot version.
 * It does not seed a database, grant credentials, or claim availability authority.
 * Returned state contains private names, notes and aliases: keep it restricted.
 */
export function prepareSweetfunShadow(snapshot, config) {
  validConfig(config);
  const prepared = prepareSweetfunGroups(snapshot);
  if (prepared.sourceHash !== config.expectedSourceHash)
    throw Error("SWEETFUN_SOURCE_HASH_MISMATCH");
  if (!verifySweetfunGroups(snapshot, prepared).matches) throw Error("SWEETFUN_SOURCE_DRIFT");
  const accepted = prepared.candidates.filter((group) =>
    group.issues.every((issue) => reviewOnly.has(issue)));
  const quarantined = prepared.candidates.filter((group) =>
    group.issues.some((issue) => !reviewOnly.has(issue)));
  const acceptedKeys = new Set(accepted.map((group) => group.key));
  const retainedDecisions = new Map((config.retainedCancellationDecisions ?? [])
    .map((decision) => [decision.sourceId, decision]));
  const matchedDecisions = new Set();
  for (const group of accepted) for (const row of group.rows) {
    const decision = retainedDecisions.get(row.values[9]);
    if (!decision) continue;
    if (matchedDecisions.has(decision.sourceId) || group.rows.length !== 1 ||
      (decision.sourceHash === prepared.sourceHash && decision.rowNumber !== row.rowNumber) ||
      decision.rowHash !== sweetfunRowHash({ ...row, rowNumber: decision.rowNumber }))
      throw Error("SWEETFUN_RETAINED_CANCELLATION_SOURCE_DRIFT");
    matchedDecisions.add(decision.sourceId);
  }
  if (matchedDecisions.size !== retainedDecisions.size)
    throw Error("SWEETFUN_RETAINED_CANCELLATION_SOURCE_DRIFT");
  if (Object.keys(config.bookingIds).length !== acceptedKeys.size ||
    Object.keys(config.bookingIds).some((key) => !acceptedKeys.has(key)) ||
    accepted.some((group) => !uuid.test(config.bookingIds[group.key] ?? "")) ||
    new Set(Object.values(config.bookingIds)).size !== acceptedKeys.size)
    throw Error("INCOMPLETE_SWEETFUN_BOOKING_ID_MAP");
  const allIds = [config.workspaceId, config.propertyId,
    ...Object.values(config.roomIds), ...Object.values(config.bookingIds)];
  if (new Set(allIds).size !== allIds.length) throw Error("SWEETFUN_ID_COLLISION");

  const bookings = accepted.map((group) => {
    const guestNames = group.fields.guestNames.filter(Boolean);
    const bookedDates = group.fields.bookedDates.filter(Boolean);
    const notes = [...new Set(group.rows.map((row) => cell(row.values, 10)))].filter(Boolean);
    const stays = group.rows.map((row) => ({ checkIn: row.checkIn,
      checkOut: row.checkOut, roomIds: [config.roomIds[row.room]] }));
    const fee = BigInt(group.roomFeeCents);
    if (fee > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("SWEETFUN_FEE_OVERFLOW");
    // Only physical room-night and room fee facts enter the booking projection.
    // H, O:Q and notes remain source evidence, never fabricated payment events.
    const cancelled = retainedDecisions.has(group.rows[0].values[9]);
    return { id: config.bookingIds[group.key], workspaceId: config.workspaceId,
      propertyId: config.propertyId, version: cancelled ? 2 : 1,
      status: cancelled ? "cancelled" : "confirmed",
      channelSyncState: "not_required", channelOperationKey: null, stays,
      guestName: guestNames.length === 1 && group.fields.guestNames.length === 1
        ? guestNames[0] : null,
      contact: null, notes: notes.length === 1 ? notes[0] : null,
      totalCents: Number(fee), currency: "TWD",
      bookedAt: bookedDates.length === 1 ? bookedDates[0] : null,
      createdAt: config.capturedAt, source: "external", sourceKey: null,
      paymentEvents: [],
      sweetfunSnapshot: { sourceHash: prepared.sourceHash, groupKey: group.key,
        issues: structuredClone(group.issues), rows: structuredClone(group.rows) },
    };
  });

  const fenceByCell = new Map();
  let uncontainedReviewRows = 0;
  for (const group of quarantined) for (const row of group.rows) {
    if (!config.roomIds[row.room] || !row.checkIn || !row.checkOut ||
      Date.parse(`${row.checkOut}T00:00:00Z`) - Date.parse(`${row.checkIn}T00:00:00Z`) !== 86_400_000) {
      uncontainedReviewRows++;
      continue;
    }
    const key = `${config.roomIds[row.room]}:${row.checkIn}`;
    fenceByCell.set(key, { roomId: config.roomIds[row.room], date: row.checkIn });
  }
  if (uncontainedReviewRows) throw Error("UNCONTAINED_SWEETFUN_REVIEW_ROW");
  const fences = [...fenceByCell].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, cell]) => ({ key: `sweetfun-review:${createHash("sha256")
      .update(`${prepared.sourceHash}:${key}`).digest("hex").slice(0, 24)}`,
    cells: [cell], reason: "source_review" }));
  const occupied = new Map();
  for (const booking of bookings) if (booking.status !== "cancelled") for (const stay of booking.stays) {
    // Every accepted source row was independently validated as exactly one night.
    const key = `${stay.roomIds[0]}:${stay.checkIn}`;
    if (occupied.has(key)) throw Error("SWEETFUN_SHADOW_ROOM_COLLISION");
    occupied.set(key, booking.id);
  }
  for (const fence of fences) if (fence.cells.some((cell) =>
    occupied.has(`${cell.roomId}:${cell.date}`))) throw Error("SWEETFUN_SHADOW_FENCE_COLLISION");

  const state = {
    workspaceId: config.workspaceId, propertyId: config.propertyId,
    roomIds: roomNames.map((name) => config.roomIds[name]),
    version: config.inventoryVersion, authorityEpoch: config.authorityEpoch,
    readOnly: true,
    sweetfunImport: { sourceHash: prepared.sourceHash, sourceId: config.sourceId,
      capturedAt: config.capturedAt, headers: structuredClone(snapshot.headers),
      quarantined: structuredClone(quarantined),
      uncontainedReviewRows,
      ...(config.cancellationTombstones?.length ?
        { cancellationTombstones: structuredClone(config.cancellationTombstones) } : {}),
      ...(retainedDecisions.size ? { retainedCancellationDecisions:
        structuredClone(config.retainedCancellationDecisions) } : {}) },
    channel: { mode: "none", ready: false, websiteSalesEnabled: false,
      grantId: null, websiteBindingId: null },
    sourceGrants: [], bookings, sourceLinks: [], operations: [], fences,
    manualBlocks: [], receipts: [],
  };
  const acceptedFeeCents = bookings.reduce((sum, booking) =>
    sum + BigInt(booking.totalCents), 0n).toString();
  return { state, sourceHash: prepared.sourceHash,
    summary: { sourceRows: prepared.summary.sourceRows,
      sourceGroups: prepared.summary.candidateGroups,
      acceptedGroups: accepted.length, acceptedRows: accepted.reduce((n, g) => n + g.rows.length, 0),
      acceptedFeeCents, occupiedRoomNights: occupied.size,
      quarantinedGroups: quarantined.length,
      quarantinedRows: quarantined.reduce((n, g) => n + g.rows.length, 0),
      fencedRoomNights: fences.length, uncontainedReviewRows,
      paymentEventsCreated: 0, canStage: false, canCutover: false } };
}

/** Recompute source and candidate in both directions without returning private IDs. */
export function verifySweetfunShadow(snapshot, config, observedState) {
  let expected;
  try { expected = prepareSweetfunShadow(snapshot, config); }
  catch (error) {
    if (error?.message !== "SWEETFUN_SOURCE_HASH_MISMATCH") throw error;
    const current = prepareSweetfunGroups(snapshot);
    return { sourceRows: current.summary.sourceRows,
      projectedRows: null, sourceHash: current.sourceHash,
      expectedSourceHash: config.expectedSourceHash,
      readOnly: observedState?.readOnly === true, matches: false, canCutover: false };
  }
  const projectedRows = (observedState?.bookings ?? []).reduce((sum, booking) =>
    sum + (booking.sweetfunSnapshot?.rows?.length ?? 0), 0) +
    (observedState?.sweetfunImport?.quarantined ?? []).reduce((sum, group) =>
      sum + (group.rows?.length ?? 0), 0);
  return { sourceRows: expected.summary.sourceRows, projectedRows,
    sourceHash: expected.sourceHash,
    readOnly: observedState?.readOnly === true,
    matches: projectedRows === expected.summary.sourceRows &&
      canonical(observedState) === canonical(expected.state),
    canCutover: false };
}
