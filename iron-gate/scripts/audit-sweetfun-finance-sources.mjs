import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { legacySweetfunIds } from "../src/sweetfun-sheet-candidate.mjs";
import { prepareSweetfunFinanceClaims, verifySweetfunFinanceClaims } from
  "../src/sweetfun-finance-candidate.mjs";

const property = "sweetfun";
const ledgerPrefix = `sweetfun-os:payments:v1:${property}:`;

function privateJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 2_000_000)
    throw Error("UNSAFE_PRIVATE_INPUT");
  return JSON.parse(readFileSync(path, "utf8"));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ledgerKey(orderId) {
  return ledgerPrefix + digest(JSON.stringify(orderId));
}

function centsFromTwd(value) {
  if (!Number.isFinite(value) || value < 0 ||
    !Number.isSafeInteger(Math.round(value * 100)) ||
    Math.abs(value * 100 - Math.round(value * 100)) > 0.000001)
    throw Error("INVALID_SOURCE_MONEY");
  return Math.round(value * 100);
}

function taipeiDay(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw Error("INVALID_SOURCE_TIMESTAMP");
  return new Date(parsed + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function firestoreValue(value) {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(firestoreValue);
  if ("mapValue" in value) return Object.fromEntries(Object.entries(
    value.mapValue.fields ?? {}).map(([key, item]) => [key, firestoreValue(item)]));
  throw Error("UNKNOWN_FIRESTORE_VALUE");
}

function firestoreDocument(doc) {
  return Object.fromEntries(Object.entries(doc?.fields ?? {})
    .map(([key, value]) => [key, firestoreValue(value)]));
}

/**
 * Audit current source claims without creating target cash events. Returned raw
 * claims and identifiers are private. Only the CLI's aggregate report may log.
 */
export function auditSweetfunFinanceSources(osRaw, lineRaw, sheetMap, lineProjection) {
  if (osRaw?.schema !== 1 || lineRaw?.schema !== 1 ||
    !Array.isArray(osRaw.records) || !Array.isArray(sheetMap?.rows) ||
    typeof sheetMap.sourceId !== "string" || !sheetMap.sourceId ||
    typeof sheetMap.sheetSourceId !== "string" || !sheetMap.sheetSourceId ||
    typeof lineProjection?.entryId !== "string")
    throw Error("INVALID_LIVE_FINANCE_EVIDENCE");
  const osRecords = new Map();
  for (const record of osRaw.records) {
    if (typeof record?.key !== "string" || typeof record?.raw !== "string" ||
      osRecords.has(record.key)) throw Error("INVALID_OS_RAW_RECORD");
    osRecords.set(record.key, JSON.parse(record.raw));
  }
  const financeRecords = [...osRecords].filter(([key]) =>
    /^sweetfun-os:finance:v1:sweetfun:20\d\d$/.test(key));
  const ledgerRecords = [...osRecords].filter(([key]) =>
    /^sweetfun-os:payments:v1:sweetfun:[a-f0-9]{64}$/.test(key));
  const missionRecords = [...osRecords].filter(([key]) =>
    /^sweetfun-os:payments:v1:sweetfun:[a-f0-9]{64}:mission:[0-9a-f-]{36}$/.test(key));
  if (!financeRecords.length || osRecords.size !== financeRecords.length +
    ledgerRecords.length + missionRecords.length) throw Error("OS_KEY_INVENTORY_INCOMPLETE");
  const rawSourceDigest = createHash("sha256");
  for (const record of [...osRaw.records].sort((a, b) => a.key.localeCompare(b.key)))
    rawSourceDigest.update(record.key).update("\0").update(record.raw).update("\0");

  const orderIds = new Set();
  const osOrderByParent = new Map();
  const noteByOrder = new Map();
  const sheetMarkers = [];
  const sourceIds = new Set();
  for (const row of sheetMap.rows) {
    if (!row?.sourceJ || sourceIds.has(row.sourceJ))
      throw Error("SHEET_SOURCE_ID_MISSING_OR_DUPLICATE");
    sourceIds.add(row.sourceJ);
    const orderId = legacySweetfunIds(sheetMap.sourceId, row.sourceJ,
      row.parentL ?? "").orderId;
    orderIds.add(orderId);
    if (row.parentL) {
      const previous = osOrderByParent.get(row.parentL);
      if (previous && previous !== orderId) throw Error("SHEET_PARENT_ORDER_DRIFT");
      osOrderByParent.set(row.parentL, orderId);
    }
    if (row.noteH) noteByOrder.set(orderId,
      [...(noteByOrder.get(orderId) ?? []), row.noteH]);
    sheetMarkers.push({ sourceId: row.sourceJ, marker: row.markerH ?? "" });
  }

  const osEntries = financeRecords.flatMap(([, raw]) => raw.entries ?? [])
    .map((entry) => ({ id: entry.id, source: entry.source, kind: entry.kind,
      status: entry.status, amountCents: entry.amount_cents, date: entry.date,
      category: entry.category,
      allocations: entry.allocations?.map((allocation) => ({
        orderId: allocation.order_id, amountCents: allocation.amount_cents })) }));
  const receiptRows = [];
  let sourceReceiptCount = 0;
  for (const [key, ledger] of ledgerRecords) {
    if (!Number.isSafeInteger(ledger.version) || !Array.isArray(ledger.receipts))
      throw Error("INVALID_OS_LEDGER");
    for (const receipt of ledger.receipts) {
      sourceReceiptCount++;
      const orderId = receipt.audit?.after?.order_id;
      if (!orderIds.has(orderId)) throw Error("OS_RECEIPT_ORDER_NOT_IN_SHEET");
      if (ledgerKey(orderId) !== key) throw Error("OS_RECEIPT_LEDGER_KEY_MISMATCH");
      if (receipt.audit?.target_id !== receipt.id ||
        receipt.audit?.request_id !== receipt.request_id)
        throw Error("OS_RECEIPT_AUDIT_MISMATCH");
      receiptRows.push({ id: receipt.id, orderId,
        amountCents: centsFromTwd(receipt.amount), date: taipeiDay(receipt.received_at),
        statusOnly: receipt.status_only === true, requestId: receipt.request_id,
        sourceKey: key });
    }
  }
  if (sourceReceiptCount !== receiptRows.length) throw Error("OS_RECEIPT_COVERAGE_MISMATCH");
  const receiptIds = new Set(receiptRows.map((receipt) => receipt.id));
  if (receiptIds.size !== receiptRows.length || missionRecords.length !== receiptRows.length)
    throw Error("OS_MISSION_RECEIPT_COVERAGE_MISMATCH");
  const missionReceiptIds = new Set();
  for (const [key, mission] of missionRecords) {
    const [sourceKey, missionId] = key.split(":mission:");
    const ledger = osRecords.get(sourceKey);
    if (!ledger || mission.id !== missionId || mission.status !== "completed" ||
      !receiptIds.has(mission.receipt_id) ||
      !ledger.receipts.some((receipt) => receipt.id === mission.receipt_id) ||
      missionReceiptIds.has(mission.receipt_id))
      throw Error("OS_MISSION_RECEIPT_COVERAGE_MISMATCH");
    missionReceiptIds.add(mission.receipt_id);
  }
  const statusNotes = receiptRows.filter((receipt) => receipt.statusOnly)
    .map((receipt) => ({ found: (noteByOrder.get(receipt.orderId) ?? [])
      .some((note) => note.includes(receipt.requestId)) }));
  const calendarReceipts = receiptRows.filter((receipt) => !receipt.statusOnly);
  osEntries.push(...calendarReceipts.map((receipt) => ({
    id: `payment:${receipt.id}`, source: "calendar", kind: "income",
    status: "active", amountCents: receipt.amountCents,
    date: receipt.date, category: "lodging" })));

  const lineCollections = lineRaw.collections ?? {};
  const one = (name) => {
    const docs = lineCollections[name];
    if (!Array.isArray(docs) || docs.length !== 1) throw Error("LINE_CHAIN_INCOMPLETE");
    return firestoreDocument(docs[0]);
  };
  const line = one("entries"), version = one("versions"),
    operation = one("operations"), event = one("events"),
    audit = one("audit"), outbox = one("outbox"),
    receipt = one("projection_receipts");
  const lineOsOrderId = osOrderByParent.get(line.order_id);
  if (!lineOsOrderId || !orderIds.has(lineOsOrderId))
    throw Error("LINE_SOURCE_ORDER_NOT_IN_SHEET");
  const operationId = operation.confirmation?.id;
  if (line.entry_id !== version.entry_id || line.version !== version.version ||
    line.amount !== version.amount || line.status !== version.status ||
    operation.status !== "recorded" || operation.result?.status !== "recorded" ||
    !isDeepStrictEqual(operation.result?.entry, line) ||
    operation.result?.projection_sequence !== outbox.sequence ||
    !operationId || event.operation_id !== operationId ||
    audit.operation_id !== operationId || outbox.operation_id !== operationId ||
    audit.sequence !== outbox.sequence ||
    line.entry_id !== outbox.entry?.entry_id ||
    line.entry_id !== audit.after?.entry_id ||
    outbox.digest !== receipt.digest || outbox.sequence !== receipt.sequence ||
    line.entry_id !== lineProjection.entryId ||
    line.version !== lineProjection.version || line.kind !== lineProjection.kind ||
    line.status !== lineProjection.status || line.amount * 100 !== lineProjection.amountCents ||
    line.order_id !== lineProjection.orderId)
    throw Error("LINE_SOURCE_PROJECTION_MISMATCH");
  const normalized = {
    osEntries,
    osReceipts: receiptRows.map(({ sourceKey, requestId, ...item }) => item),
    lineEntries: [{ entryId: line.entry_id, orderId: lineOsOrderId,
      sourceOrderId: line.order_id,
      kind: line.kind, status: line.status, version: line.version,
      amountCents: line.amount * 100, date: line.paid_on }],
    lineDetailProjections: [lineProjection], sheetMarkers,
  };
  const candidate = prepareSweetfunFinanceClaims(normalized);
  if (!verifySweetfunFinanceClaims(normalized, candidate).matches)
    throw Error("FINANCE_CLAIM_REVERSE_MISMATCH");
  const allocationOrders = osEntries.filter((item) => item.source === "manual" &&
    item.kind === "income").flatMap((item) => item.allocations ?? [])
    .map((item) => item.orderId);
  const orphanManualAllocations = allocationOrders.filter((id) => !orderIds.has(id)).length;
  const missingStatusNotes = statusNotes.filter((item) => !item.found).length;
  const issueCodes = [...candidate.issues.map((issue) => issue.code),
    ...(orphanManualAllocations ? ["MANUAL_ALLOCATION_ORDER_NOT_IN_SHEET"] : []),
    ...(missingStatusNotes ? ["OS_STATUS_NOTE_MISSING"] : [])].sort();
  return { candidate, normalized, report: {
    sourceSheetRows: sheetMap.rows.length,
    osFinanceKeys: financeRecords.length, osLedgerKeys: ledgerRecords.length,
    osMissionKeys: missionRecords.length,
    osRawDigest: rawSourceDigest.digest("hex"),
    osFinanceOperations: financeRecords.reduce((n, [, raw]) =>
      n + (raw.operations?.length ?? 0), 0),
    osManualEntries: osEntries.filter((e) =>
      e.source === "manual").length, osReceipts: receiptRows.length,
    statusOnlyReceipts: statusNotes.length,
    statusOnlyNotesMatched: statusNotes.filter((item) => item.found).length,
    nonStatusReceipts: calendarReceipts.length,
    manualAllocationOrders: allocationOrders.length,
    orphanManualAllocations,
    lineEntries: 1, lineChainMatched: true, lineSourceOrderLinked: true,
    sourceHash: candidate.sourceHash,
    manualIncomeCents: candidate.summary.osManualIncomeCents,
    manualExpenseCents: candidate.summary.osManualExpenseCents,
    calendarReceiptCents: candidate.summary.osCalendarReceiptCents,
    lineIncomeCents: candidate.summary.lineIncomeCents,
    issueCodes,
    paymentEventsCreated: 0, canCutover: false,
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] !== "--restricted-live-evidence" || process.argv.length !== 7)
      throw Error("EXPLICIT_PRIVATE_EVIDENCE_REQUIRED");
    const result = auditSweetfunFinanceSources(...process.argv.slice(3).map(privateJson));
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
  } catch (error) {
    const allowed = new Set(["INVALID_LIVE_FINANCE_EVIDENCE",
      "OS_KEY_INVENTORY_INCOMPLETE", "SHEET_SOURCE_ID_MISSING_OR_DUPLICATE",
      "OS_RECEIPT_ORDER_NOT_IN_SHEET", "OS_RECEIPT_LEDGER_KEY_MISMATCH",
      "OS_RECEIPT_AUDIT_MISMATCH", "LINE_SOURCE_PROJECTION_MISMATCH",
      "LINE_SOURCE_ORDER_NOT_IN_SHEET", "SHEET_PARENT_ORDER_DRIFT",
      "LINE_CHAIN_INCOMPLETE", "FINANCE_CLAIM_REVERSE_MISMATCH"]);
    process.stderr.write(`Finance source audit failed: ${allowed.has(error?.message) ?
      error.message : "REDACTED_ERROR"}\n`);
    process.exitCode = 1;
  }
}
