"use client";
import { useEffect, useState } from "react";
import { api, button, secondary } from "../customer-workspaces/client";
import type { WorkspaceView } from "@/lib/customer-workspaces/types";
import type { websiteManagement } from "@/lib/website-booking/management";

type Management = Awaited<ReturnType<typeof websiteManagement>>;
export function WebsiteWorkspace({ data, initialPropertyId }: { data: WorkspaceView; initialPropertyId?: string }) {
  const [propertyId, setPropertyId] = useState(data.properties.some(p => p.id === initialPropertyId) ? initialPropertyId! : data.properties[0]?.id ?? "");
  const [management, setManagement] = useState<Management | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [staticAcknowledged, setStaticAcknowledged] = useState<Record<string, boolean>>({});
  const endpoint = `/api/customer-workspaces/${data.slug}/website`;
  useEffect(() => {
    if (data.role !== "owner") return;
    let active = true;
    api<Management>(endpoint).then(value => { if (active) setManagement(value); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [data.role, endpoint]);
  const property = data.properties.find(p => p.id === propertyId);
  const href = (page: string, query: Record<string, string> = {}) => `/w/${data.slug}/${page}?${new URLSearchParams({ property: propertyId, ...query })}`;
  const held = data.bookings.filter(b => b.propertyId === propertyId && b.status === "held");
  const pending = held.filter(b => b.hold?.state === "awaiting_owner");
  const canEnable = (site: Management["sites"][number]) => site.ready &&
    (site.source.mode === "native" || site.source.mode === "connected" || staticAcknowledged[site.id] === true);
  async function toggle(site: Management["sites"][number]) {
    if (busy || (!site.enabled && !canEnable(site))) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<Management>(endpoint, "POST", { action: "sales", bindingId: site.id, revision: site.revision,
        enabled: !site.enabled, confirmedStaticSource: !site.enabled && staticAcknowledged[site.id] === true,
        confirmedEmptyCalendar: !site.enabled && site.source.mode === "empty" && staticAcknowledged[site.id] === true,
        requestKey: crypto.randomUUID() });
      setManagement(result);
      setStaticAcknowledged(previous => ({ ...previous, [site.id]: false }));
      setNotice(site.enabled ? "已暫停這個網站的新預訂，既有訂單及占房保持不變。" : "OS 已允許官網接單；網站端也需完成發布與開放設定。實際狀態可從旅客頁確認。");
    } catch (error) {
      setError(error instanceof Error ? error.message : "結果尚未確認，請重新查詢。");
      try { setManagement(await api<Management>(endpoint)); } catch { /* Keep the visible result uncertain. */ }
    } finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
    <a className="text-sm text-slate-600 underline" href="/workspaces">我的旅宿</a>
    <header className="my-8"><p className="text-sm tracking-widest text-teal-800">SWEETFUN OS</p><h1 className="mt-2 text-3xl font-semibold">{data.name}</h1><p className="mt-3 text-slate-600">從今天的房況到每一筆收款，在這裡照顧好住宿安排。</p></header>
    {data.properties.length > 1 ? <label className="mb-6 block">管理館別<select value={propertyId} onChange={event => setPropertyId(event.target.value)} className="ml-3 rounded-xl border p-3">{data.properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : null}
    {property ? <>
      <section aria-label="常用功能" className="grid gap-4 sm:grid-cols-2">
        {[
          { title: "房況日曆", detail: "查看空房、安排住宿與封房", url: href("calendar") },
          { title: "保留待處理", detail: `${pending.length} 筆到期待確認 · ${held.length} 筆保留中`, url: href("orders", { status: "awaiting_owner" }) },
          { title: "訂單查詢", detail: "查詢旅客、修改住宿與處理取消", url: href("orders") },
          ...(data.role !== "viewer_no_price" ? [{ title: "收款記帳", detail: "確認訂金、核對尾款與記錄退款", url: href("finance") }] : []),
        ].map(card => <a key={card.title} className="rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-teal-600 focus-visible:outline-2 focus-visible:outline-teal-700" href={card.url}><h2 className="text-xl font-semibold">{card.title} <span aria-hidden="true">↗</span></h2><p className="mt-2 text-slate-600">{card.detail}</p></a>)}
      </section>
      <p className="my-6 rounded-xl bg-amber-50 p-4 text-sm text-amber-950">官網保留期限為 24 小時。到期後房間仍會保留，請確認款項，再選擇延長、確認收款或釋出。</p>
      {(["owner", "admin"].includes(data.role)) ? <p className="flex flex-wrap gap-5"><a className="underline" href={href("settings")}>房價與旅宿設定</a><a className="underline" href={href("calendar")}>手動新增訂單與封房</a>{data.role === "owner" ? <a className="underline" href={href("integrations")}>LINE／OTA／OwlNest 授權</a> : null}</p> : null}
    </> : <p>目前没有可管理的館別。</p>}
    {data.role === "owner" ? <section className="mt-10 border-t border-slate-200 pt-8"><h2 className="text-xl font-semibold">官網預訂</h2>
      <p className="mt-2 text-slate-600">房價與房況由這個工作區提供；網站內容由建站工作台管理。</p>
      <p className="my-4 text-rose-800" role="alert">{error}</p><p className="my-4 text-teal-800" role="status">{notice}</p>
      {!management && !error ? <p>正在讀取連接設定…</p> : null}
      {management?.sites.filter(s => s.propertyId === propertyId).map(site => <article key={site.id} className="my-5 rounded-2xl border border-slate-200 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4"><div><h3 className="font-semibold">{site.siteName}</h3><p className="mt-1 text-sm">{site.enabled && site.ready ? "OS 允許接單" : site.enabled ? "OS 已暫停新預訂，房況需核對" : "OS 尚未開放接單"} · 開放住宿 {site.config.opensOn} 至 {site.config.closesOn}</p></div><button className={site.enabled ? secondary : button} disabled={busy || (!site.enabled && !canEnable(site))} onClick={() => toggle(site)}>{busy ? "處理中…" : site.enabled ? "暫停官網收單" : "開放官網收單"}</button></div>
        {!site.ready ? <p className="mt-3 text-sm text-rose-800">目前官網不可新增預訂；請核對房況來源與範圍、房價及網站連接狀態，再重新查詢。</p> : null}
        {site.source.mode === "connected" ? <p className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-950">此館別使用持續連線的日曆，但 OS 尚無安全回寫到該來源的能力，不能開放官網接單。</p> : null}
        {site.source.mode === "empty" ? <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-950">
          <p>這是全新空日曆，已建立實體房間與初始房價。屋主確認的可售住宿期間：{site.source.coverageFrom ?? "未確認"} 至 {site.source.coverageTo ?? "未確認"}（結束日不含）。OS 會依已登記訂房、保留及封房阻擋重複接單；其他通路的新訂單須先登記到 OS。</p>
          {!site.enabled ? <label className="mt-3 flex gap-2"><input type="checkbox" checked={staticAcknowledged[site.id] === true} onChange={event => setStaticAcknowledged(previous => ({ ...previous, [site.id]: event.target.checked }))} /><span>我已核對上述期間的房間、房價及所有既有訂房與封房；沒有尚未登記的占房，並同意從這個期間開始接單。</span></label> : null}
        </div> : null}
        {(site.source.mode === "calendar" || site.source.mode === "sheet") ? <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-950">
          <p>目前房況來自{site.source.mode === "calendar" ? "已上傳的日曆檔" : "已匯入的表格"}，不是持續同步。匯入範圍：{site.source.coverageFrom ?? "未確認"} 至 {site.source.coverageTo ?? "未確認"}（結束日不含）。來源有新訂單、取消或改房時，請先更新 OS 並核對房況；其他通路不會由這個開關自動更新。</p>
          {!site.enabled ? <label className="mt-3 flex gap-2"><input type="checkbox" checked={staticAcknowledged[site.id] === true} onChange={event => setStaticAcknowledged(previous => ({ ...previous, [site.id]: event.target.checked }))} /><span>我已核對來源範圍與所有通路房況，並會在來源變動時先更新 OS，再開放官網接單。</span></label> : null}
        </div> : null}
        <details className="mt-5"><summary className="cursor-pointer">房型對應與旅客規則</summary><dl className="my-4 space-y-3">{site.roomMappings.map((mapping, index) => <div key={index}><dt className="font-medium">{mapping.roomTypeName}</dt><dd className="text-slate-600">{mapping.roomNames.join("、")}</dd></div>)}</dl><h4 className="font-medium">匯款說明</h4><p className="my-2 whitespace-pre-wrap text-slate-600">{site.config.transferInstructions}</p><h4 className="mt-4 font-medium">修改與取消規則</h4><p className="my-2 whitespace-pre-wrap text-slate-600">{site.config.cancellationPolicy}</p><p className="mt-4 text-sm">更新日期、人數與旅客規則，請由建站工作台送出新設定，再由業主核准。日常房價請直接在房價設定調整。</p></details>
      </article>)}
      {management && !management.sites.some(s => s.propertyId === propertyId) ? <p className="my-4">這個館別目前沒有新版建站工作台的連接紀錄。</p> : null}
    </section> : null}
  </main>;
}
