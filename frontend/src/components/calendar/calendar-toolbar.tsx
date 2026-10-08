"use client";

import { CircleHelp } from "lucide-react";
import { useIntlLocale, useT } from "@/components/i18n/language-provider";
import { Button } from "@/components/ui/button";
import { useAccessControl, useEffectivePermissions } from "@/lib/access-control";
import { cn } from "@/lib/utils";
import { useCalendarPreferences } from "./calendar-preferences";
import type { CalendarResponse } from "./calendar-types";
import { PLATFORM_LABELS, PLATFORM_STYLES } from "./calendar-utils";

export function CalendarToolbar({ data, showUnsold, paymentReview, onPaymentReview }: {
  data?: CalendarResponse | null;
  showUnsold: boolean;
  paymentReview: boolean;
  onPaymentReview: () => void;
}) {
  const t = useT();
  const locale = useIntlLocale();
  const { viewPrices } = useEffectivePermissions();
  const membership = useAccessControl(s => s.membership);
  const mode = useCalendarPreferences(s => s.mode);
  const setMode = useCalendarPreferences(s => s.setMode);
  const selected = useCalendarPreferences(s => s.selectedPropertyIds);
  const sources = (data?.sources ?? (data?.source ? [{ property_id: "sweetfun", source: data.source, summary: data.source_summary }] : []))
    .filter(item => selected.includes(item.property_id) && (!membership || membership.allProperties || membership.propertyIds.includes(item.property_id)));
  return <div className="sticky top-14 z-40 flex flex-wrap items-center gap-1.5 bg-background/95 py-1 backdrop-blur md:top-0" aria-label={t("日曆工具列")}>
    {viewPrices && mode === "sold" && <Button size="sm" variant={paymentReview ? "default" : "outline"} aria-pressed={paymentReview} onClick={onPaymentReview}>{t("檢視付款狀態")}</Button>}
    <details className="group md:relative">
      <summary aria-label={t("日曆圖例")} title={t("日曆圖例")} className="flex size-8 cursor-pointer list-none items-center justify-center rounded-full text-muted-foreground hover:bg-muted [&::-webkit-details-marker]:hidden">
        <CircleHelp className="size-4" />
      </summary>
      <div className="absolute left-2 right-2 top-full z-50 mt-1 md:left-0 md:right-auto md:w-64 space-y-3 rounded-xl border bg-popover p-3 text-xs shadow-lg">
        <p className="font-semibold">{t("日曆圖例")}</p>
        <div className="flex flex-wrap gap-2">{Object.entries(PLATFORM_LABELS).map(([platform, label]) => <span key={platform} className="flex items-center gap-1"><span className={cn("size-2.5 rounded-sm border", PLATFORM_STYLES[platform])} />{t(label)}</span>)}</div>
        {viewPrices && <p>{t("灰底：已付清 · 訂：已付訂金 · 未：未付款")}</p>}
        {viewPrices && <p className="text-muted-foreground">{t("已付清指客人已付清，OTA 收款與旅宿入帳尚未記錄。")}</p>}
      </div>
    </details>
    <div className="order-3 flex w-full flex-wrap items-center justify-end gap-1.5 sm:order-none sm:w-auto sm:flex-1 sm:justify-start">
      {sources.map(({ property_id, source, summary }) => {
        const issue = (summary?.new_issue_rows ?? 0) > 0;
        const status = source.automatic_sync && source.sync ? source.sync.status : "waiting";
        const incomplete = data?.source_warnings?.some(warning => warning.property_id === property_id);
        const healthy = status === "healthy" && !issue && !incomplete;
        const label = property_id === "sweetfun" ? "Sweetfun" : property_id === "offland" ? "OFFLAND" : source.label;
        const text = incomplete ? "待確認" : issue ? "待核對" : ({ healthy: "正常", confirming: "確認中", waiting: "待同步", error: "同步失敗", stale: "已過期" })[status];
        return <details key={property_id} className="md:relative">
          <summary className={cn("flex cursor-pointer list-none items-center gap-1 whitespace-nowrap rounded-full border px-2 py-1 text-[10px] [&::-webkit-details-marker]:hidden", healthy ? "border-border text-muted-foreground" : "border-amber-300 bg-amber-50 text-amber-950")}>
            <span className={cn("size-1.5 rounded-full", healthy ? "bg-emerald-500" : "bg-amber-500")} />
            {label} · {t(text)}
          </summary>
          <div className="absolute left-2 right-2 top-full z-50 mt-1 md:left-0 md:right-auto md:w-64 max-w-[calc(100vw-2rem)] space-y-2 rounded-xl border bg-popover p-3 text-xs shadow-lg">
            <p className="font-semibold">{source.label} · {t("唯讀")}</p>
            <p>{t(({ waiting: "尚未啟用自動同步或等待首次檢查。", healthy: "每分鐘自動檢查訂房表。", confirming: "發現資料變更，確認前保留上次資料。", error: "檢查失敗，保留上次資料，系統會自動重試。", stale: "資料可能過期，目前顯示上次資料。" })[status])}</p>
            <p>{t("最後成功確認：")}{source.sync?.last_successful_check_at ? new Date(source.sync.last_successful_check_at).toLocaleString(locale, { timeZone: "Asia/Taipei" }) : t("尚無確認紀錄")}</p>
            {issue && <p className="text-amber-800">{t("新增或變更的問題涉及")}{summary?.new_issue_rows}{t("列，相關房況待核對。")}</p>}
          </div>
        </details>;
      })}
    </div>
    {showUnsold && <div className="ml-auto inline-flex shrink-0 gap-1 rounded-xl border bg-muted/40 p-1" role="group" aria-label={t("切換已售與未售")}>
      {(["sold", "unsold"] as const).map(value => <Button key={value} size="sm" variant={mode === value ? "default" : "ghost"} aria-pressed={mode === value} onClick={() => setMode(value)}>{t(value === "sold" ? "已售訂單" : "未售房況")}</Button>)}
    </div>}
  </div>;
}
