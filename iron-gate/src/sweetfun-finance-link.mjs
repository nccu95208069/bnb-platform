import { isDeepStrictEqual } from "node:util";
import { legacySweetfunIds } from "./sweetfun-sheet-candidate.mjs";
import { auditSweetfunFinanceSources } from "./sweetfun-finance-source-audit.mjs";

const osSourceId = "sweetfun-operations-sheet-v1";
const bookingUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sheetRow(row) {
  return { sourceJ: row?.values?.[9] ?? "", parentL: row?.values?.[11] ?? "",
    markerH: row?.values?.[7] ?? "", noteH: row?.notes?.[7] ?? "" };
}

/**
 * Restricted-memory link plan. Every source claim stays an unverified ledger
 * claim; nothing here becomes an Iron Gate payment event or saleable booking.
 * Returned source IDs and booking IDs are private and must never be logged.
 */
export function planSweetfunFinanceLinks(rawSources, shadow, manifest) {
  if (!Array.isArray(rawSources) || rawSources.length !== 4 ||
    manifest?.propertyId !== shadow?.propertyId || shadow?.readOnly !== true ||
    shadow?.authorityEpoch !== 0 || shadow?.channel?.ready !== false ||
    shadow?.channel?.websiteSalesEnabled !== false ||
    shadow?.sweetfunImport?.sourceId !== rawSources[2]?.sheetSourceId ||
    shadow?.sweetfunImport?.sourceHash !== manifest?.sheetSourceHash ||
    shadow?.sweetfunImport?.capturedAt !== manifest?.sourceCopyCreatedAt ||
    rawSources[2]?.sourceId !== osSourceId ||
    !Array.isArray(shadow.bookings) ||
    shadow.bookings.some((booking) => !Array.isArray(booking.paymentEvents) ||
      booking.paymentEvents.length)) throw Error("FINANCE_LINK_SHADOW_MISMATCH");
  const audit = auditSweetfunFinanceSources(...rawSources);
  if (audit.report.issueCodes.length ||
    audit.report.sourceHash !== manifest.normalizedSourceHash)
    throw Error("FINANCE_LINK_SOURCE_AUDIT_MISMATCH");

  const byJ = new Map(), shadowRows = new Map();
  for (const booking of shadow.bookings) {
    if (!bookingUuid.test(booking?.id ?? "") ||
      !Array.isArray(booking?.sweetfunSnapshot?.rows))
      throw Error("FINANCE_LINK_BOOKING_INVALID");
    for (const rawRow of booking.sweetfunSnapshot.rows) {
      const row = sheetRow(rawRow);
      if (!row.sourceJ || shadowRows.has(row.sourceJ))
        throw Error("FINANCE_LINK_SHADOW_ROW_DUPLICATE");
      shadowRows.set(row.sourceJ, row);
      byJ.set(row.sourceJ, booking.id);
    }
  }
  for (const group of shadow.sweetfunImport.quarantined ?? []) {
    for (const rawRow of group.rows ?? []) {
      const row = sheetRow(rawRow);
      if (!row.sourceJ || shadowRows.has(row.sourceJ))
        throw Error("FINANCE_LINK_SHADOW_ROW_DUPLICATE");
      shadowRows.set(row.sourceJ, row);
    }
  }
  if (shadowRows.size !== rawSources[2].rows.length)
    throw Error("FINANCE_LINK_SHADOW_ROW_MISMATCH");
  const aliases = new Map(), seenJ = new Set();
  for (const row of rawSources[2].rows) {
    if (!row?.sourceJ || seenJ.has(row.sourceJ) ||
      !isDeepStrictEqual(shadowRows.get(row.sourceJ), row))
      throw Error("FINANCE_LINK_SHADOW_ROW_MISMATCH");
    seenJ.add(row.sourceJ);
    const alias = legacySweetfunIds(osSourceId, row.sourceJ,
      row.parentL ?? "").orderId;
    const owners = aliases.get(alias) ?? { bookings: new Set(), quarantined: false };
    if (byJ.has(row.sourceJ)) owners.bookings.add(byJ.get(row.sourceJ));
    else owners.quarantined = true;
    aliases.set(alias, owners);
  }
  const bindings = [], unresolved = [];
  const add = (source, sourceId, orderId, amountCents, role, status) => {
    const owners = aliases.get(orderId);
    if (!owners || owners.quarantined || owners.bookings.size !== 1) {
      unresolved.push({ source, sourceId, orderId,
        reason: owners?.quarantined ? "QUARANTINED_SOURCE_ROW" :
          owners?.bookings.size > 1 ? "MULTIPLE_SHADOW_BOOKINGS" : "ORDER_NOT_FOUND" });
      return;
    }
    bindings.push({ source, sourceId, orderId,
      bookingId: [...owners.bookings][0], amountCents, role, status,
      externalSettlement: "unverified" });
  };
  const propertyClaims = [];
  for (const entry of audit.normalized.osEntries) {
    if (entry.source === "calendar") continue; // Receipt is the source; this is its projection.
    if (Array.isArray(entry.allocations) && entry.allocations.length) {
      for (const allocation of entry.allocations)
        add("os_manual", entry.id, allocation.orderId,
          allocation.amountCents, "allocation", entry.status);
    } else if (entry.orderId) {
      add("os_manual", entry.id, entry.orderId,
        entry.amountCents, entry.kind, entry.status);
    } else {
      propertyClaims.push({ source: "os_manual", sourceId: entry.id,
        amountCents: entry.amountCents, kind: entry.kind, status: entry.status,
        externalSettlement: "unverified" });
    }
  }
  for (const receipt of audit.normalized.osReceipts)
    add("os_receipt", receipt.id, receipt.orderId, receipt.amountCents,
      receipt.statusOnly ? "status_only" : "receipt", "recorded");
  for (const entry of audit.normalized.lineEntries)
    add("line_entry", entry.entryId, entry.orderId, entry.amountCents,
      entry.kind, entry.status);
  const report = { shadowVersion: shadow.version,
    sheetRows: shadowRows.size, acceptedRows: byJ.size,
    quarantinedRows: shadowRows.size - byJ.size,
    bookingCount: shadow.bookings.length, linkedClaims: bindings.length,
    propertyClaims: propertyClaims.length, unresolvedClaims: unresolved.length,
    normalizedSourceHash: audit.report.sourceHash,
    paymentEventsCreated: 0, canCutover: false };
  return { bindings, propertyClaims, unresolved, report };
}
