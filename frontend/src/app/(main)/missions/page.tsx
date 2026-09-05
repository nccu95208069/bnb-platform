"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ClipboardList, Plus, RefreshCw } from "lucide-react";
import { PaymentWorkspace } from "@/components/payments/payment-workspace";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  PAYMENT_SANDBOX,
  paymentApi,
  statusLabels,
  type Mission,
} from "@/lib/payment-workflow";
import { useEffectivePermissions } from "@/lib/access-control";
function MissionCenter() {
  const params = useSearchParams();
  const selected = params.get("mission") ?? undefined;
  const permissions = useEffectivePermissions();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!PAYMENT_SANDBOX || !permissions.viewPrices) return;
    try {
      const data = await paymentApi<{ missions: Mission[] }>("/missions");
      setMissions(data.missions);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "任務讀取失敗");
    } finally {
      setLoading(false);
    }
  }, [permissions.viewPrices]);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [reload]);
  if (!PAYMENT_SANDBOX) return <p>付款任務尚未在這個環境啟用。</p>;
  if (!permissions.viewPrices) return <p>這個角色無法查看付款任務。</p>;
  const pending = missions.filter(
    (m) => !["completed", "canceled"].includes(m.status),
  );
  const sorted = [
    ...pending,
    ...missions
      .filter((m) => ["completed", "canceled"].includes(m.status))
      .reverse(),
  ];
  return (
    <div className="space-y-5 pb-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-primary">
            Sweetfun · Agent First
          </p>
          <h1 className="mt-1 text-2xl font-semibold">任務中心</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            交辦、查看結果、接手處理。人與 Agent 共用同一份任務進度。
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/calendar">返回訂單日曆</Link>
        </Button>
      </header>
      <p className="rounded-lg border bg-muted/40 p-3 text-xs">
        隔離測試 · 付款與任務會保存至本機資料庫。此處提供結構化交辦；自然語言
        Agent 尚未連接。
      </p>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
        <Card
          className={selected || params.has("new") ? "order-2 lg:order-1" : ""}
        >
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <ClipboardList className="size-4" />
                任務 · {pending.length} 筆待處理
              </CardTitle>
              <Button
                size="icon"
                variant="ghost"
                aria-label="更新任務列表"
                onClick={() => void reload()}
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {permissions.recordPayments && (
              <Button asChild variant="outline" className="w-full">
                <Link href="/missions?new=1">
                  <Plus className="size-4" />
                  交辦登記付款
                </Link>
              </Button>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {loading ? (
              <p className="text-sm text-muted-foreground">讀取任務中…</p>
            ) : (
              missions.length === 0 && (
                <p className="py-6 text-sm text-muted-foreground">
                  還沒有任務。從日曆點選訂單登記付款，或在這裡交辦。
                </p>
              )
            )}
            {sorted.map((m) => (
              <Link
                key={m.mission_id}
                href={`/missions?mission=${m.mission_id}`}
                aria-current={selected === m.mission_id ? "page" : undefined}
                className={`block space-y-2 rounded-lg border p-3 ${selected === m.mission_id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
              >
                <Badge variant="secondary">
                  {statusLabels[m.status] ?? m.status}
                </Badge>
                <p className="break-words text-sm font-medium">{m.goal}</p>
                {m.blocked_by && (
                  <p className="text-xs text-muted-foreground">
                    需先完成關聯的調查任務
                  </p>
                )}
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card
          className={selected || params.has("new") ? "order-1 lg:order-2" : ""}
        >
          <CardHeader>
            <CardTitle>{selected ? "任務詳情" : "交辦付款"}</CardTitle>
          </CardHeader>
          <CardContent>
            <PaymentWorkspace
              key={selected ?? params.get("new") ?? "new"}
              missionId={selected}
              onChange={() => void reload()}
              readOnly={!permissions.recordPayments}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
export default function MissionsPage() {
  return (
    <Suspense fallback={<p>讀取任務中…</p>}>
      <MissionCenter />
    </Suspense>
  );
}
