import { createHash } from "node:crypto";

const roomNames = ["101", "102", "201", "202", "301", "302"];
const cutoff = "2026-01-01";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** This exception retains the original source rows and their review fences.
 * It only permits the two exact, past room-night collisions approved by the
 * owner; new or current review rows still stop credential staging and cutover. */
export function sweetfunHistoricalReviewFingerprint(state) {
  const groups = state?.sweetfunImport?.quarantined;
  const fences = state?.fences;
  const sourceHash = state?.sweetfunImport?.sourceHash;
  if (!/^[0-9a-f]{64}$/.test(sourceHash ?? "") ||
    !Array.isArray(groups) || groups.length !== 4 ||
    !Array.isArray(fences) || fences.length !== 2 ||
    !Array.isArray(state.roomIds) || state.roomIds.length !== roomNames.length)
    return null;
  const cells = new Map();
  const rowHashes = [];
  for (const group of groups) {
    if (!Array.isArray(group?.issues) || group.issues.length !== 1 ||
      group.issues[0] !== "ROOM_NIGHT_CONFLICT" ||
      !Array.isArray(group.rows) || group.rows.length !== 1) return null;
    const row = group.rows[0];
    const roomIndex = roomNames.indexOf(row?.room);
    if (roomIndex < 0 || !/^2025-\d\d-\d\d$/.test(row.checkIn ?? "") ||
      !/^2025-\d\d-\d\d$/.test(row.checkOut ?? "") && row.checkOut !== cutoff ||
      Date.parse(`${row.checkOut}T00:00:00Z`) -
        Date.parse(`${row.checkIn}T00:00:00Z`) !== 86_400_000 ||
      row.checkOut > cutoff || row.rowHash !== sha256(JSON.stringify({
        values: row.values, notes: row.notes ?? [] }))) return null;
    const cell = `${state.roomIds[roomIndex]}:${row.checkIn}`;
    cells.set(cell, (cells.get(cell) ?? 0) + 1);
    rowHashes.push(row.rowHash);
  }
  if (cells.size !== 2 || [...cells.values()].some((count) => count !== 2))
    return null;
  const expectedFenceKeys = new Set([...cells.keys()].map((cell) =>
    `sweetfun-review:${sha256(`${sourceHash}:${cell}`).slice(0, 24)}`));
  const observedFenceKeys = new Set();
  for (const fence of fences) {
    if (fence?.reason !== "source_review" || !Array.isArray(fence.cells) ||
      fence.cells.length !== 1) return null;
    const cell = `${fence.cells[0]?.roomId}:${fence.cells[0]?.date}`;
    const expectedKey = `sweetfun-review:${sha256(`${sourceHash}:${cell}`).slice(0, 24)}`;
    if (!cells.has(cell) || fence.key !== expectedKey ||
      observedFenceKeys.has(fence.key)) return null;
    observedFenceKeys.add(fence.key);
  }
  if (observedFenceKeys.size !== expectedFenceKeys.size) return null;
  return sha256(JSON.stringify({ sourceHash, cutoff,
    rowHashes: rowHashes.sort(), fenceKeys: [...observedFenceKeys].sort() }));
}

export function sweetfunReviewResolved(state) {
  if (!Array.isArray(state?.sweetfunImport?.quarantined) ||
    !Array.isArray(state?.fences)) return false;
  if (state.sweetfunImport.quarantined.length === 0 && state.fences.length === 0)
    return true;
  const waiver = state?.sweetfunImport?.historicalReviewWaiver;
  const fingerprint = sweetfunHistoricalReviewFingerprint(state);
  return fingerprint !== null && waiver?.decision === "retain_source_exclude_live" &&
    waiver.cutoffDate === cutoff && waiver.sourceHash === state.sweetfunImport.sourceHash &&
    waiver.fingerprint === fingerprint &&
    typeof waiver.approvalRef === "string" && waiver.approvalRef.length > 0 &&
    typeof waiver.approvedAt === "string" &&
    Number.isFinite(Date.parse(waiver.approvedAt));
}

/** Prepare an auditable, versioned exception while the shadow is still read-only.
 * The four source rows and two fences remain in the state unchanged. */
export function planSweetfunHistoricalReviewWaiver(state, manifest) {
  const fingerprint = sweetfunHistoricalReviewFingerprint(state);
  if (!fingerprint || state?.readOnly !== true || state.authorityEpoch !== 0 ||
    state.version !== manifest?.expectedVersion ||
    state.sweetfunImport?.sourceHash !== manifest.expectedSourceHash ||
    state.sweetfunImport?.historicalReviewWaiver ||
    state.sourceGrants?.length !== 0 || state.operations?.length !== 0 ||
    state.receipts?.length !== 0 || state.manualBlocks?.length !== 0 ||
    state.sweetfunImport?.uncontainedReviewRows !== 0 ||
    manifest.fingerprint !== fingerprint ||
    typeof manifest.approvalRef !== "string" || !manifest.approvalRef.trim() ||
    typeof manifest.approvedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(manifest.approvedAt) ||
    !Number.isFinite(Date.parse(manifest.approvedAt)))
    throw Error("UNSAFE_SWEETFUN_HISTORICAL_REVIEW_WAIVER");
  const next = structuredClone(state);
  next.version++;
  next.sweetfunImport.historicalReviewWaiver = {
    decision: "retain_source_exclude_live", cutoffDate: cutoff,
    sourceHash: manifest.expectedSourceHash, fingerprint,
    approvalRef: manifest.approvalRef, approvedAt: manifest.approvedAt };
  if (!sweetfunReviewResolved(next))
    throw Error("UNSAFE_SWEETFUN_HISTORICAL_REVIEW_WAIVER");
  return { state: next, summary: { inventoryVersion: next.version,
    quarantinedGroupsRetained: 4, fencedRoomNightsRetained: 2 } };
}
