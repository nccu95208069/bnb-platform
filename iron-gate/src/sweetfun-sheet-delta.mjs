import { auditSweetfunSnapshot, SWEETFUN_HEADERS } from "./sweetfun-sheet-audit.mjs";

function columns(row) {
  return SWEETFUN_HEADERS.map((_, index) => String(row.values[index] ?? ""));
}

function indexRows(snapshot, audit) {
  const byNumber = new Map(snapshot.rows.map((row) => [row.rowNumber, row]));
  const byId = new Map();
  for (const record of audit.records) {
    if (record.sourceId && !byId.has(record.sourceId))
      byId.set(record.sourceId, byNumber.get(record.rowNumber));
  }
  return byId;
}

function identityIssues(audit) {
  return ["SOURCE_ID_MISSING", "SOURCE_ID_DUPLICATE"]
    .filter((code) => audit.summary.issues[code]);
}

/**
 * Compare two restricted A:S snapshots by unique J, independently of row position.
 * Entries contain private source values and must never be logged, committed, or served.
 * A missing row is only a disappearance from the later snapshot, not a cancellation.
 */
export function diffSweetfunSnapshots(before, after) {
  const oldAudit = auditSweetfunSnapshot(before);
  const newAudit = auditSweetfunSnapshot(after);
  const blockingIssues = [...new Set([
    ...identityIssues(oldAudit).map((code) => `BEFORE_${code}`),
    ...identityIssues(newAudit).map((code) => `AFTER_${code}`),
  ])].sort();
  if (blockingIssues.length) return {
    beforeHash: oldAudit.sourceHash, afterHash: newAudit.sourceHash,
    changes: [], summary: { beforeRows: oldAudit.summary.sourceRows,
      afterRows: newAudit.summary.sourceRows, blockingIssues,
      complete: false, canApply: false, canCutover: false },
  };

  const oldRows = indexRows(before, oldAudit);
  const newRows = indexRows(after, newAudit);
  const ids = [...new Set([...oldRows.keys(), ...newRows.keys()])].sort();
  const changes = [];
  for (const sourceId of ids) {
    const oldRow = oldRows.get(sourceId), newRow = newRows.get(sourceId);
    const oldColumns = oldRow && columns(oldRow), newColumns = newRow && columns(newRow);
    const changedColumns = oldRow && newRow
      ? SWEETFUN_HEADERS.flatMap((_, index) => oldColumns[index] === newColumns[index] ? [] : [index])
      : [];
    const moved = Boolean(oldRow && newRow && oldRow.rowNumber !== newRow.rowNumber);
    if (!oldRow || !newRow || changedColumns.length || moved) changes.push({
      sourceId,
      kind: !oldRow ? "appeared" : !newRow ? "disappeared" : "existing",
      moved,
      changedColumns,
      before: oldRow ? { rowNumber: oldRow.rowNumber, values: structuredClone(oldRow.values) } : null,
      after: newRow ? { rowNumber: newRow.rowNumber, values: structuredClone(newRow.values) } : null,
    });
  }
  return { beforeHash: oldAudit.sourceHash, afterHash: newAudit.sourceHash, changes,
    summary: {
      beforeRows: oldAudit.summary.sourceRows, afterRows: newAudit.summary.sourceRows,
      appeared: changes.filter((change) => change.kind === "appeared").length,
      disappeared: changes.filter((change) => change.kind === "disappeared").length,
      moved: changes.filter((change) => change.moved).length,
      changed: changes.filter((change) => change.changedColumns.length).length,
      blockingIssues: [], complete: true, canApply: false, canCutover: false,
    } };
}

/** Recompute the full diff to catch missing, extra, or altered private entries. */
export function verifySweetfunDiff(before, after, diff) {
  const expected = diffSweetfunSnapshots(before, after);
  return { matches: JSON.stringify(diff) === JSON.stringify(expected),
    beforeUnchanged: diff?.beforeHash === expected.beforeHash,
    afterUnchanged: diff?.afterHash === expected.afterHash,
    canCutover: false };
}
