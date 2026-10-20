import { createHash } from "node:crypto";

function sha(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function id(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function cents(value, positive = false) {
  return Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
}

function day(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function amount(items) {
  return items.reduce((total, item) => total + BigInt(item.amountCents), 0n).toString();
}

function unverifiedClaims(items) {
  return items.map((item) => ({ ...structuredClone(item),
    externalSettlement: "unverified" }));
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    if (!id(item?.[key]) || seen.has(item[key])) throw Error(`INVALID_${label}_ID`);
    seen.add(item[key]);
  }
}

/**
 * Restricted-memory finance evidence inventory. Inputs are explicitly normalized
 * to TWD cents before this function; no Sheet flag or projection creates cash.
 * Returned identifiers and source objects are private and must not be logged.
 */
export function prepareSweetfunFinanceClaims(snapshot) {
  const input = snapshot ?? {};
  if (![input.osEntries, input.osReceipts, input.lineEntries,
    input.lineDetailProjections, input.sheetMarkers]
    .every(Array.isArray)) throw Error("INVALID_FINANCE_SNAPSHOT");
  const { osEntries, osReceipts, lineEntries, lineDetailProjections, sheetMarkers } =
    structuredClone(input);
  unique(osEntries, "id", "OS_ENTRY");
  unique(osReceipts, "id", "OS_RECEIPT");
  unique(lineEntries, "entryId", "LINE_ENTRY");
  unique(lineDetailProjections, "entryId", "LINE_PROJECTION");
  unique(sheetMarkers, "sourceId", "SHEET_MARKER");

  const issues = [];
  const osReceiptById = new Map(osReceipts.map((item) => [item.id, item]));
  const projectedReceipts = new Set();
  const manualIncome = [], manualExpense = [], calendarReceipts = [], lineIncome = [], lineExpense = [];

  for (const receipt of osReceipts) {
    if (!id(receipt.orderId) || !cents(receipt.amountCents) ||
      !day(receipt.date) || typeof receipt.statusOnly !== "boolean")
      throw Error("INVALID_OS_RECEIPT");
    if (receipt.statusOnly) {
      if (receipt.amountCents !== 0) throw Error("STATUS_ONLY_HAS_AMOUNT");
    } else if (!cents(receipt.amountCents, true)) throw Error("INVALID_OS_RECEIPT_AMOUNT");
  }

  for (const entry of osEntries) {
    if (!["manual", "calendar"].includes(entry?.source) ||
      !["income", "expense"].includes(entry.kind) ||
      !["active", "void"].includes(entry.status) || !cents(entry.amountCents))
      throw Error("INVALID_OS_FINANCE_ENTRY");
    if (!day(entry.date)) throw Error("INVALID_OS_FINANCE_DATE");
    if (entry.source === "calendar") {
      if (entry.kind !== "income" || !entry.id.startsWith("payment:"))
        throw Error("INVALID_CALENDAR_PROJECTION");
      const receiptId = entry.id.slice("payment:".length);
      const receipt = osReceiptById.get(receiptId);
      if (!receipt || receipt.statusOnly || receipt.amountCents !== entry.amountCents)
        issues.push({ code: "CALENDAR_RECEIPT_UNMATCHED", source: "os", id: entry.id });
      else projectedReceipts.add(receiptId);
      if (entry.status === "void") issues.push({ code: "CALENDAR_PROJECTION_VOID", source: "os", id: entry.id });
      continue;
    }
    if (entry.kind === "income" && Array.isArray(entry.allocations)) {
      if (entry.allocations.some((a) => !id(a?.orderId) || !cents(a.amountCents, true)) ||
        new Set(entry.allocations.map((a) => a.orderId)).size !== entry.allocations.length ||
        entry.allocations.reduce((n, a) => n + BigInt(a.amountCents), 0n) !== BigInt(entry.amountCents))
        issues.push({ code: "MANUAL_ALLOCATION_MISMATCH", source: "os", id: entry.id });
    } else if (entry.kind === "income" && entry.category === "lodging") {
      issues.push({ code: "MANUAL_LODGING_ALLOCATION_MISSING", source: "os", id: entry.id });
    }
    if (entry.status === "active") (entry.kind === "income" ? manualIncome : manualExpense).push(entry);
  }

  for (const receipt of osReceipts) {
    if (receipt.statusOnly) continue;
    if (!projectedReceipts.has(receipt.id))
      issues.push({ code: "OS_RECEIPT_WITHOUT_CALENDAR_PROJECTION", source: "os", id: receipt.id });
    calendarReceipts.push(receipt);
  }

  const lineById = new Map();
  for (const entry of lineEntries) {
    if (!["room", "deposit", "extra", "expense"].includes(entry?.kind) ||
      !["active", "void"].includes(entry.status) || !cents(entry.amountCents, true) ||
      !Number.isSafeInteger(entry.version) || entry.version < 1 ||
      !day(entry.date) ||
      (entry.kind !== "expense" && !id(entry.orderId))) throw Error("INVALID_LINE_ENTRY");
    lineById.set(entry.entryId, entry);
    if (entry.status === "active") (entry.kind === "expense" ? lineExpense : lineIncome).push(entry);
  }
  for (const projection of lineDetailProjections) {
    const entry = lineById.get(projection.entryId);
    if (!entry || projection.version !== entry.version ||
      projection.amountCents !== entry.amountCents || projection.kind !== entry.kind ||
      projection.status !== entry.status)
      issues.push({ code: "LINE_DETAIL_PROJECTION_MISMATCH", source: "line", id: projection.entryId });
  }
  for (const entry of lineEntries) if (!lineDetailProjections.some((p) => p.entryId === entry.entryId))
    issues.push({ code: "LINE_DETAIL_PROJECTION_MISSING", source: "line", id: entry.entryId });

  for (const marker of sheetMarkers) if (typeof marker.marker !== "string")
    throw Error("INVALID_SHEET_MARKER");
  const crossLedger = new Map();
  const parts = [
    ...manualIncome.flatMap((entry) => Array.isArray(entry.allocations) ?
      entry.allocations.map((a) => ({ source: "os_manual", id: entry.id,
        orderId: a.orderId, date: entry.date, amountCents: a.amountCents })) :
      [{ source: "os_manual", id: entry.id, orderId: entry.orderId,
        date: entry.date, amountCents: entry.amountCents }]),
    ...calendarReceipts.map((r) => ({ source: "os_calendar", id: r.id,
      orderId: r.orderId, date: r.date, amountCents: r.amountCents })),
    ...lineIncome.map((e) => ({ source: "line", id: e.entryId,
      orderId: e.orderId, date: e.date, amountCents: e.amountCents })),
  ];
  for (const claim of parts) {
    if (!id(claim.orderId) || !id(claim.date) || !cents(claim.amountCents, true)) continue;
    const key = `${claim.orderId}\0${claim.date}\0${claim.amountCents}`;
    const other = crossLedger.get(key);
    if (other && other.source !== claim.source)
      issues.push({ code: "POSSIBLE_CROSS_LEDGER_DUPLICATE", source: claim.source,
        id: claim.id, otherId: other.id });
    else crossLedger.set(key, { source: claim.source, id: claim.id });
  }

  return {
    sourceHash: sha(snapshot),
    sourceRecords: { osEntries, osReceipts, lineEntries },
    claims: { manualIncome: unverifiedClaims(manualIncome),
      manualExpense: unverifiedClaims(manualExpense),
      calendarReceipts: unverifiedClaims(calendarReceipts),
      lineIncome: unverifiedClaims(lineIncome),
      lineExpense: unverifiedClaims(lineExpense) },
    nonCash: { statusOnlyReceipts: osReceipts.filter((r) => r.statusOnly),
      sheetMarkers: structuredClone(sheetMarkers),
      calendarProjections: osEntries.filter((e) => e.source === "calendar"),
      lineDetailProjections: structuredClone(lineDetailProjections) },
    issues,
    summary: { osManualIncomeCents: amount(manualIncome), osManualExpenseCents: amount(manualExpense),
      osCalendarReceiptCents: amount(calendarReceipts), lineIncomeCents: amount(lineIncome),
      lineExpenseCents: amount(lineExpense), issueCount: issues.length,
      externalSettlement: "unverified",
      paymentEventsCreated: 0, canStage: false, canCutover: false },
  };
}

export function verifySweetfunFinanceClaims(snapshot, prepared) {
  const expected = prepareSweetfunFinanceClaims(snapshot);
  return { sourceUnchanged: prepared?.sourceHash === expected.sourceHash,
    matches: JSON.stringify(prepared) === JSON.stringify(expected), canCutover: false };
}
