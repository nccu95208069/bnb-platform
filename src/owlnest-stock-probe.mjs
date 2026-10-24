import { randomUUID } from "node:crypto";
import { owlNestDayNumber } from "./owlnest-web-readback.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A one-cell, owner-attested transport test. The caller must independently
 * establish that the night is safe to change. No write is retried: after each
 * PUT, even one with an unknown outcome, only fresh GETs determine next steps.
 */
export async function runControlledOwlNestStockProbe({ propertyId, roomId, date,
  provider, checkSafeCell, attempts = 3, wait = async () => {} }) {
  if (!UUID.test(propertyId) || !UUID.test(roomId) ||
    typeof provider?.observe !== "function" ||
    typeof provider?.setNight !== "function" ||
    typeof checkSafeCell !== "function" ||
    !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5 ||
    typeof wait !== "function") throw Error("OWLNEST_PROBE_INVALID");
  owlNestDayNumber(date);
  const request = [{ roomId, date }];
  const oneCell = async () => {
    const result = await provider.observe(propertyId, request);
    if (!result || !Array.isArray(result.cells) || result.cells.length !== 1 ||
      result.cells[0]?.roomId !== roomId || result.cells[0]?.date !== date ||
      !Number.isSafeInteger(result.cells[0].count) ||
      result.cells[0].count < 0 || result.cells[0].count > 100 ||
      typeof result.cells[0].isLock !== "boolean")
      throw Error("OWLNEST_PROBE_INCOMPLETE_READBACK");
    return result.cells[0];
  };
  const isOpen = (cell) => cell.count === 1 && cell.isLock === false;
  const isClosed = (cell) => cell.count === 0 && cell.isLock === true;
  const readUntil = async (expected) => {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      try {
        last = await oneCell();
        if (expected(last)) return { matched: true, cell: last };
      } catch { /* Report unresolved; never infer a PUT result from its ack. */ }
      if (i + 1 < attempts) {
        try { await wait(); } catch { /* Readback still determines the outcome. */ }
      }
    }
    return { matched: false, cell: last };
  };

  await checkSafeCell({ propertyId, roomId, date, phase: "preflight" });
  if (!isOpen(await oneCell()) || !isOpen(await oneCell()))
    return { status: "baseline_changed", restored: false };
  await checkSafeCell({ propertyId, roomId, date, phase: "before_close" });

  let closeAcknowledged = false;
  try {
    const result = await provider.setNight(propertyId, { roomId, date,
      desired: "closed", operationKey: randomUUID() });
    closeAcknowledged = result?.acknowledged === true;
  } catch { /* A failed request may still have changed provider state. */ }
  const closed = await readUntil(isClosed);
  if (!closed.matched) return { status: "close_unverified",
    restored: false, closeAcknowledged, observed: closed.cell };

  try {
    await checkSafeCell({ propertyId, roomId, date, phase: "before_restore" });
  } catch {
    return { status: "restore_blocked", restored: false,
      closeAcknowledged, observed: closed.cell };
  }
  let restoreAcknowledged = false;
  try {
    const result = await provider.setNight(propertyId, { roomId, date,
      desired: "open", operationKey: randomUUID() });
    restoreAcknowledged = result?.acknowledged === true;
  } catch { /* Observe; do not retry the PUT. */ }
  const reopened = await readUntil(isOpen);
  if (!reopened.matched) return { status: "restore_unverified", restored: false,
    closeAcknowledged, restoreAcknowledged, observed: reopened.cell };
  return { status: closeAcknowledged && restoreAcknowledged ? "verified" :
    "verified_with_unknown_ack", restored: true, closeAcknowledged,
    restoreAcknowledged, observed: reopened.cell };
}
