"use client";
import {useT} from "@/components/i18n/language-provider";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { paymentApi, type Mission } from "@/lib/payment-workflow";
import {
  availabilityError,
  channelLabels,
  policyLabels,
  priceText,
  type PricingPreview,
} from "@/lib/availability";
export function PricingMission({ missionId }: { missionId: string }) {
  const uiText = useT();

  const [mission, setMission] = useState<Mission | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    paymentApi<Mission>(`/missions/${missionId}`)
      .then((m) => {
        if (active) setMission(m);
      })
      .catch((e) => {
        if (active) setError(availabilityError(e));
      });
    return () => {
      active = false;
    };
  }, [missionId]);
  if (error) return <p role="alert">{uiText(error)}</p>;
  if (!mission) return <p>{uiText("讀取調價交辦中…")}</p>;
  const preview = mission.result as unknown as PricingPreview;
  return (
    <section className="space-y-4" aria-label={uiText("調價交辦詳情")}>
      <Badge variant="secondary">{uiText("等待定價引擎接手")}</Badge>
      <h2 className="font-semibold">{mission.goal}</h2>
      <p className="text-sm">
        {uiText("本機示範交辦已保存；尚未串接定價 Agent，也未發布價格。正式計畫、業主核准與通路讀回仍由原定價流程完成。")}</p>
      <p className="text-sm text-muted-foreground">
        {preview.query.start} {uiText("至")}{preview.query.end}{uiText("（不含末日）·")}{" "}
        {channelLabels[preview.query.channel]}
      </p>
      <div className="flex gap-2">
        <Badge variant="outline">{uiText("可提案")}{preview.proposed.length} {uiText("房晚")}</Badge>
        <Badge variant="outline">{uiText("排除")}{preview.excluded.length} {uiText("房晚")}</Badge>
      </div>
      <div className="max-h-80 overflow-auto rounded-lg border text-xs">
        {preview.proposed.map((c) => (
          <div
            key={`${c.room}|${c.date}`}
            className="flex flex-wrap justify-between gap-2 border-b p-2"
          >
            <span>
              {c.date} · {c.room}
            </span>
            <span>
              {priceText(c.pricing?.current_price)} →{" "}
              {priceText(c.pricing?.suggested_price)}
            </span>
          </div>
        ))}
      </div>
      <details className="text-xs">
        <summary>{uiText("排除清單與交接契約")}</summary>
        <ul className="my-3 space-y-1">
          {preview.excluded.map((c) => (
            <li key={`${c.room}|${c.date}`}>
              {c.date} · {c.room} · {policyLabels[c.reason] ?? c.reason}
            </li>
          ))}
        </ul>
        <p className="break-all">Mission：{mission.mission_id}</p>
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2">
          {JSON.stringify(
            { request: mission.request, result: mission.result },
            null,
            2,
          )}
        </pre>
      </details>
      <Button asChild variant="outline">
        <Link href="/calendar?mode=unsold">{uiText("返回未售房況")}</Link>
      </Button>
    </section>
  );
}
