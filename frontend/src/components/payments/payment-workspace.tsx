"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  paymentApi,
  money,
  missionOrderId,
  statusLabels,
  toolLabels,
  reasonLabels,
  type Mission,
  type MissionRequest,
  type PaymentInput,
} from "@/lib/payment-workflow";

export function PaymentWorkspace({
  orderId,
  missionId,
  onChange,
  readOnly = false,
}: {
  orderId?: string;
  missionId?: string;
  onChange?: () => void;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [mission, setMission] = useState<Mission | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [amount, setAmount] = useState("2000");
  const [kind, setKind] = useState<PaymentInput["payment_type"]>("deposit");
  const [method, setMethod] =
    useState<PaymentInput["payment_method"]>("bank_transfer");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [queryId, setQueryId] = useState(orderId ?? "");
  const [clarification, setClarification] = useState("");
  const [evidence, setEvidence] = useState("");
  const [newPayment, setNewPayment] = useState(false);
  const lock = useRef(false);
  const retryRequest = useRef<MissionRequest | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const load = useCallback(
    async (force = false) => {
      let id = missionId;
      if (!id && (orderId || retryRequest.current)) {
        const { missions } = await paymentApi<{ missions: Mission[] }>(
          "/missions",
        );
        const matching = missions.filter(
          (m) => m.kind === "record_payment" && (!orderId || missionOrderId(m) === orderId),
        );
        id =
          matching.find(m => m.request.idempotency_key === retryRequest.current?.idempotency_key)?.mission_id ??
          (orderId ? matching.find((m) => !["completed", "canceled"].includes(m.status))
            ?.mission_id ?? matching.at(-1)?.mission_id : undefined);
      }
      if (id) {
        const latest = await paymentApi<Mission>(`/missions/${id}`);
        if (force || !lock.current) {
          // A GET can acknowledge a create whose response was lost. Forget its
          // retry key before the user starts a different payment intention.
          if (
            latest.request.idempotency_key ===
            retryRequest.current?.idempotency_key
          ) {
            retryRequest.current = null;
            sessionStorage.removeItem(
              `payment-pending:${orderId ?? "mission-center"}`,
            );
          }
          setMission(latest);
        }
      }
      setReady(true);
      return id;
    },
    [missionId, orderId],
  );
  useEffect(() => {
    let active = true;
    // Only the unacknowledged create request is cached, never financial results.
    const key = `payment-pending:${orderId ?? "mission-center"}`;
    try {
      retryRequest.current = JSON.parse(sessionStorage.getItem(key) ?? "null");
    } catch {
      /* recover by reading Missions */
    }
    const now = new Date();
    setDate(
      new Date(now.getTime() - now.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16),
    );
    load()
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const timer = setInterval(() => {
      if (!lock.current && active) void load().catch(() => {});
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load, orderId]);

  async function execute(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "連線中斷，請重新整理任務後繼續。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
      onChangeRef.current?.();
    }
  }
  async function show(m: Mission) {
    setMission(await paymentApi<Mission>(`/missions/${m.mission_id}`));
    onChangeRef.current?.();
  }
  async function progress(initial: Mission) {
    let m = initial;
    for (let i = 0; i < 4 && m.status === "queued"; i++) {
      m = await paymentApi<Mission>(`/missions/${m.mission_id}/advance`, {});
      await show(m);
    }
  }
  async function submit() {
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value <= 0 || !queryId.trim() || !date)
      throw new Error("請填入訂單編號、正整數金額與收款時間。");
    const request =
      retryRequest.current ??
      ({
        goal: `為訂單 ${queryId.trim()} 登記${kind === "deposit" ? "訂金" : kind === "balance" ? "尾款" : "款項"} ${money(value)}`,
        query: { order_id: queryId.trim() },
        idempotency_key: crypto.randomUUID(),
        payment: {
          amount: value,
          currency: "TWD",
          payment_type: kind,
          payment_method: method,
          received_at: new Date(date).toISOString(),
          note,
        },
      } satisfies MissionRequest);
    retryRequest.current = request;
    sessionStorage.setItem(
      `payment-pending:${orderId ?? "mission-center"}`,
      JSON.stringify(request),
    );
    const m = await paymentApi<Mission>("/missions", request);
    retryRequest.current = null;
    sessionStorage.removeItem(`payment-pending:${orderId ?? "mission-center"}`);
    setNewPayment(false);
    setMission(m);
    try {
      await progress(m);
    } finally {
      if (!orderId) router.replace(`/missions?mission=${m.mission_id}`);
    }
  }
  const active = mission && !["completed", "canceled"].includes(mission.status);
  const payment = mission?.request.payment;
  return (
    <section className="space-y-4" aria-label="付款與任務">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">付款與任務</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() =>
            void execute(async () => {
              await load(true);
            })
          }
        >
          <RefreshCw className="size-4" />
          更新
        </Button>
      </div>
      {loading && (
        <p className="text-sm text-muted-foreground">正在讀取已保存的任務…</p>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          {error}
          <p className="mt-1">
            連線不確定時，請先更新任務，或以原內容重試；系統會辨識同一筆操作。
          </p>
        </div>
      )}
      {mission && (
        <div className="space-y-3 rounded-xl border p-4" aria-live="polite">
          <Badge
            variant={mission.status === "completed" ? "default" : "secondary"}
          >
            {mission.write_result && mission.status !== "completed"
              ? "付款已保存・待驗證"
              : (statusLabels[mission.status] ?? mission.status)}
          </Badge>
          <p className="text-sm font-medium break-words">{mission.goal}</p>
          {payment && (
            <p className="text-sm text-muted-foreground">
              {money(payment.amount)} ·{" "}
              {
                { bank_transfer: "銀行轉帳", cash: "現金", card: "信用卡" }[
                  payment.payment_method
                ]
              }{" "}
              · {new Date(payment.received_at).toLocaleString("zh-TW")}
            </p>
          )}
          {mission.kind === "record_payment" && (
            <ol className="grid grid-cols-3 gap-2 text-xs">
              {["核對訂單", "保存付款", "驗證結果"].map((label, i) => {
                const done =
                  i === 0
                    ? !!mission.order
                    : i === 1
                      ? !!mission.write_result
                      : mission.status === "completed";
                const Icon = done ? CheckCircle2 : Circle;
                return (
                  <li
                    key={label}
                    className={`flex items-center gap-1 ${done ? "text-primary" : "text-muted-foreground"}`}
                  >
                    <Icon className="size-4 shrink-0" />
                    {label}
                  </li>
                );
              })}
            </ol>
          )}
          {mission.order && (
            <div className="grid grid-cols-2 gap-2 border-t pt-3 text-sm">
              <p className="col-span-2 text-xs text-muted-foreground">
                本次任務查核結果
              </p>
              <span>
                已收{" "}
                {money(
                  typeof mission.write_result?.paid_amount === "number"
                    ? mission.write_result.paid_amount
                    : mission.order.paid_amount,
                )}
              </span>
              <span>
                待收{" "}
                {money(
                  typeof mission.write_result?.balance_due === "number"
                    ? mission.write_result.balance_due
                    : mission.order.balance_due,
                )}
              </span>
            </div>
          )}
          {mission.status === "completed" ? (
            <p className="text-sm text-primary">
              {mission.kind === "record_payment"
                ? "付款明細與訂單餘額已核對一致，日曆已同步更新。"
                : "調查已完成，原付款任務可重新核對後繼續。"}
            </p>
          ) : (
            <p className="text-sm">
              {reasonLabels[mission.result.status ?? ""] ??
                `下一步：${toolLabels[mission.next_tool] ?? "等待處理"}`}
            </p>
          )}
          {!readOnly &&
            mission.result.confirmation_required &&
            mission.status === "waiting_user" && (
              <Button
                disabled={busy}
                onClick={() =>
                  void execute(async () => {
                    const m = await paymentApi<Mission>(
                      `/missions/${mission.mission_id}/confirm`,
                      { expected_version: mission.order?.version },
                    );
                    await show(m);
                    await progress(m);
                  })
                }
              >
                確認 {payment ? money(payment.amount) : "此筆款項"} 並繼續
              </Button>
            )}
          {!readOnly &&
            ["queued", "paused", "waiting_external"].includes(
              mission.status,
            ) && (
              <Button
                disabled={busy}
                onClick={() =>
                  void execute(async () => {
                    const m = await paymentApi<Mission>(
                      `/missions/${mission.mission_id}/resume`,
                      {},
                    );
                    await show(m);
                    await progress(m);
                  })
                }
              >
                {busy && <LoaderCircle className="size-4 animate-spin" />}
                重新核對並繼續
              </Button>
            )}
          {!readOnly &&
            active &&
            !mission.write_result &&
            !mission.blocked_by &&
            mission.kind === "record_payment" && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void execute(async () => {
                    await show(
                      await paymentApi<Mission>(
                        `/missions/${mission.mission_id}/cancel`,
                        {},
                      ),
                    );
                    setNewPayment(true);
                  })
                }
              >
                撤回未登記任務
              </Button>
            )}
          {mission.parent_mission_id && (
            <Button asChild variant="outline">
              <Link href={`/missions?mission=${mission.parent_mission_id}`}>
                回到原付款任務
              </Link>
            </Button>
          )}
          {mission.blocked_by && (
            <Button asChild variant="outline">
              <Link href={`/missions?mission=${mission.blocked_by}`}>
                查看並處理阻擋任務
              </Link>
            </Button>
          )}
          {!readOnly &&
            ["needs_more_criteria", "not_found"].includes(
              mission.result.status ?? "",
            ) && (
              <div className="space-y-2">
                <Label htmlFor="clarify-order">補充精確訂單編號</Label>
                <Input
                  id="clarify-order"
                  value={clarification}
                  onChange={(e) => setClarification(e.target.value)}
                />
                <Button
                  disabled={busy || !clarification.trim()}
                  onClick={() =>
                    void execute(async () => {
                      const m = await paymentApi<Mission>(
                        `/missions/${mission.mission_id}/clarify`,
                        { order_id: clarification.trim() },
                      );
                      await show(m);
                      await progress(m);
                    })
                  }
                >
                  補充並重新核對
                </Button>
              </div>
            )}
          {!readOnly &&
            mission.kind !== "record_payment" &&
            mission.status !== "completed" && (
              <div className="space-y-2">
                <p className="text-sm">
                  先修正來源中的衝突，再提供處理依據。系統會重新查核後才解除阻擋。
                </p>
                <Label htmlFor="evidence">處理依據</Label>
                <Textarea
                  id="evidence"
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                />
                <Button
                  disabled={busy || evidence.trim().length < 10}
                  onClick={() =>
                    void execute(async () => {
                      await show(
                        await paymentApi<Mission>(
                          `/missions/${mission.mission_id}/resolve`,
                          { evidence },
                        ),
                      );
                    })
                  }
                >
                  提交依據並驗證
                </Button>
              </div>
            )}
          <div className="flex flex-wrap gap-3 text-xs text-primary">
            <Link href={`/missions?mission=${mission.mission_id}`}>
              在任務中心接手
            </Link>
            {missionOrderId(mission) && (
              <Link
                href={`/calendar?order=${encodeURIComponent(missionOrderId(mission)!)}`}
              >
                查看日曆中的訂單
              </Link>
            )}
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              處理紀錄與 Agent 契約
            </summary>
            <ol className="mt-2 space-y-2">
              {mission.steps?.map((step) => (
                <li key={step.id}>
                  {toolLabels[step.tool_name] ?? step.tool_name} ·{" "}
                  {new Date(step.created_at).toLocaleTimeString("zh-TW")}
                </li>
              ))}
            </ol>
            <p className="mt-3 break-all">任務 ID：{mission.mission_id}</p>
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2">
              {JSON.stringify(
                {
                  request: mission.request,
                  status: mission.status,
                  next_tool: mission.next_tool,
                  result: mission.result,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      )}
      {!readOnly &&
        !loading &&
        ready &&
        !active &&
        (!mission || mission.status === "canceled" || newPayment) && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void execute(submit);
            }}
          >
            {!orderId && (
              <div className="space-y-1">
                <Label htmlFor="payment-order">訂單編號</Label>
                <Input
                  id="payment-order"
                  value={queryId}
                  onChange={(e) => setQueryId(e.target.value)}
                  required
                  placeholder="例如 test-order-301"
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="payment-kind">款項類型</Label>
                <Select
                  value={kind}
                  onValueChange={(v) =>
                    setKind(v as PaymentInput["payment_type"])
                  }
                >
                  <SelectTrigger id="payment-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deposit">訂金</SelectItem>
                    <SelectItem value="balance">尾款</SelectItem>
                    <SelectItem value="payment">其他收款</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="payment-amount">金額（TWD）</Label>
                <Input
                  id="payment-amount"
                  type="number"
                  min="1"
                  step="1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="payment-method">收款方式</Label>
                <Select
                  value={method}
                  onValueChange={(v) =>
                    setMethod(v as PaymentInput["payment_method"])
                  }
                >
                  <SelectTrigger id="payment-method" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank_transfer">銀行轉帳</SelectItem>
                    <SelectItem value="cash">現金</SelectItem>
                    <SelectItem value="card">信用卡</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-1">
                <Label htmlFor="payment-date">收款時間</Label>
                <Input
                  id="payment-date"
                  type="datetime-local"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                  className="min-w-0"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="payment-note">備註（選填）</Label>
              <Input
                id="payment-note"
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              送出後會建立任務，核對訂單、登記款項並驗證。需要你決定時會暫停，可由任務中心繼續。
            </p>
            <Button className="w-full" disabled={busy} type="submit">
              {busy && <LoaderCircle className="size-4 animate-spin" />}
              {retryRequest.current ? "以原內容重試付款任務" : "登記付款並驗證"}
            </Button>
          </form>
        )}
      {!readOnly &&
        mission?.status === "completed" &&
        !newPayment &&
        mission.kind === "record_payment" && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setQueryId(missionOrderId(mission) ?? orderId ?? "");
              setNewPayment(true);
              setAmount(String(mission.order?.balance_due || ""));
              setKind("balance");
            }}
          >
            登記下一筆款項
          </Button>
        )}
    </section>
  );
}
