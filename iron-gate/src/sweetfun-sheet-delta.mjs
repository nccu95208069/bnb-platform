import { auditSweetfunSnapshot, SWEETFUN_HEADERS } from "./sweetfun-sheet-audit.mjs";
import { createHash } from "node:crypto";

function columns(row) {
  return SWEETFUN_HEADERS.map((_, index) => String(row.values[index] ?? ""));
}

function notes(row) {
  return SWEETFUN_HEADERS.map((_, index) => String(row.notes?.[index] ?? ""));
}

function sheetDateIso(value) {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const iso = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso
    ? iso : null;
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
    const oldNotes = oldRow && notes(oldRow), newNotes = newRow && notes(newRow);
    const changedColumns = oldRow && newRow
      ? SWEETFUN_HEADERS.flatMap((_, index) => oldColumns[index] === newColumns[index] ? [] : [index])
      : [];
    const changedNoteColumns = oldRow && newRow
      ? SWEETFUN_HEADERS.flatMap((_, index) => oldNotes[index] === newNotes[index] ? [] : [index])
      : [];
    const moved = Boolean(oldRow && newRow && oldRow.rowNumber !== newRow.rowNumber);
    if (!oldRow || !newRow || changedColumns.length || changedNoteColumns.length || moved) changes.push({
      sourceId,
      kind: !oldRow ? "appeared" : !newRow ? "disappeared" : "existing",
      moved,
      changedColumns, changedNoteColumns,
      before: oldRow ? { rowNumber: oldRow.rowNumber,
        values: structuredClone(oldRow.values), notes: structuredClone(oldRow.notes ?? []) } : null,
      after: newRow ? { rowNumber: newRow.rowNumber,
        values: structuredClone(newRow.values), notes: structuredClone(newRow.notes ?? []) } : null,
    });
  }
  return { beforeHash: oldAudit.sourceHash, afterHash: newAudit.sourceHash, changes,
    summary: {
      beforeRows: oldAudit.summary.sourceRows, afterRows: newAudit.summary.sourceRows,
      appeared: changes.filter((change) => change.kind === "appeared").length,
      disappeared: changes.filter((change) => change.kind === "disappeared").length,
      moved: changes.filter((change) => change.moved).length,
      changed: changes.filter((change) =>
        change.changedColumns.length || change.changedNoteColumns.length).length,
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

/** Turn an independently read Gmail success notification into a private,
 * version-bound review decision. The caller must obtain the message from the
 * intended mailbox; untrusted message data alone cannot prove its origin. */
export function decisionFromSweetfunCancellationNotice(diff, sourceId, message,
  expectedSender) {
  const change = diff?.changes?.find((item) =>
    item.sourceId === sourceId && item.kind === "disappeared");
  const values = change?.before?.values;
  const headers = message?.payload?.headers;
  if (!diff?.summary?.complete || !change || !Array.isArray(values) ||
    !Array.isArray(headers) || typeof expectedSender !== "string" ||
    !/^[^\s@<>]+@[^\s@<>]+$/.test(expectedSender) ||
    !/^[0-9a-f]{12,32}$/i.test(message?.id ?? "") ||
    typeof message?.internal_date !== "string" ||
    !/^\d{13}$/.test(message.internal_date) ||
    !Number.isSafeInteger(Number(message.internal_date)))
    throw Error("SWEETFUN_CANCELLATION_NOTICE_UNVERIFIED");
  const header = (name) => headers.filter((item) =>
    item?.name?.toLowerCase() === name).map((item) => item.value);
  const sender = header("from");
  const subject = header("subject");
  const auth = header("authentication-results");
  const bodyParts = message.payload.parts?.filter((item) =>
    item?.mime_type === "text/plain" && typeof item?.body?.content === "string") ?? [];
  const body = bodyParts[0]?.body?.content;
  const orderId = String(values[11] ?? "").trim();
  const room = String(values[0] ?? "").trim();
  const checkIn = sheetDateIso(values[3]);
  const checkOut = sheetDateIso(values[4]);
  if (sender.length !== 1 || !sender[0].endsWith(`<${expectedSender}>`) ||
    subject.length !== 1 ||
    subject[0] !== "[Gmail 訂單系統] ✅ 訂單取消處理成功" ||
    !auth.some((value) => value.startsWith("mx.google.com;") &&
      /\bdkim=pass\b/.test(value) && /\bdmarc=pass\b/.test(value) &&
      /\bspf=pass\b/.test(value) && /header\.from=gmail\.com\b/.test(value)) ||
    !body || !orderId || !room || !checkIn || !checkOut)
    throw Error("SWEETFUN_CANCELLATION_NOTICE_UNVERIFIED");
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const field = (name) => lines.filter((line) => line.startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1).trim());
  const expectedDetails = `${room} (${checkIn} → ${checkOut})`;
  if (field("處理狀態").length !== 1 || field("處理狀態")[0] !== "✅ 成功" ||
    field("通知類型").length !== 1 ||
    field("通知類型")[0] !== "訂單取消處理成功" ||
    field("order_id").length !== 1 || field("order_id")[0] !== orderId ||
    field("deleted_count").length !== 1 || field("deleted_count")[0] !== "1" ||
    field("deleted_details").length !== 1 ||
    field("deleted_details")[0] !== expectedDetails ||
    field("訊息").length !== 1 ||
    field("訊息")[0] !== `已成功刪除訂單 ${orderId} 的 1 筆資料`)
    throw Error("SWEETFUN_CANCELLATION_NOTICE_UNVERIFIED");
  return { outcome: "cancelled", evidenceType: "gmail_writer_notification",
    evidenceRef: `gmail:${message.id}`, sourceIds: [sourceId],
    beforeHash: diff.beforeHash, afterHash: diff.afterHash,
    receiptHash: createHash("sha256").update(JSON.stringify({
      id: message.id, internalDate: message.internal_date,
      from: sender[0], subject: subject[0], auth, body })).digest("hex") };
}

/**
 * Record an explicit private cancellation decision for vanished J rows. A bare
 * disappearance never becomes a cancellation. This is a review memo, not an
 * Iron Gate write or proof of which legacy writer removed the source rows.
 */
export function annotateSweetfunDisappearances(diff, decisions = []) {
  if (!diff?.summary?.complete || !Array.isArray(diff.changes) ||
    typeof diff.beforeHash !== "string" || typeof diff.afterHash !== "string" ||
    !Array.isArray(decisions)) throw Error("INVALID_SWEETFUN_DIFF_DECISIONS");
  const vanished = diff.changes.filter((change) => change.kind === "disappeared");
  const disappeared = new Map(vanished.map((change) => [change.sourceId, change]));
  if (disappeared.size !== vanished.length || disappeared.size !== diff.summary.disappeared ||
    vanished.some((change) => !change.sourceId || !change.before || change.after))
    throw Error("INVALID_SWEETFUN_DIFF_DECISIONS");
  const assigned = new Map();
  for (const decision of decisions) {
    if (decision?.outcome !== "cancelled" ||
      !["owner_attestation", "gmail_writer_notification"].includes(decision.evidenceType) ||
      typeof decision.evidenceRef !== "string" || !decision.evidenceRef.trim() ||
      (decision.evidenceType === "owner_attestation" &&
        decision.receiptHash !== undefined) ||
      (decision.evidenceType === "gmail_writer_notification" &&
        (!/^gmail:[0-9a-f]{12,32}$/i.test(decision.evidenceRef) ||
          !/^[0-9a-f]{64}$/.test(decision.receiptHash ?? ""))) ||
      decision.beforeHash !== diff.beforeHash || decision.afterHash !== diff.afterHash ||
      !Array.isArray(decision.sourceIds) || !decision.sourceIds.length ||
      new Set(decision.sourceIds).size !== decision.sourceIds.length)
      throw Error("INVALID_SWEETFUN_CANCELLATION_DECISION");
    for (const sourceId of decision.sourceIds) {
      if (!disappeared.has(sourceId) || assigned.has(sourceId))
        throw Error("CANCELLATION_SOURCE_ID_NOT_UNIQUE_DISAPPEARANCE");
      assigned.set(sourceId, decision);
    }
  }
  const tombstones = [...assigned].map(([sourceId, decision]) => ({
    sourceId, before: structuredClone(disappeared.get(sourceId).before),
    evidenceType: decision.evidenceType, evidenceRef: decision.evidenceRef,
    beforeHash: diff.beforeHash, afterHash: diff.afterHash,
    writerReceiptVerified: decision.evidenceType === "gmail_writer_notification",
    ...(decision.receiptHash ? { receiptHash: decision.receiptHash } : {}),
  }));
  const unresolved = [...disappeared.keys()].filter((sourceId) => !assigned.has(sourceId));
  return { tombstones, unresolved,
    summary: { disappeared: disappeared.size,
      ownerConfirmedCancelled: tombstones.filter((item) =>
        item.evidenceType === "owner_attestation").length,
      unresolved: unresolved.length,
      writerReceiptVerified: tombstones.filter((item) => item.writerReceiptVerified).length,
      canCutover: false } };
}
