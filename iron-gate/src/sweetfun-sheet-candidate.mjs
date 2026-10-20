import { createHash } from "node:crypto";
import { auditSweetfunSnapshot, verifySweetfunAudit } from "./sweetfun-sheet-audit.mjs";

function cell(values, index) {
  return String(values[index] ?? "").trim();
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function opaque(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

/** Reproduce the current Sean OS Sheet adapter aliases; these are not IG UUIDs. */
export function legacySweetfunIds(sourceId, sourceJ, parentL = "") {
  if (typeof sourceId !== "string" || !sourceId.trim() ||
    typeof sourceJ !== "string" || !sourceJ.trim() ||
    typeof parentL !== "string") throw Error("INVALID_SWEETFUN_SOURCE_ID");
  const uid = sourceJ.trim(), parent = parentL.trim();
  return { rowId: `sheet-${opaque(`${sourceId}:row:${uid}`)}`,
    orderId: `SF-${opaque(`${sourceId}:order:${parent || `ungrouped:${uid}`}`)}` };
}

function distinct(values) {
  return [...new Set(values)].sort();
}

/**
 * A lossless private grouping view, not an Iron Gate booking or payment import.
 * The original A:S values remain attached to each candidate for restricted
 * source-to-target checks. Never log, commit, or serve the returned candidates.
 */
export function prepareSweetfunGroups(snapshot) {
  const audit = auditSweetfunSnapshot(snapshot);
  const rowsByNumber = new Map(snapshot.rows.map((row) => [row.rowNumber, row]));
  const groups = new Map();
  for (const record of audit.records) {
    const source = rowsByNumber.get(record.rowNumber);
    const key = record.parentAlias ? `L:${record.parentAlias}` :
      record.sourceId ? `J:${record.sourceId}` : `ROW:${record.rowNumber}`;
    const group = groups.get(key) ?? { key, rows: [], issues: [] };
    group.rows.push({ rowNumber: record.rowNumber, values: structuredClone(source.values),
      sourceId: record.sourceId, room: record.room, checkIn: record.checkIn,
      checkOut: record.checkOut, bookedAt: record.bookedAt,
      platform: record.platform, otaAlias: record.otaAlias,
      roomFeeCents: record.roomFeeCents,
      rowHash: digest(source.values) });
    for (const issue of record.issues) group.issues.push(issue);
    groups.set(key, group);
  }

  const candidates = [...groups.values()].map((group) => {
    const values = group.rows.map((row) => row.values);
    const fields = {
      guestNames: distinct(values.map((row) => cell(row, 1))),
      platforms: distinct(values.map((row) => cell(row, 2))),
      bookedDates: distinct(values.map((row) => cell(row, 5))),
      otaAliases: distinct(values.map((row) => cell(row, 13))),
      paymentMarkers: distinct(values.map((row) => cell(row, 7))),
    };
    if (fields.guestNames.length > 1) group.issues.push("PARENT_GUEST_INCONSISTENT");
    if (fields.platforms.length > 1) group.issues.push("PARENT_PLATFORM_INCONSISTENT");
    if (fields.bookedDates.length > 1) group.issues.push("PARENT_BOOKED_DATE_INCONSISTENT");
    if (fields.otaAliases.length > 1) group.issues.push("PARENT_OTA_INCONSISTENT");
    if (fields.paymentMarkers.length > 1) group.issues.push("PARENT_PAYMENT_MARKER_INCONSISTENT");
    if (group.key.startsWith("J:") && fields.otaAliases.some(Boolean))
      group.issues.push("OTA_WITHOUT_PARENT_ALIAS");
    const roomFeeCents = group.rows.every((row) => row.roomFeeCents !== null)
      ? group.rows.reduce((sum, row) => sum + BigInt(row.roomFeeCents), 0n).toString() : null;
    return { key: group.key, rows: group.rows,
      sourceIds: group.rows.map((row) => row.sourceId), fields, roomFeeCents,
      issues: distinct(group.issues) };
  });
  const groupIssues = new Map();
  for (const candidate of candidates) for (const issue of candidate.issues)
    groupIssues.set(issue, (groupIssues.get(issue) ?? 0) + 1);
  return { sourceHash: audit.sourceHash, candidates,
    summary: { sourceRows: audit.summary.sourceRows, candidateGroups: candidates.length,
      flaggedGroups: candidates.filter((item) => item.issues.length).length,
      issues: Object.fromEntries([...groupIssues].sort(([a], [b]) => a.localeCompare(b))),
      roomFeeCents: audit.summary.roomFeeCents, paymentEventsCreated: 0,
      canStage: false, canCutover: false } };
}

/** Check every original row in both directions and the entire grouping view. */
export function verifySweetfunGroups(snapshot, prepared) {
  const expected = prepareSweetfunGroups(snapshot);
  const sourceRows = snapshot.rows.filter((row) => row.values.some((value) =>
    String(value ?? "").trim()));
  const projected = (prepared?.candidates ?? []).flatMap((group) => group.rows ?? []);
  const sourceByNumber = new Map(sourceRows.map((row) => [row.rowNumber, row]));
  const projectedByNumber = new Map();
  let duplicate = 0, extra = 0, changed = 0;
  for (const row of projected) {
    if (projectedByNumber.has(row.rowNumber)) duplicate++;
    projectedByNumber.set(row.rowNumber, row);
    const source = sourceByNumber.get(row.rowNumber);
    if (!source) { extra++; continue; }
    if (digest(source.values) !== row.rowHash ||
      JSON.stringify(source.values) !== JSON.stringify(row.values) ||
      cell(source.values, 9) !== row.sourceId) changed++;
  }
  const missing = sourceRows.filter((row) => !projectedByNumber.has(row.rowNumber)).length;
  const auditMatches = verifySweetfunAudit(snapshot, auditSweetfunSnapshot(snapshot)).matches;
  const groupsMatch = JSON.stringify(prepared) === JSON.stringify(expected);
  return { sourceRows: sourceRows.length, projectedRows: projected.length,
    missing, extra, duplicate, changed, sourceUnchanged: prepared?.sourceHash === expected.sourceHash,
    groupsMatch, matches: auditMatches && groupsMatch && !missing && !extra && !duplicate && !changed,
    canCutover: false };
}
