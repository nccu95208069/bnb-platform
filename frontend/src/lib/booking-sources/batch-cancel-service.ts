import type { SheetSourceDefinition } from "./config";
import { accessToken } from "../sheet-monitor/google.ts";
import {
  deleteDimensionRequests, planBatchCancel, verifiedAfterDelete,
  type BatchCancelPlan,
} from "./batch-cancel.ts";

export type BatchCancelDependencies = {
  read: (source: SheetSourceDefinition) => Promise<unknown[][]>;
  remove: (source: SheetSourceDefinition, rows: number[]) => Promise<void>;
  assertNoFinancialLinks: (property: string, orders: string[]) => Promise<void>;
  beforeWrite?: (plan: BatchCancelPlan) => Promise<void>;
};

export async function deleteSheetRows(source: SheetSourceDefinition, rows: number[]) {
  const requests = deleteDimensionRequests(source, rows);
  if (!requests.length || requests.length > 100) throw Error("INVALID_INPUT");
  const token = await accessToken(source, true);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${source.spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }), cache: "no-store", signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? "SHEET_WRITE_PERMISSION" : "SHEET_WRITE_UNAVAILABLE");
  const result = await response.json();
  if (!Array.isArray(result.replies) || result.replies.length !== requests.length) throw Error("WRITE_UNCONFIRMED");
}

// Retrying a stale preview is never a second deletion. The caller owns an
// exclusive property lease and a request journal before invoking this function.
export async function commitBatchCancel(
  source: SheetSourceDefinition, ids: string[], digest: string,
  acknowledgePaid: boolean, deps: BatchCancelDependencies,
): Promise<BatchCancelPlan> {
  const observed = await deps.read(source);
  const first = planBatchCancel(observed, source, ids);
  if (first.preview.digest !== digest) throw Error("SOURCE_CHANGED");
  if (!first.preview.canConfirm) throw Error("PARTIAL_ORDER");
  if (first.preview.paidRoomNightCount > 0 && !acknowledgePaid) throw Error("PAID_ACK_REQUIRED");
  await deps.assertNoFinancialLinks(source.property.id, first.selectedOrderIds);
  // External Sheet editors do not honor the OS lease. Repeat the complete
  // identity/content check after finance I/O and immediately before deletion.
  const before = await deps.read(source);
  const plan = planBatchCancel(before, source, ids);
  if (plan.preview.digest !== digest) throw Error("SOURCE_CHANGED");
  if (!plan.preview.canConfirm) throw Error("PARTIAL_ORDER");
  await deps.beforeWrite?.(plan);
  await deps.remove(source, plan.selectedRows);
  const after = await deps.read(source);
  if (!verifiedAfterDelete(before, after, plan.selectedRows)) throw Error("WRITE_UNCONFIRMED");
  return plan;
}
