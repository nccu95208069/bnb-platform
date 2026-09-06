import { createHash } from "node:crypto";
import type { CalendarBooking } from "../../components/calendar/calendar-types";

// Source adapters own format interpretation. Calendar UI consumes this common projection.
// This projection is read-only and contains no guest identity or original order numbers.
export type SourceIssue = { code: string; rows: number[]; date?: string; room?: string; fingerprint: string; acknowledged: boolean };
export type BookingSourceSnapshot = {
  schema_version: 1;
  source: { id: string; kind: "google_sheet_snapshot"; label: string; observed_at: string;
    snapshot_version: string; adapter_version: string; price_basis: "sheet_recorded_room_night"; payment_ledger_available: false;
    read_only: true; anonymized: true; automatic_sync: false; availability_authoritative: false };
  bookings: CalendarBooking[];
  issues: SourceIssue[];
  summary: { rows: number; accepted_rows: number; quarantined_rows: number; blocked_room_nights: number;
    missing_order_id: number; row_id_fallback_rows: number; missing_payment_status: number; new_issue_rows: number; historical_issue_rows: number };
};

const REQUIRED = ["房型", "預定人姓名", "預定平台", "入住日期", "退房日期", "預訂日期", "房費", "全額支付狀態", "檢查狀態", "唯一ID", "訂單編號"];
const ADAPTER_VERSION = "sweetfun-sheet-v3";
const ROOMS = ["101", "102", "201", "202", "301", "302"];
const PLATFORM: Record<string, string> = { booking: "booking", "booking.com": "booking", agoda: "agoda", airbnb: "airbnb", line: "direct", ctrip: "ctrip", owljourney: "owljourney" };
const opaque = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);
function iso(value: string): string | null {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (!m) return null;
  const result = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const timestamp = Date.parse(result + "T00:00:00Z");
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === result ? result : null;
}

