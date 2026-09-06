import { createHash } from "node:crypto";
import { SWEETFUN_SOURCE, type SheetSourceDefinition } from "../booking-sources/config.ts";
import { adaptSheetBookings, type BookingSourceSnapshot } from "../booking-sources/sweetfun-sheet.ts";

// Private connector state: retain only booking fields required to reconcile, never names,
// notes, contacts or LINE IDs. J/L remain private source keys, never returned by a route.
export const HEADERS = ["房型", "預定人姓名", "預定平台", "入住日期", "退房日期", "預訂日期", "房費", "全額支付狀態", "檢查狀態", "唯一ID", "備註", "訂單編號", "入住人數"];
export const SOURCE_ID = SWEETFUN_SOURCE.sourceId;
export type SourceRow = { cells: string[]; sourceRow: number };
export type MonitorState = {
  schema: 1;
  rows: SourceRow[] | null;
  archived: BookingSourceSnapshot["bookings"];
  snapshot: BookingSourceSnapshot;
  checkedAt: string | null;
  publishedAt: string | null;
  pending: { digest: string; since: string } | null;
  error: string | null;
  audit: { at: string; version: string; added: number; removed: number; changed: number }[];
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function taipeiDay(now: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}
export function cutoffDay(now: string): string {
  const date = new Date(taipeiDay(now) + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - 30);
  return date.toISOString().slice(0, 10);
}
function date(value: string): string {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (!m) throw new Error("SHEET_INVALID_DATE");
  const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().slice(0, 10) !== iso) throw new Error("SHEET_INVALID_DATE");
  return iso;
}
export function normalizeRows(values: unknown[][], source: SheetSourceDefinition = SWEETFUN_SOURCE): SourceRow[] {
  const headers = (values[0] ?? []).map(v => { const h = String(v).trim(); return source.headerAliases?.[h] ?? h; });
  for (const h of HEADERS.filter(h => h !== "備註" && h !== "入住人數" && !(h === "訂單編號" && source.parentOrderOptional))) {
    if (headers.filter(v => v === h).length !== 1) throw new Error("SHEET_SCHEMA_MISMATCH");
  }
  return values.slice(1).flatMap((row, i) => {
    if (!row.some(v => String(v ?? "").trim())) return [];
    const cells = HEADERS.map((h, index) => [1, 10].includes(index) ? "" : String(row[headers.indexOf(h)] ?? "").trim());
    cells[0] = source.roomAliases?.[cells[0]] ?? cells[0];
    if (source.formattedTwd && /^(?:NT\$\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(cells[6])) cells[6] = cells[6].replace(/^NT\$\s*/, "").replaceAll(",", "");
    if (/^\d+人$/.test(cells[12])) cells[12] = cells[12].slice(0, -1);
    if (!cells[9]) throw new Error("SHEET_MISSING_ROW_ID");
    cells[3] = date(cells[3]); cells[4] = date(cells[4]);
    if (Date.parse(cells[4]) - Date.parse(cells[3]) !== 86400000) throw new Error("SHEET_INVALID_ROOM_NIGHT");
    return [{ cells, sourceRow: i + 2 }];
  });
}
// Row positions and source order are not business changes. Keep duplicate multiplicity.
export const contentDigest = (rows: SourceRow[]) => hash(JSON.stringify(rows.map(r => JSON.stringify(r.cells)).sort()));

export function scopedRows(previous: SourceRow[], incoming: SourceRow[], now: string, source: SheetSourceDefinition = SWEETFUN_SOURCE): SourceRow[] {
  const cutoff = cutoffDay(now), today = taipeiDay(now);
  const all = [...previous, ...incoming];
  const knownRooms = new Set(source.property.rooms.map(r => r.number));
  const selected = new Set(all.filter(r => r.cells[3] >= cutoff || r.cells[4] >= today));
  // Close over both old/new identities, explicit parent groups and touched room-night
  // allocations. A move out of the window must replace its old row, not become a deletion.
  let expanded = true;
  while (expanded) {
    expanded = false;
    const ids = new Set([...selected].map(r => r.cells[9]));
    const parents = new Set([...selected].map(r => r.cells[11]).filter(Boolean));
    const slots = new Set([...selected].map(r => `${r.cells[0]}:${r.cells[3]}`));
    const dates = new Set([...selected].map(r => r.cells[3]));
    const unknownDates = new Set([...selected].filter(r => !knownRooms.has(r.cells[0])).map(r => r.cells[3]));
    for (const r of all) {
      if (!selected.has(r) && (ids.has(r.cells[9]) || (r.cells[11] && parents.has(r.cells[11])) || slots.has(`${r.cells[0]}:${r.cells[3]}`) || unknownDates.has(r.cells[3]) || (dates.has(r.cells[3]) && !knownRooms.has(r.cells[0])))) {
        selected.add(r); expanded = true;
      }
    }
  }
  const currentPositions = new Map<string, number[]>();
  for (const r of incoming) {
    const key = JSON.stringify(r.cells);
    currentPositions.set(key, [...(currentPositions.get(key) ?? []), r.sourceRow]);
  }
  // Out-of-scope deleted historical rows stay archived. Negative positions explicitly
  // mean archived evidence, not a claim that an old row number still identifies this row.
  return [...previous.filter(r => !selected.has(r)).map((r, i) => ({ ...r, sourceRow: currentPositions.get(JSON.stringify(r.cells))?.shift() ?? -(i + 1) })), ...incoming.filter(r => selected.has(r))];
}
export function initialState(snapshot: BookingSourceSnapshot): MonitorState {
  return { schema: 1, rows: null, archived: [], snapshot, checkedAt: null, publishedAt: null, pending: null, error: null, audit: [] };
}
export function reconcile(state: MonitorState, values: unknown[][], now: string, source: SheetSourceDefinition = SWEETFUN_SOURCE): MonitorState {
  if (state.snapshot.source.id !== source.sourceId) throw new Error("MONITOR_SOURCE_MISMATCH");
  const incoming = normalizeRows(values, source);
  // A completely cleared sheet requires operator investigation, not mass cancellation.
  if (!incoming.length) throw new Error("SHEET_EMPTY_SOURCE");
  const rows = state.rows ? scopedRows(state.rows, incoming, now, source) : incoming;
  const digest = contentDigest(rows);
  const base = { ...state, checkedAt: now, error: null };
  if (state.rows && digest === contentDigest(state.rows)) {
    const refreshed = adaptSheetBookings([HEADERS, ...rows.map(r => r.cells)], source.sourceId, state.snapshot.source.observed_at,
      state.snapshot.issues.filter(i => i.acknowledged).map(i => i.fingerprint), rows.map(r => r.sourceRow), source.property);
    refreshed.source.snapshot_version = state.snapshot.source.snapshot_version;
    refreshed.bookings.push(...state.archived);
    return { ...base, rows, snapshot: refreshed, pending: null };
  }
  // Two separate successful observations; same-minute retries cannot confirm a deletion.
  if (state.pending?.digest !== digest || Date.parse(now) - Date.parse(state.pending.since) < 30_000) {
    return { ...base, pending: state.pending?.digest === digest ? state.pending : { digest, since: now } };
  }
  const acks = state.snapshot.issues.filter(i => i.acknowledged).map(i => i.fingerprint);
  const snapshot = adaptSheetBookings([HEADERS, ...rows.map(r => r.cells)], source.sourceId, now, acks, rows.map(r => r.sourceRow), source.property);
  const presentIds = new Set(snapshot.bookings.map(b => b.id));
  const activeParents = new Set(snapshot.bookings.filter(b => b.check_in >= cutoffDay(now) || b.check_out >= taipeiDay(now)).map(b => b.order_id));
  // First activation starts with a fresh source index, but must not erase historical
  // cards already present in the deployed seed if those rows no longer exist in Sheet.
  const archived = (state.rows ? state.archived : state.snapshot.bookings.filter(b => b.check_in < cutoffDay(now) && b.check_out < taipeiDay(now)))
    .filter(b => !presentIds.has(b.id) && !activeParents.has(b.order_id));
  snapshot.bookings.push(...archived);
  // Canonical business version is independent of row order/positions and excludes PII.
  snapshot.source.snapshot_version = hash(source.sourceId + digest + snapshot.source.adapter_version + JSON.stringify(archived) + JSON.stringify(snapshot.issues.filter(i => i.acknowledged).map(i => i.fingerprint).sort())).slice(0, 20);
  const before = new Map((state.rows ?? []).map(r => [r.cells[9], JSON.stringify(r.cells)]));
  const after = new Map(rows.map(r => [r.cells[9], JSON.stringify(r.cells)]));
  const event = { at: now, version: snapshot.source.snapshot_version,
    added: [...after.keys()].filter(k => !before.has(k)).length,
    removed: [...before.keys()].filter(k => !after.has(k)).length,
    changed: [...after].filter(([k, v]) => before.has(k) && before.get(k) !== v).length };
  return { ...base, rows, archived, snapshot, publishedAt: now, pending: null, audit: [...state.audit, event].slice(-50) };
}
export function publicSnapshot(state: MonitorState, now: string): BookingSourceSnapshot {
  const stale = !state.checkedAt || Date.parse(now) - Date.parse(state.checkedAt) > 5 * 60_000;
  return { ...state.snapshot, source: { ...state.snapshot.source, automatic_sync: true,
    sync: { status: state.error ? "error" : !state.checkedAt ? "waiting" : stale ? "stale" : state.pending ? "confirming" : "healthy",
      last_checked_at: state.checkedAt, last_published_at: state.publishedAt,
      cutoff: cutoffDay(now), interval_seconds: 60, error_code: state.error } } };
}
