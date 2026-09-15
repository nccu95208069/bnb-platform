"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import RadarDashboard, { type RadarImport } from "./radar-dashboard";
import styles from "./github-radar.module.css";

type State = { data?: RadarImport; revision?: string; commit?: string; checkedAt?: string; error?: string; syncing?: boolean; rejectedCount?: number };

function capacityBanner(data: RadarImport) {
  const status = data.capacityStatus ?? "pending";
  if (status === "confirmed") {
    const units =
      data.capacityProvenance?.dailyTotalUnits ??
      (data.roomInventory ? Object.values(data.roomInventory).reduce((a, b) => a + b, 0) : undefined);
    const source = data.inventorySource ?? data.capacityProvenance?.source.method ?? "confirmed";
    return `容量已確認${units != null ? ` · 每日基準 ${units} 間` : ""} · 來源 ${source}。去化率與熱力已啟用。`;
  }
  if (status === "draft") {
    return "容量為草稿：僅供顯示，不去化率、不著色熱力。請等待確認後再計賣穿。";
  }
  return "容量待確認：月曆顯示「容量待確認」，不去化率、不著色熱力。已知剩餘與未知房型仍可參考。";
}

export default function GithubRadar({ propertyKey }: { propertyKey: "funinn" | "sweetfun" }) {
  const [state, setState] = useState<State>({});
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortSignal | null>(null);
  const refresh = useCallback(async (signal: AbortSignal) => {
    if (pending.current && !pending.current.aborted) return;
    pending.current = signal;
    setBusy(true);
    try {
      const response = await fetch(`/api/radar-github?property=${propertyKey}`, { method: "POST", signal, cache: "no-store" });
      const next: State = await response.json();
      if (!response.ok) throw Error(next.error || "同步未完成");
      if (!signal.aborted) setState(previous => ({ ...next, data: next.data ?? previous.data, revision: next.revision ?? previous.revision }));
    } catch (error) {
      if (!signal.aborted) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : "同步未完成" }));
    } finally {
      if (pending.current === signal) pending.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }, [propertyKey]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(controller.signal); }, 60000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(controller.signal); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  return <>
    <section className={styles.banner} aria-label="Grok 資料接收狀態">
      <div><strong>Grok 最新交付</strong><p aria-live="polite">{busy ? "正在檢查新資料…" : state.error ?? (state.data ? "已接收並核對，房況與價格狀態分開呈現。" : state.syncing ? "正在接收資料，請稍候。" : "尚無可呈現的交付資料。")}</p>
        {state.data && <p role="status" data-testid="capacity-status-banner">{capacityBanner(state.data)}</p>}
        <small>此本機頁面開啟時，每分鐘檢查 GitHub；電腦須保持運作。{state.checkedAt && ` 上次檢查 ${new Date(state.checkedAt).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" })}（台灣時間）`}</small>
        {!!state.rejectedCount && <p role="status">有 {state.rejectedCount} 次交付未通過接收檢查，先前資料保留。</p>}
      </div>
      <div className={styles.actions}><button disabled={busy} onClick={() => void refresh(new AbortController().signal)}>檢查新交付</button>{state.commit && <a href={`https://github.com/nccu95208069/bnb-radar-data/tree/${state.commit}/deliveries/booking/${propertyKey}`} target="_blank" rel="noreferrer noopener">查看原始交付</a>}<a href="/radar-test?view=funinn-september">歷史試抓頁面</a></div>
    </section>
    {state.data && <RadarDashboard key={state.revision} initialData={{ ...state.data, assumeUnlisted: false, allowInventoryEditing: false }} />}
  </>;
}
