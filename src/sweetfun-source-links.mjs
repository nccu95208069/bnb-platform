import { createHash } from "node:crypto";
import { sweetfunRowHash } from "./sweetfun-shadow.mjs";

const rooms = ["101", "102", "201", "202", "301", "302"];

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function identityPart(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function sourceKey(groupKey, sourceSystem, sourceAccount) {
  if (typeof groupKey !== "string" || groupKey.length > 256 ||
    !/^(?:L|J):\S+$/u.test(groupKey) || /[\u0000-\u001f\u007f]/u.test(groupKey))
    throw Error("SWEETFUN_SOURCE_GROUP_ID_INVALID");
  return JSON.stringify([sourceSystem, sourceAccount, groupKey]);
}

function groupKeyForRows(groupKey, rows) {
  if (!Array.isArray(rows) || !rows.length || rows.some((row) =>
    !Array.isArray(row?.values) || typeof row?.rowHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.rowHash))) throw Error("SWEETFUN_SOURCE_ROWS_INVALID");
  if (groupKey.startsWith("L:")) {
    if (rows.some((row) => String(row.values[11] ?? "").trim() !== groupKey.slice(2)))
      throw Error("SWEETFUN_SOURCE_GROUP_ID_DRIFT");
  } else if (rows.length !== 1 || String(rows[0].values[9] ?? "").trim() !== groupKey.slice(2) ||
    String(rows[0].values[11] ?? "").trim()) throw Error("SWEETFUN_SOURCE_GROUP_ID_DRIFT");
}

function date(value) {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(value ?? "").trim());
  if (!match) throw Error("SWEETFUN_TOMBSTONE_DATE_INVALID");
  const iso = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const time = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== iso)
    throw Error("SWEETFUN_TOMBSTONE_DATE_INVALID");
  return { iso, time };
}

/**
 * Prepare source identity for a booking-only handoff from a frozen Sheet state.
 * This remains read-only and grants no credential or authority. The returned
 * state contains private source rows and must stay in restricted storage.
 */
