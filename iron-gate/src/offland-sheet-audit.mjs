import { createHash } from "node:crypto";

export const OFFLAND_HEADERS = Object.freeze([
  "房間", "用戶名稱", "預定平台", "入住日期", "退房日期", "預訂日期", "房費",
  "全額支付狀態", "檢查狀態", "唯一ID", "備註", "入住人數", "付款日期",
  "已付金額", "刷卡狀態", "付款UID", "訂單編號",
]);

const DAY_MS = 86_400_000;
const rooms = new Set(["OFFLAND", "OFFLAND(連住)"]);
const text = (value) => String(value ?? "").trim();
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function offlandDate(value) {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(text(value));
  if (!match) return null;
  const iso = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const time = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === iso
    ? iso : null;
}

export function offlandFeeCents(value) {
  const raw = text(value).replace(/^(?:NT\$|TWD)\s*/i, "").replaceAll(",", "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

function validRow(row) {
  return row && Number.isSafeInteger(row.rowNumber) && row.rowNumber >= 2 &&
    Array.isArray(row.values) && row.values.length === OFFLAND_HEADERS.length &&
    row.values.every((value) => typeof value === "string") &&
    (row.entered === undefined || Array.isArray(row.entered) &&
      row.entered.length === OFFLAND_HEADERS.length &&
      row.entered.every((value) => typeof value === "string")) &&
    (row.notes === undefined || Array.isArray(row.notes) &&
      row.notes.length === OFFLAND_HEADERS.length &&
      row.notes.every((value) => value === null || typeof value === "string"));
}

/** Audit a private A:Q snapshot. O is card status; only Q may be a parent ID. */
export function auditOfflandSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.headers) ||
    snapshot.headers.length !== OFFLAND_HEADERS.length ||
    snapshot.headers.some((value, index) => text(value) !== OFFLAND_HEADERS[index]) ||
    !Array.isArray(snapshot.rows) || snapshot.rows.some((row) => !validRow(row)))
    throw Error("INVALID_OFFLAND_SNAPSHOT");
  const numbers = snapshot.rows.map((row) => row.rowNumber);
  if (new Set(numbers).size !== numbers.length ||
    numbers.some((number, index) => index && number <= numbers[index - 1]))
    throw Error("UNORDERED_OFFLAND_ROWS");

  const records = [];
  const byJ = new Map(), byDate = new Map(), issueRows = new Map();
  const flag = (record, issue) => {
    if (record.issues.includes(issue)) return;
    record.issues.push(issue);
    issueRows.set(issue, [...(issueRows.get(issue) ?? []), record.rowNumber]);
  };
  for (const row of snapshot.rows) {
    if (!row.values.some((value) => text(value))) continue;
    const v = row.values;
    const record = { rowNumber: row.rowNumber, sourceId: text(v[9]),
      parentId: text(v[16]), room: text(v[0]), platform: text(v[2]),
      checkIn: offlandDate(v[3]), checkOut: offlandDate(v[4]),
      bookedAt: offlandDate(v[5]), roomFeeCents: offlandFeeCents(v[6]),
      issues: [] };
    records.push(record);
    if (!rooms.has(record.room)) flag(record, "ROOM_UNKNOWN");
    if (!text(v[1])) flag(record, "GUEST_NAME_MISSING");
    if (!record.platform) flag(record, "PLATFORM_MISSING");
    if (!record.sourceId) flag(record, "SOURCE_ID_MISSING");
    if (record.sourceId) byJ.set(record.sourceId,
      [...(byJ.get(record.sourceId) ?? []), record]);
    if (record.parentId && (record.parentId.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(record.parentId))) flag(record, "PARENT_ID_INVALID");
    if (!record.checkIn || !record.checkOut) flag(record, "DATE_INVALID");
    else if (Date.parse(`${record.checkOut}T00:00:00Z`) -
      Date.parse(`${record.checkIn}T00:00:00Z`) !== DAY_MS)
      flag(record, "STAY_NOT_SINGLE_NIGHT");
    if (!record.bookedAt) flag(record, "BOOKED_DATE_INVALID");
    if (record.roomFeeCents === null) flag(record, "ROOM_FEE_INVALID");
    if (text(v[8]) !== "OK") flag(record, "SOURCE_CHECK_NOT_OK");
    if (record.checkIn) byDate.set(record.checkIn,
      [...(byDate.get(record.checkIn) ?? []), record]);
  }
  for (const group of byJ.values()) if (group.length > 1)
    for (const record of group) flag(record, "SOURCE_ID_DUPLICATE");
  // The two A aliases refer to the same physical villa.
  for (const group of byDate.values()) if (group.length > 1)
    for (const record of group) flag(record, "VILLA_NIGHT_CONFLICT");
  for (const record of records) record.issues.sort();
  const parentGroups = new Map();
  for (const record of records) if (record.parentId)
    parentGroups.set(record.parentId, (parentGroups.get(record.parentId) ?? 0) + 1);
  return { sourceHash: hash({ headers: snapshot.headers, rows: snapshot.rows }), records,
    summary: { sourceRows: records.length, uniqueSourceIds: byJ.size,
      blankParentIds: records.filter((record) => !record.parentId).length,
      distinctParentIds: parentGroups.size,
      multiRowParentIds: [...parentGroups.values()].filter((count) => count > 1).length,
      occupiedVillaNights: byDate.size,
      roomFeeCents: records.every((record) => record.roomFeeCents !== null)
        ? records.reduce((sum, record) => sum + BigInt(record.roomFeeCents), 0n).toString() : null,
      issues: Object.fromEntries([...issueRows].sort(([a], [b]) => a.localeCompare(b))
        .map(([issue, rows]) => [issue, { count: rows.length,
          rows: rows.sort((a, b) => a - b) }])), paymentEventsCreated: 0,
      canCutover: false } };
}

export function verifyOfflandAudit(snapshot, observed) {
  const expected = auditOfflandSnapshot(snapshot);
  const same = JSON.stringify(expected) === JSON.stringify(observed);
  return { sourceRows: expected.summary.sourceRows,
    sourceHash: expected.sourceHash, matches: same, canCutover: false };
}
