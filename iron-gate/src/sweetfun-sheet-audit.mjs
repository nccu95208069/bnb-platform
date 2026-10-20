import { createHash } from "node:crypto";

export const SWEETFUN_HEADERS = Object.freeze([
  "房型", "預定人姓名", "預定平台", "入住日期", "退房日期", "預訂日期", "房費",
  "全額支付狀態", "檢查狀態", "唯一ID", "備註", "訂單編號", "AI 登記",
  "OTA訂單編號", "刷卡日期", "刷卡金額", "刷卡狀態", "LINE User ID", "標籤",
]);

const ROOM_NAMES = new Set(["101", "102", "201", "202", "301", "302"]);
const PAYMENT_MARKERS = new Set(["", "done", "not_yet", "not yet"]);

function cell(values, index) {
  return String(values[index] ?? "").trim();
}

function day(value) {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (!match) return null;
  const normalized = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const millis = Date.parse(`${normalized}T00:00:00Z`);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === normalized
    ? normalized : null;
}

function cents(value) {
  const text = value.replaceAll(",", "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

function exactHeader(headers) {
  return Array.isArray(headers) && headers.length >= SWEETFUN_HEADERS.length &&
    SWEETFUN_HEADERS.every((value, index) => cell(headers, index) === value);
}

function validRow(item) {
  return item && Number.isSafeInteger(item.rowNumber) && item.rowNumber >= 2 &&
    Array.isArray(item.values) && item.values.length <= SWEETFUN_HEADERS.length;
}

/**
 * Normalize a frozen Sheet value snapshot to one record per source room-night.
 * Records contain private source IDs and must remain in restricted memory/storage.
 * This function never emits payment events, parent bookings, or an enabled IG state.
 */
export function auditSweetfunSnapshot(snapshot) {
  if (!snapshot || !exactHeader(snapshot.headers) || !Array.isArray(snapshot.rows) ||
    snapshot.rows.some((item) => !validRow(item))) throw Error("INVALID_SWEETFUN_SNAPSHOT");
  const numbers = snapshot.rows.map((item) => item.rowNumber);
  if (new Set(numbers).size !== numbers.length ||
    numbers.some((number, index) => index && number <= numbers[index - 1]))
    throw Error("UNORDERED_SWEETFUN_ROWS");

  const sourceHash = createHash("sha256").update(JSON.stringify({
    headers: snapshot.headers, rows: snapshot.rows,
  })).digest("hex");
  const records = [];
  const bySourceId = new Map();
  const byRoomNight = new Map();
  const issueRows = new Map();
  const flag = (record, code) => {
    if (record.issues.includes(code)) return;
    record.issues.push(code);
    issueRows.set(code, [...(issueRows.get(code) ?? []), record.rowNumber]);
  };

  for (const item of snapshot.rows) {
    if (!item.values.some((value) => String(value ?? "").trim())) continue;
    const room = cell(item.values, 0);
    const checkIn = day(cell(item.values, 3));
    const checkOut = day(cell(item.values, 4));
    const amount = cents(cell(item.values, 6));
    const sourceId = cell(item.values, 9);
    const record = {
      rowNumber: item.rowNumber,
      sourceId,
      parentAlias: cell(item.values, 11),
      platform: cell(item.values, 2),
      otaAlias: cell(item.values, 13),
      room,
      checkIn,
      checkOut,
      roomFeeCents: amount,
      paymentMarker: cell(item.values, 7),
      issues: [],
    };
    records.push(record);
    if (!sourceId) flag(record, "SOURCE_ID_MISSING");
    else bySourceId.set(sourceId, [...(bySourceId.get(sourceId) ?? []), record]);
    if (!ROOM_NAMES.has(room)) flag(record, "ROOM_UNKNOWN");
    if (!checkIn || !checkOut) flag(record, "DATE_INVALID");
    else if (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`) !== 86_400_000)
      flag(record, "STAY_NOT_SINGLE_NIGHT");
    if (amount === null) flag(record, "ROOM_FEE_INVALID");
    if (!PAYMENT_MARKERS.has(record.paymentMarker)) flag(record, "PAYMENT_MARKER_UNKNOWN");
    if (cell(item.values, 8) !== "OK") flag(record, "SOURCE_CHECK_NOT_OK");
    if (ROOM_NAMES.has(room) && checkIn)
      byRoomNight.set(`${room}|${checkIn}`, [...(byRoomNight.get(`${room}|${checkIn}`) ?? []), record]);
  }

  for (const group of bySourceId.values()) if (group.length > 1)
    for (const record of group) flag(record, "SOURCE_ID_DUPLICATE");
  for (const group of byRoomNight.values()) if (group.length > 1)
    for (const record of group) flag(record, "ROOM_NIGHT_CONFLICT");
  for (const record of records) record.issues.sort();
  const parentGroups = new Map();
  for (const record of records) if (record.parentAlias)
    parentGroups.set(record.parentAlias, (parentGroups.get(record.parentAlias) ?? 0) + 1);

  return {
    sourceHash,
    records,
    summary: {
      sourceRows: records.length,
      uniqueSourceIds: bySourceId.size,
      blankParentAliases: records.filter((record) => !record.parentAlias).length,
      distinctParentAliases: parentGroups.size,
      multiRowParentAliases: [...parentGroups.values()].filter((count) => count > 1).length,
      roomDateKeysObserved: byRoomNight.size,
      roomFeeCents: records.every((record) => record.roomFeeCents !== null)
        ? records.reduce((sum, record) => sum + BigInt(record.roomFeeCents), 0n).toString() : null,
      issues: Object.fromEntries([...issueRows].sort(([a], [b]) => a.localeCompare(b))
        .map(([code, rows]) => [code, { count: rows.length, rows: rows.sort((a, b) => a - b) }])),
      paymentEventsCreated: 0,
      canCutover: false,
    },
  };
}

/** Independent forward/reverse coverage check for structural row projections. */
export function verifySweetfunAudit(snapshot, audit) {
  if (!snapshot || !Array.isArray(snapshot.rows) || !audit || !Array.isArray(audit.records))
    throw Error("INVALID_SWEETFUN_AUDIT");
  const sources = snapshot.rows.filter((item) => validRow(item) &&
    item.values.some((value) => String(value ?? "").trim()));
  const sourceHash = createHash("sha256").update(JSON.stringify({
    headers: snapshot.headers, rows: snapshot.rows,
  })).digest("hex");
  const sourceUnchanged = sourceHash === audit.sourceHash;
  const projected = new Map();
  let duplicateProjectedRows = 0;
  for (const record of audit.records) {
    if (projected.has(record.rowNumber)) duplicateProjectedRows++;
    projected.set(record.rowNumber, record);
  }
  let missing = 0, changed = 0;
  for (const item of sources) {
    const record = projected.get(item.rowNumber);
    if (!record) { missing++; continue; }
    const room = cell(item.values, 0), checkIn = day(cell(item.values, 3));
    if (record.sourceId !== cell(item.values, 9) || record.parentAlias !== cell(item.values, 11) ||
      record.platform !== cell(item.values, 2) || record.otaAlias !== cell(item.values, 13) ||
      record.room !== room || record.checkIn !== checkIn ||
      record.checkOut !== day(cell(item.values, 4)) ||
      record.roomFeeCents !== cents(cell(item.values, 6)) ||
      record.paymentMarker !== cell(item.values, 7)) changed++;
  }
  const sourceNumbers = new Set(sources.map((item) => item.rowNumber));
  const extra = audit.records.filter((record) => !sourceNumbers.has(record.rowNumber)).length;
  return { sourceRows: sources.length, projectedRows: audit.records.length, missing,
    extra, changed, duplicateProjectedRows, sourceUnchanged,
    matches: sourceUnchanged && !missing && !extra && !changed && !duplicateProjectedRows,
    canCutover: false };
}