export function prepareSweetfunSourceLinks(shadow, sourceSystem, sourceAccount) {
  if (!shadow?.readOnly || shadow.authorityEpoch !== 0 ||
    !/^[0-9a-f]{64}$/.test(shadow.sweetfunImport?.sourceHash ?? "") ||
    !Array.isArray(shadow.bookings) || !Array.isArray(shadow.roomIds) ||
    shadow.roomIds.length !== rooms.length || !Array.isArray(shadow.sourceLinks) ||
    shadow.sourceLinks.length || shadow.sourceGrants?.length || shadow.receipts?.length ||
    shadow.bookings.some((booking) => booking.paymentEvents?.length) ||
    sourceSystem !== "sweetfun-calendar-sheet" ||
    !identityPart(sourceSystem, 64) || !identityPart(sourceAccount, 128) ||
    shadow.sweetfunImport.sourceId !== sourceAccount)
    throw Error("UNSAFE_SWEETFUN_SOURCE_LINK_PREPARATION");

  const links = new Map();
  const retainedDecisions = new Map((shadow.sweetfunImport.retainedCancellationDecisions ?? [])
    .map((decision) => [decision?.sourceId, decision]));
  if (retainedDecisions.size !==
    (shadow.sweetfunImport.retainedCancellationDecisions ?? []).length)
    throw Error("SWEETFUN_RETAINED_CANCELLATION_LINK_CONFLICT");
  const matchedRetained = new Set();
  let activeLinks = 0;
  let retainedCancelledLinks = 0;
  for (const booking of shadow.bookings) {
    const groupKey = booking?.sweetfunSnapshot?.groupKey;
    const rows = booking?.sweetfunSnapshot?.rows;
    const key = sourceKey(groupKey, sourceSystem, sourceAccount);
    groupKeyForRows(groupKey, rows);
    if (booking.sweetfunSnapshot.sourceHash !== shadow.sweetfunImport.sourceHash ||
      !["confirmed", "cancelled"].includes(booking.status) ||
      !Number.isSafeInteger(booking.version) ||
      booking.version < 1 || links.has(key)) throw Error("SWEETFUN_SOURCE_LINK_CONFLICT");
    if (booking.status === "cancelled") {
      const row = rows[0];
      const decision = retainedDecisions.get(row?.values?.[9]);
      const roomIndex = rooms.indexOf(String(row?.values?.[0] ?? "").trim());
      const checkIn = date(row?.values?.[3]), checkOut = date(row?.values?.[4]);
      if (rows.length !== 1 || !decision ||
        decision.outcome !== "cancelled" || decision.evidenceType !== "owner_attestation" ||
        !identityPart(decision.evidenceRef, 256) ||
        !/^[0-9a-f]{64}$/.test(decision.sourceHash ?? "") ||
        !/^[0-9a-f]{64}$/.test(decision.rowHash ?? "") ||
        decision.rowNumber < 2 || !Number.isSafeInteger(decision.rowNumber) ||
        decision.rowHash !== sweetfunRowHash({ ...row, rowNumber: decision.rowNumber }) ||
        roomIndex < 0 || checkOut.time - checkIn.time !== 86_400_000 ||
        booking.stays.length !== 1 ||
        booking.stays[0].checkIn !== checkIn.iso ||
        booking.stays[0].checkOut !== checkOut.iso ||
        booking.stays[0].roomIds.length !== 1 ||
        booking.stays[0].roomIds[0] !== shadow.roomIds[roomIndex] ||
        matchedRetained.has(decision.sourceId))
        throw Error("SWEETFUN_RETAINED_CANCELLATION_LINK_CONFLICT");
      matchedRetained.add(decision.sourceId);
      retainedCancelledLinks++;
      links.set(key, { key, sourceSystem, sourceAccount, externalOrderId: groupKey,
        bookingId: booking.id,
        sourceVersion: `sheet-cancel-v1:${hash({ sourceHash: shadow.sweetfunImport.sourceHash,
          groupKey, rowHash: row.rowHash, decision })}`,
        lastAppliedBookingVersion: booking.version, diverged: false,
        tombstoneNights: [{ roomId: shadow.roomIds[roomIndex], date: checkIn.iso }] });
      continue;
    }
    if (rows.some((row) => retainedDecisions.has(row.values[9])))
      throw Error("SWEETFUN_RETAINED_CANCELLATION_LINK_CONFLICT");
    activeLinks++;
    links.set(key, { key, sourceSystem, sourceAccount, externalOrderId: groupKey,
      bookingId: booking.id,
      sourceVersion: `sheet-v1:${hash({ sourceHash: shadow.sweetfunImport.sourceHash,
        groupKey, rows: rows.map((row) => row.rowHash) })}`,
      lastAppliedBookingVersion: booking.version, diverged: false, tombstoneNights: [] });
  }
  if (matchedRetained.size !== retainedDecisions.size)
    throw Error("SWEETFUN_RETAINED_CANCELLATION_LINK_CONFLICT");

  const cancelled = new Map();
  for (const item of shadow.sweetfunImport.cancellationTombstones ?? []) {
    const values = item?.before?.values;
    if (!["owner_attestation", "gmail_writer_notification"].includes(item?.evidenceType) ||
      (item.evidenceType === "gmail_writer_notification"
        ? item.writerReceiptVerified !== true
        : item.writerReceiptVerified === true) ||
      (item.evidenceType === "gmail_writer_notification" &&
        (!/^gmail:[0-9a-f]{12,32}$/i.test(item.evidenceRef ?? "") ||
          !/^[0-9a-f]{64}$/.test(item.receiptHash ?? ""))) ||
      (item.evidenceType === "owner_attestation" &&
        item.receiptHash !== undefined) ||
      !Array.isArray(values) ||
      values[9] !== item.sourceId || !/^[0-9a-f]{64}$/.test(item.beforeHash ?? "") ||
      !/^[0-9a-f]{64}$/.test(item.afterHash ?? ""))
      throw Error("SWEETFUN_TOMBSTONE_INVALID");
    const groupKey = String(values[11] ?? "").trim()
      ? `L:${String(values[11]).trim()}` : `J:${item.sourceId}`;
    const key = sourceKey(groupKey, sourceSystem, sourceAccount);
    if (links.has(key)) throw Error("SWEETFUN_TOMBSTONE_ACTIVE_LINK_CONFLICT");
    const roomIndex = rooms.indexOf(String(values[0] ?? "").trim());
    const checkIn = date(values[3]), checkOut = date(values[4]);
    if (roomIndex < 0 || checkOut.time - checkIn.time !== 86_400_000)
      throw Error("SWEETFUN_TOMBSTONE_STAY_INVALID");
    const items = cancelled.get(key) ?? [];
    items.push({ rowId: item.sourceId, roomId: shadow.roomIds[roomIndex],
      date: checkIn.iso, beforeHash: item.beforeHash, afterHash: item.afterHash });
    cancelled.set(key, items);
  }
  for (const [key, items] of cancelled) {
    const sorted = items.sort((a, b) => a.roomId.localeCompare(b.roomId) ||
      a.date.localeCompare(b.date) || a.rowId.localeCompare(b.rowId));
    const cells = sorted.map(({ roomId, date }) => ({ roomId, date }));
    if (new Set(sorted.map((item) => item.rowId)).size !== sorted.length ||
      new Set(cells.map((cell) => `${cell.roomId}:${cell.date}`)).size !== cells.length)
      throw Error("SWEETFUN_TOMBSTONE_DUPLICATE");
    links.set(key, { key, sourceSystem, sourceAccount,
      externalOrderId: JSON.parse(key)[2],
      bookingId: null, sourceVersion: `sheet-cancel-v1:${hash(sorted)}`,
      lastAppliedBookingVersion: 0, diverged: false, tombstoneNights: cells });
  }

  const next = structuredClone(shadow);
  next.sourceLinks = [...links.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { state: next,
    summary: { activeLinks, cancelledLinks: cancelled.size + retainedCancelledLinks,
      sourceHash: shadow.sweetfunImport.sourceHash, readOnly: true, canCutover: false } };
}
