import { NextRequest, NextResponse } from "next/server";

import { activeSources } from "@/lib/booking-sources/config";
import { planBatchReview } from "@/lib/booking-sources/batch-review";
import { readOperationalSheet } from "@/lib/sheet-monitor/google";
import { allFinanceEntries } from "@/lib/finance-store";
import { ledgerKey } from "@/lib/os-payments";
import { principalFor } from "@/lib/workspace-auth/session";
import { allowedProperty } from "@/lib/workspace-auth/projection";
import { inputBody, privateHeaders, sameOrigin } from "@/lib/workspace-auth/http";
import { RedisWorkspaceStore, redisCommand } from "@/lib/workspace-auth/store";

const enabled = () => process.env.CALENDAR_SOURCE === "sheet_snapshot" && process.env.CALENDAR_BATCH_REVIEW_ENABLED === "true";

async function financialLinks(property: string, orders: string[]): Promise<string[]> {
  const keys = orders.map(order => ledgerKey(property, order));
  const raw = keys.length ? await redisCommand(["MGET", ...keys]) as (string | null)[] : [];
  if (!Array.isArray(raw) || raw.length !== orders.length) throw Error("FINANCE_CHECK_UNAVAILABLE");
  const linked = new Set<string>();
  raw.forEach((value, index) => {
    if (value === null) return;
    if (typeof value !== "string") throw Error("FINANCE_CHECK_UNAVAILABLE");
    const ledger = JSON.parse(value) as { receipts?: unknown[] };
    if (!Array.isArray(ledger.receipts)) throw Error("FINANCE_CHECK_UNAVAILABLE");
    if (ledger.receipts.length) linked.add(orders[index]);
  });
  const entries = await allFinanceEntries(property);
  for (const entry of entries) {
    for (const order of orders) {
      if (entry.order_id === order || entry.order_key === ledgerKey(property, order) ||
          entry.allocations?.some(allocation => allocation.order_id === order)) linked.add(order);
    }
  }
  return [...linked];
}

const failures: Record<string, [number, string]> = {
  UNAUTHORIZED: [401, "請先登入。"], FORBIDDEN: [403, "只有可管理此旅宿訂單的擁有者或管理員可以檢視。"],
  FEATURE_DISABLED: [503, "批次核對尚未啟用。"], INVALID_INPUT: [400, "請重新選取房晚並預覽。"],
  UNSUPPORTED_ACTION: [405, "這個來源不支援安全的自動刪除；請在主表手動處理。"],
  NOT_FOUND: [404, "找不到這間旅宿的訂房表。"], SOURCE_CHANGED: [409, "主表資料已變動，請重新載入並預覽。"],
  SOURCE_CONFLICT: [409, "同筆來源訂單還有待核對的房晚；請先修正主表衝突。"],
  FINANCE_CHECK_UNAVAILABLE: [503, "暫時無法核對收款與財務紀錄，請稍後再試。"],
};

function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const [status, detail] = failures[code] ?? [503, "目前無法安全核對主表，請稍後再試。"];
  return NextResponse.json({ code: failures[code] ? code : "UNAVAILABLE", detail }, { status, headers: privateHeaders });
}

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    const input = await inputBody(request);
    if (input.action !== "preview") throw Error("UNSUPPORTED_ACTION");
    if (!enabled()) throw Error("FEATURE_DISABLED");
    const actor = await principalFor(request);
    if (!actor) throw Error("UNAUTHORIZED");
    if (!["owner", "god", "admin"].includes(actor.role) || typeof input.property_id !== "string" || !allowedProperty(actor, input.property_id)) throw Error("FORBIDDEN");
    const source = activeSources().find(item => item.property.id === input.property_id);
    if (!source) throw Error("NOT_FOUND");
    const ids = input.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => typeof id !== "string")) throw Error("INVALID_INPUT");
    await new RedisWorkspaceStore().limit(`calendar-batch-review:${actor.id}`, 30, 3600);

    const plan = planBatchReview(await readOperationalSheet(source), source, ids);
    const linked = await financialLinks(source.property.id, plan.selectedOrderIds);
    return NextResponse.json({ ...plan.preview, financialBlockCount: linked.length, manualActionRequired: true }, { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}
