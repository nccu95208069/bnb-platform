import type { PricingDecision } from "@/lib/pricing-decision";
const labels: Record<PricingDecision["publish_status"], string> = {
  shadow: "試算・未發布", proposed: "待發布", skipped: "已跳過・未發布", verified: "發布當時已核對", failed: "發布失敗・需核對",
};
const money = (value: number | null) => value === null ? "—" : `NT$ ${value.toLocaleString("zh-TW")}`;
const time = (value: string | null) => value ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }) : "尚未發布";
export function PricingDecisionDetails({ decision: d }: { decision: PricingDecision }) {
  return <section className="space-y-3 rounded-xl border p-3 text-sm" aria-label="定價決策紀錄">
    <h3 className="font-semibold">定價決策 · {labels[d.publish_status]}</h3>
    <dl className="grid grid-cols-2 gap-2">
      <div><dt className="text-xs text-muted-foreground">計算基準價</dt><dd>{money(d.base_price)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">目標價</dt><dd>{money(d.target_price)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">當次發布查回價</dt><dd>{money(d.published_price)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">調整幅度</dt><dd>{d.adjustment_pct === null ? '未定義' : `${d.adjustment_pct > 0 ? '+' : ''}${d.adjustment_pct.toFixed(2)}%`}</dd></div>
    </dl>
    <p>原因：{d.reason}</p>
    <p>計算使用的售出機率：{d.probability ? `${(d.probability.value * 100).toFixed(1)}%（${d.probability.asof}）` : "未提供"}</p>
    <p className="text-xs text-muted-foreground">計算：{time(d.calculated_at)} · 發布：{time(d.published_at)}（臺北）。此紀錄描述當次決策，目前通路價以最新價格觀測為準。</p>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">版本與查核資訊</summary><div className="mt-2 space-y-1 break-all">
      <p>執行編號：{d.run_id}</p><p>輸入版本：{d.source_version}</p><p>模型：{d.model_version} · 政策：{d.policy_version}</p>
      {d.probability && <p>機率版本：{d.probability.source_version}</p>}<p>決策觀測時間：{time(d.observed_at)}</p>
    </div></details>
  </section>;
}
