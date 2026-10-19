import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { activeSources } from "@/lib/booking-sources/config";
import { planBatchCancel } from "@/lib/booking-sources/batch-cancel";
import { commitBatchCancel, deleteSheetRows } from "@/lib/booking-sources/batch-cancel-service";
import { readOperationalSheet } from "@/lib/sheet-monitor/google";
import { allFinanceEntries } from "@/lib/finance-store";
import { ledgerKey } from "@/lib/os-payments";
import { principalFor } from "@/lib/workspace-auth/session";
import { allowedProperty } from "@/lib/workspace-auth/projection";
import { inputBody, privateHeaders, sameOrigin } from "@/lib/workspace-auth/http";
import { RedisWorkspaceStore, redisCommand } from "@/lib/workspace-auth/store";

const readFullSource = (source: ReturnType<typeof activeSources>[number]) => readOperationalSheet(source, undefined, true);

type Journal = { state: "pending" | "verified"; actor: string; digest: string; ids: string[]; at: string; roomNightCount?: number; distinctOrderCount?: number };
const enabled = () => process.env.CALENDAR_SOURCE === "sheet_snapshot" && process.env.CALENDAR_BATCH_CANCEL_ENABLED === "true";
const journalKey = (property: string, requestId: string) => `sweetfun-os:calendar-batch-cancel:v1:${property}:${requestId}`;
const lockKey = (property: string) => `sweetfun-os:payments:v1:${property}:lock`;

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
  UNAUTHORIZED: [401, "請先登入。"], FORBIDDEN: [403, "只有可管理此旅宿訂單的擁有者或管理員可以刪除。"],
  FEATURE_DISABLED: [503, "批次刪除尚未啟用。"], INVALID_INPUT: [400, "請重新選取房晚並預覽。"],
  NOT_FOUND: [404, "找不到這間旅宿的訂房表。"], SOURCE_CHANGED: [409, "主表資料已變動，請重新載入並預覽。"],
  SOURCE_CONFLICT: [409, "同筆來源訂單還有待核對的房晚；請先修正主表衝突。"],
  PARTIAL_ORDER: [409, "選取只涵蓋部分訂單日期；請加入整筆訂單或取消。"],
  FINANCIAL_LINKS: [409, "部分訂單已有 OS 收款或財務紀錄，請先走取消與對帳流程。"],
  FINANCE_CHECK_UNAVAILABLE: [503, "暫時無法核對收款與財務紀錄，未刪除任何訂單。"],
  PAID_ACK_REQUIRED: [400, "請先確認已付標記；刪除不會自動退款。"],
  VERSION_CONFLICT: [409, "另一項主表操作正在進行，請稍後重新預覽。"],
  IDEMPOTENCY_CONFLICT: [409, "這次確認編號已用於其他範圍，請重新預覽。"],
  WRITE_UNCONFIRMED: [503, "主表刪除結果暫時無法確認；請先重新載入核對，勿重複送出。"],
  SHEET_WRITE_PERMISSION: [503, "主表寫入權限不足，沒有確認刪除。"],
  SHEET_WRITE_UNAVAILABLE: [503, "主表暫時無法寫入，沒有確認刪除。"],
};

function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const [status, detail] = failures[code] ?? [503, "目前無法安全核對主表，未執行新的刪除。"];
  return NextResponse.json({ code: failures[code] ? code : "UNAVAILABLE", detail }, { status, headers: privateHeaders });
}

export async function POST(request: NextRequest) {
  let lease: { key: string; token: string } | null = null;
  try {
    sameOrigin(request);
    if (!enabled()) throw Error("FEATURE_DISABLED");
    const input = await inputBody(request);
    const actor = await principalFor(request);
    if (!actor) throw Error("UNAUTHORIZED");
    if (!["owner", "god", "admin"].includes(actor.role) || typeof input.property_id !== "string" || !allowedProperty(actor, input.property_id)) throw Error("FORBIDDEN");
    const source = activeSources().find(item => item.property.id === input.property_id);
    if (!source) throw Error("NOT_FOUND");
    if (input.action !== "preview" && input.action !== "confirm") throw Error("INVALID_INPUT");
    const ids = input.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => typeof id !== "string")) throw Error("INVALID_INPUT");
    await new RedisWorkspaceStore().limit(`calendar-batch-cancel:${actor.id}`, 30, 3600);

    if (input.action === "preview") {
      const plan = planBatchCancel(await readFullSource(source), source, ids);
      const linked = await financialLinks(source.property.id, plan.selectedOrderIds);
      return NextResponse.json({ ...plan.preview, financialBlockCount: linked.length, canConfirm: plan.preview.canConfirm && linked.length === 0 }, { headers: privateHeaders });
    }

    if (typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest) ||
        typeof input.request_id !== "string" || !/^[a-f0-9-]{36}$/.test(input.request_id) ||
        typeof input.acknowledge_paid !== "boolean") throw Error("INVALID_INPUT");
    const key = journalKey(source.property.id, input.request_id);
    const prior = await redisCommand(["GET", key]);
    if (prior) {
      const journal = JSON.parse(String(prior)) as Journal;
      if (journal.actor !== actor.id || journal.digest !== input.digest || JSON.stringify(journal.ids) !== JSON.stringify(ids)) throw Error("IDEMPOTENCY_CONFLICT");
      if (journal.state !== "verified") throw Error("WRITE_UNCONFIRMED");
      return NextResponse.json({ verified: true, roomNightCount: journal.roomNightCount, distinctOrderCount: journal.distinctOrderCount, deletedIds: ids }, { headers: privateHeaders });
    }

    const token = randomUUID(), lock = lockKey(source.property.id);
    if (await redisCommand(["SET", lock, token, "NX", "EX", 120]) !== "OK") throw Error("VERSION_CONFLICT");
    lease = { key: lock, token };
    const plan = await commitBatchCancel(source, ids, input.digest, input.acknowledge_paid, {
      read: readFullSource,
      remove: deleteSheetRows,
      assertNoFinancialLinks: async (property, orders) => {
        if ((await financialLinks(property, orders)).length) throw Error("FINANCIAL_LINKS");
      },
      beforeWrite: async () => {
        if (await redisCommand(["GET", lock]) !== token || Number(await redisCommand(["PTTL", lock])) < 30_000)
          throw Error("VERSION_CONFLICT");
        const journal: Journal = { state: "pending", actor: actor.id, digest: input.digest, ids, at: new Date().toISOString() };
        if (await redisCommand(["SET", key, JSON.stringify(journal), "NX", "EX", 30 * 86400]) !== "OK") throw Error("IDEMPOTENCY_CONFLICT");
      },
    });
    const verified: Journal = { state: "verified", actor: actor.id, digest: input.digest, ids,
      at: new Date().toISOString(), roomNightCount: plan.preview.roomNightCount, distinctOrderCount: plan.preview.distinctOrderCount };
    if (await redisCommand(["SET", key, JSON.stringify(verified), "EX", 30 * 86400]) !== "OK")
      throw Error("WRITE_UNCONFIRMED");
    return NextResponse.json({ verified: true, roomNightCount: plan.preview.roomNightCount,
      distinctOrderCount: plan.preview.distinctOrderCount, deletedIds: ids }, { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  } finally {
    if (lease) await redisCommand(["EVAL", "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, lease.key, lease.token]).catch(() => {});
  }
}
