import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function hash(domain, value) {
  return createHash("sha256").update(domain).update("\0").update(value).digest("hex");
}

export function sweetfunRowIdHash(value) {
  if (typeof value !== "string" || !value) throw Error("INVALID_SOURCE_J");
  return hash("sweetfun-row-id-v1", value);
}

function normalizedRow(row) {
  if (!Array.isArray(row) || row.length < 12) throw Error("INVALID_SHEET_ROW");
  return Array.from({ length: 19 }, (_, i) => String(row[i] ?? ""));
}

function fingerprintRow(row) {
  const values = normalizedRow(row);
  return { rowIdHash: sweetfunRowIdHash(values[9]),
    valueHash: hash("sweetfun-row-values-v1", JSON.stringify(values)) };
}

function fingerprintList(rows) {
  if (!Array.isArray(rows)) throw Error("INVALID_SHEET_ROWS");
  const result = rows.map(fingerprintRow).sort((a, b) =>
    a.rowIdHash < b.rowIdHash ? -1 : a.rowIdHash > b.rowIdHash ? 1 : 0);
  if (new Set(result.map((item) => item.rowIdHash)).size !== result.length)
    throw Error("DUPLICATE_SOURCE_J");
  return result;
}

export function sweetfunOrderFingerprint(rows, orderId) {
  if (!Array.isArray(rows) || typeof orderId !== "string" || !orderId.trim())
    throw Error("INVALID_SOURCE_ORDER");
  const selected = rows.slice(1).filter((row) =>
    Array.isArray(row) && row.length > 11 && String(row[11]).trim() === orderId.trim());
  const fingerprints = fingerprintList(selected);
  return { count: fingerprints.length, rows: fingerprints,
    digest: hash("sweetfun-order-rows-v1", JSON.stringify(fingerprints)) };
}

/** Accept only a completed Gmail claim matching two fixed Sheet observations. */
export function verifyGmailSheetWitness(witness, beforeRows, afterRows, orderId) {
  if (typeof orderId !== "string" || !orderId.trim() ||
    witness?.schema !== 1 || witness?.state !== "verified" ||
    !["new", "modify", "cancel"].includes(witness.kind) ||
    witness.orderIdHash !== hash("sweetfun-order-id-v1", orderId.trim()) ||
    !isDeepStrictEqual(witness.before, sweetfunOrderFingerprint(beforeRows, orderId)) ||
    !isDeepStrictEqual(witness.after, sweetfunOrderFingerprint(afterRows, orderId)))
    throw Error("GMAIL_WITNESS_SOURCE_MISMATCH");
  if (witness.kind === "cancel" &&
    (witness.before.count === 0 || witness.after.count !== 0))
    throw Error("GMAIL_WITNESS_SOURCE_MISMATCH");
  if (witness.kind === "new" &&
    (witness.before.count !== 0 || witness.after.count === 0))
    throw Error("GMAIL_WITNESS_SOURCE_MISMATCH");
  if (witness.kind === "modify" &&
    (witness.after.count === 0 || isDeepStrictEqual(witness.before, witness.after)))
    throw Error("GMAIL_WITNESS_SOURCE_MISMATCH");
  return { origin: "gmail", kind: witness.kind,
    before: witness.before.rows, after: witness.after.rows };
}

/** LINE's durable succeeded journal already contains its exact old/new plan. */
export function normalizeLineSucceededJournal(record) {
  const plan = record?.plan;
  if (record?.phase !== "succeeded" || typeof record.operation_id !== "string" ||
    !record.operation_id || !Number.isFinite(record.completed_at) ||
    plan?.property !== "sweetfun" ||
    !["create", "modify", "delete"].includes(plan.action))
    throw Error("LINE_JOURNAL_NOT_VERIFIED");
  const oldRows = fingerprintList(plan.old), newRows = fingerprintList(plan.new);
  if ((plan.action === "create" && (oldRows.length || !newRows.length)) ||
    (plan.action === "delete" && (!oldRows.length || newRows.length)) ||
    (plan.action === "modify" && (!oldRows.length || !newRows.length)))
    throw Error("LINE_JOURNAL_PLAN_MISMATCH");
  return { origin: "line", kind: plan.action,
    operationHash: hash("line-order-operation-v1", record.operation_id),
    completedAt: new Date(record.completed_at * 1000).toISOString(),
    oldRows, newRows };
}

/** Prove the stated LINE plan against source copies bracketing that operation. */
export function verifyLineJournalTransition(journal, beforeRows, afterRows) {
  const event = normalizeLineSucceededJournal(journal);
  const sourceRows = (rows) => {
    if (!Array.isArray(rows)) throw Error("INVALID_SHEET_ROWS");
    return fingerprintList(rows.slice(1).filter((row) =>
      Array.isArray(row) && row.some((value) => String(value ?? "").trim())));
  };
  const before = new Map(sourceRows(beforeRows).map((r) => [r.rowIdHash, r]));
  const after = new Map(sourceRows(afterRows).map((r) => [r.rowIdHash, r]));
  const oldIds = new Set(event.oldRows.map((r) => r.rowIdHash));
  const newIds = new Set(event.newRows.map((r) => r.rowIdHash));
  for (const row of event.oldRows)
    if (!isDeepStrictEqual(before.get(row.rowIdHash), row))
      throw Error("LINE_JOURNAL_SOURCE_MISMATCH");
  for (const row of event.newRows)
    if (!isDeepStrictEqual(after.get(row.rowIdHash), row))
      throw Error("LINE_JOURNAL_SOURCE_MISMATCH");
  for (const id of oldIds) if (!newIds.has(id) && after.has(id))
    throw Error("LINE_JOURNAL_SOURCE_MISMATCH");
  for (const id of newIds) if (!oldIds.has(id) && before.has(id))
    throw Error("LINE_JOURNAL_SOURCE_MISMATCH");
  return event;
}