export function adaptSweetfunSheet(values: unknown[][], sourceId: string, observedAt: string, acknowledgedIssues: string[] = []): BookingSourceSnapshot {
  const headers = (values[0] ?? []).map(v => String(v).trim());
  if (REQUIRED.some(h => headers.filter(v => v === h).length !== 1)) throw new Error("SHEET_SCHEMA_MISMATCH");
  const rows = values.slice(1).map((row, index) => {
    const get = (name: string) => String(row[headers.indexOf(name)] ?? "").trim();
    return { row: index + 2, get, room: get("房型"), uid: get("唯一ID"), order: get("訂單編號"),
      start: iso(get("入住日期")), end: iso(get("退房日期")), amount: Number(get("房費")) };
  }).filter(r => headers.some(h => r.get(h)));
  const issues: SourceIssue[] = [];
  const acknowledged = new Set(acknowledgedIssues);
  const blocked = new Set<number>();
  const add = (code: string, records: typeof rows) => {
    records.forEach(r => blocked.add(r.row));
    // Acknowledgement follows the exact conflicting records, never mutable sheet row numbers.
    const fingerprint = opaque(JSON.stringify([sourceId, code, records.map(r =>
      JSON.stringify([r.uid, r.room, r.start, r.end, r.order, r.amount, r.get("檢查狀態")])
    ).sort()]));
    issues.push({ code, rows: records.map(r => r.row), date: records[0]?.start ?? undefined,
      room: records[0]?.room, fingerprint, acknowledged: acknowledged.has(fingerprint) });
  };
  for (const r of rows) {
    if (!r.uid) add("missing_row_id", [r]);
    if (!r.start || !r.end || Date.parse(r.end) - Date.parse(r.start) !== 86400000) add("invalid_room_night", [r]);
    if (!ROOMS.includes(r.room)) add("unmapped_room", [r]);
    if (!r.get("房費") || !Number.isFinite(r.amount) || r.amount < 0) add("invalid_amount", [r]);
    if (r.get("檢查狀態") !== "OK") add("unchecked_row", [r]);
  }
  for (const key of ["uid", "slot"] as const) {
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const value = key === "uid" ? r.uid : `${r.room}:${r.start}`;
      if (value) groups.set(value, [...(groups.get(value) ?? []), r]);
    }
    for (const group of groups.values()) if (group.length > 1) add(key === "uid" ? "duplicate_row_id" : "room_night_conflict", group);
  }
  for (const r of rows.filter(r => !ROOMS.includes(r.room) && r.start)) {
    const affected = rows.filter(other => other.start === r.start && ROOMS.includes(other.room));
    if (affected.length) add("unmapped_property_overlap", affected);
  }
  const make = (id: string, orderId: string, room: string, start: string, end: string): CalendarBooking => ({
    id, sheet_row_id: id, order_id: orderId, external_order_no: null, property_id: "sweetfun", property_name: "水芳 Sweetfun",
    room_id: `sweetfun-${room}`, room_number: room, guest_name: `旅客 ${orderId.slice(-6).toUpperCase()}`,
    platform: "other", check_in: start, check_out: end, booked_at: null, room_rate: 0,
    payment_status: "unknown", reservation_status: "confirmed", notes: null, payments: [], audit_log: [],
    extra_guest_count: 0, extra_bed_count: 0, pet_count: 0, baby_supplies: [], service_note: null,
    source_read_only: true, requirements_known: false,
  });
  const bookings: CalendarBooking[] = [];
  const slots = new Map<string, { room: string; start: string; end: string }>();
  for (const r of rows) {
    if (blocked.has(r.row)) {
      if (r.start && r.end && Date.parse(r.end) - Date.parse(r.start) === 86400000) {
        // An unassigned/whole-property row must not silently make any physical room look free.
        for (const room of ROOMS.includes(r.room) ? [r.room] : ROOMS) slots.set(`${room}:${r.start}`, { room, start: r.start, end: r.end });
      }
      continue;
    }
    const id = `sheet-${opaque(`${sourceId}:row:${r.uid}`)}`;
    // Missing parent order ID is explicitly ungrouped; never infer by guest name or adjacent nights.
    const orderId = `SF-${opaque(`${sourceId}:order:${r.order || `ungrouped:${r.uid}`}`)}`;
    const booking = make(id, orderId, r.room, r.start!, r.end!);
    booking.platform = PLATFORM[r.get("預定平台").toLowerCase()] ?? "other";
    booking.booked_at = iso(r.get("預訂日期"));
    booking.room_rate = r.amount;
    booking.payment_status = r.get("全額支付狀態") === "done" ? "paid" : "unknown";
    booking.source_payment_label = r.get("全額支付狀態") === "done" ? "客人已付清；OTA 收款與旅宿入帳尚未記錄" :
      ["not_yet", "not yet"].includes(r.get("全額支付狀態")) ? "來源標記尚未完成付款" : "來源未提供明確付款狀態";
    booking.source_order_linked = Boolean(r.order);
    booking.source_identity_kind = r.order ? "parent_order" : "row";
    booking.nightly_amounts = [{ date: r.start!, amount: r.amount }];
    booking.notes = r.order ? "已依來源訂單編號串接連住；公開畫面顯示匿名編號。" : "依唯一 ID 識別此房晚。訂單編號可空白；跨列連住需共同編號才能合併。";
    if (!PLATFORM[r.get("預定平台").toLowerCase()]) booking.notes += " 通路名稱需確認，暫列其他。";
    bookings.push(booking);
  }
  // Quarantine overlapping data, preserve an explicit calendar block, and exclude disputed money.
  for (const { room, start, end } of slots.values()) {
    const id = `issue-${opaque(`${sourceId}:${room}:${start}`)}`;
    const marker = make(id, id, room, start, end);
    const affectedRows = new Set(rows.filter(r => blocked.has(r.row) && r.start === start &&
      (r.room === room || !ROOMS.includes(r.room))).map(r => r.row));
    const relevantIssues = issues.filter(i => i.rows.some(row => affectedRows.has(row)));
    marker.source_issue_acknowledged = relevantIssues.length > 0 && relevantIssues.every(i => i.acknowledged);
    marker.guest_name = marker.source_issue_acknowledged ? "歷史房況" : "房況待核對";
    marker.source_conflict = true;
    marker.price_hidden = true;
    marker.notes = marker.source_issue_acknowledged
      ? "擁有者已決定暫不追查此筆既有來源問題。保留歷史房況，不計入已核定房費，也不推定可售。"
      : "來源有新的或已變動的重複、重疊、未核對或房間對應問題。此格不代表空房，也不計入房費；需先核對 Sheet。";
    bookings.push(marker);
  }
  const newIssueRows = new Set(issues.filter(i => !i.acknowledged).flatMap(i => i.rows));
  return {
    schema_version: 1,
    source: { id: sourceId, kind: "google_sheet_snapshot", label: "Sweetfun 訂房表", observed_at: observedAt,
      snapshot_version: opaque(ADAPTER_VERSION + JSON.stringify(values) + JSON.stringify(issues.filter(i => i.acknowledged).map(i => i.fingerprint).sort())), adapter_version: ADAPTER_VERSION, price_basis: "sheet_recorded_room_night", payment_ledger_available: false,
      read_only: true, anonymized: true, automatic_sync: false, availability_authoritative: false },
    bookings, issues,
    summary: { rows: rows.length, accepted_rows: rows.length - blocked.size, quarantined_rows: blocked.size, blocked_room_nights: slots.size,
      missing_order_id: rows.filter(r => !r.order).length,
      row_id_fallback_rows: rows.filter(r => !r.order).length,
      new_issue_rows: newIssueRows.size, historical_issue_rows: blocked.size - newIssueRows.size,
      missing_payment_status: rows.filter(r => !r.get("全額支付狀態")).length },
  };
}
