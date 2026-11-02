"use client";
import { useEffect, useState } from "react";
import type { WorkspaceView } from "@/lib/customer-workspaces/types";
import { api, button, secondary } from "./client";

type Grant = { id: string; provider: "line" | "gmail" | "owlnest"; propertyId: string;
  status: "awaiting_source" | "awaiting_owner" | "active" | "revoked"; version: number;
  sourceAccount: string | null; sourceLabel: string | null; ownerSubject: string | null; approvedAt: string | null };
type State = { workspaceVersion: number; clients: { id: string; providers: Grant["provider"][]; startUrl: string | null }[]; grants: Grant[];
  fences: { id: string; propertyId: string; mode: "open" | "close"; state: "pending" | "closed";
    checkIn: string; checkOut: string; roomIds: string[] }[] };
const labels = { line: "LINE 訂房小助手", gmail: "OTA 郵件", owlnest: "OwlNest 房態" };
export function SourceIntegrations({ data, initialPropertyId, request }: { data: WorkspaceView;
  initialPropertyId?: string; request: { client_id?: string; provider?: string; state?: string; code_challenge?: string } }) {
  const [propertyId, setPropertyId] = useState(data.properties.some(p => p.id === initialPropertyId) ? initialPropertyId! : data.properties[0]?.id ?? "");
  const [current, setCurrent] = useState<State | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const endpoint = `/api/customer-workspaces/${data.slug}/integrations`;
  useEffect(() => { let active = true; api<State>(endpoint).then(value => { if (active) setCurrent(value); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [endpoint]);
  const client = current?.clients.find(c => c.id === request.client_id && c.providers.includes(request.provider as Grant["provider"]));
  const flow = !!client && !!request.state && !!request.code_challenge;
  async function authorize() {
    if (!flow || !current || busy || !propertyId) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ redirectUrl: string }>(endpoint, "POST", { action: "issue", propertyId,
        clientId: client.id, provider: request.provider, state: request.state, codeChallenge: request.code_challenge,
        version: current.workspaceVersion, requestKey: crypto.randomUUID() });
      window.location.assign(result.redirectUrl);
    } catch (e) { setError(e instanceof Error ? e.message : "連接結果尚未確認，請重新讀取。" ); setBusy(false); }
  }
  async function act(grant: Grant, action: "approve" | "revoke") {
    if (!current || busy || (action === "approve" && !grant.sourceAccount)) return;
    if (action === "revoke" && !window.confirm("撤銷此來源授權後，該館官網會停止新接單。確定撤銷？")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const updated = await api<State>(endpoint, "POST", { action, grantId: grant.id, grantVersion: grant.version,
        propertyId: grant.propertyId, sourceAccount: grant.sourceAccount ?? "", version: current.workspaceVersion, requestKey: crypto.randomUUID() });
      setCurrent(updated); setNotice(action === "approve" ? "已核准這個來源帳號。正式銷售仍須核對房態及接單閘門。" : "授權已撤銷，該館官網新接單已停止。");
    } catch (e) { setError(e instanceof Error ? e.message : "結果尚未確認，請重新讀取。" ); try { setCurrent(await api<State>(endpoint)); } catch { /* Retain uncertainty. */ } }
    finally { setBusy(false); }
  }
  const property = data.properties.find(p => p.id === propertyId);
  function startHref(base: string, provider: Grant["provider"]) {
    const url = new URL(base);
    url.searchParams.set("workspaceSlug", data.slug);
    url.searchParams.set("propertyId", propertyId);
    url.searchParams.set("provider", provider);
    return url.toString();
  }
  return <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
    <a className="text-sm underline" href={`/w/${data.slug}/settings?property=${encodeURIComponent(propertyId)}`}>返回旅宿設定</a>
    <h1 className="mt-6 text-3xl font-semibold">來源與通路連接</h1>
    <p className="mt-3 text-slate-600">每一館由業主單獨核准 LINE、OTA 郵件與 OwlNest。這裡只管理授權與房間識別；提供者密碼和 OAuth 權杖由連接服務保管。</p>
    <label className="mt-7 block font-medium">管理館別 <select className="ml-3 rounded-xl border p-3" value={propertyId} onChange={e => setPropertyId(e.target.value)}>{data.properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    {error ? <p className="mt-5 rounded-xl bg-rose-50 p-4 text-rose-800" role="alert">{error}</p> : null}
    {notice ? <p className="mt-5 rounded-xl bg-teal-50 p-4 text-teal-800" role="status">{notice}</p> : null}
    {flow ? <section className="mt-7 rounded-2xl border border-teal-300 bg-teal-50 p-5">
      <h2 className="text-xl font-semibold">核准連接 {labels[request.provider as Grant["provider"]]}</h2>
      <p className="mt-2">連接服務：{client.id}。要授權的館別：{property?.name ?? "未選擇"}。完成後才會返回該服務，並由你在這裡再次確認實際來源帳號。</p>
      <button className={`${button} mt-4`} disabled={busy || !propertyId} onClick={authorize}>確認並繼續連接</button>
    </section> : request.client_id || request.provider ? <p className="mt-7 rounded-xl bg-amber-50 p-4 text-amber-900">連接申請不完整或尚未在此環境啟用。請從原本的連接服務重新開始。</p> : null}
    <section className="mt-10"><h2 className="text-xl font-semibold">此館授權</h2>
      {!current && !error ? <p className="mt-3">正在讀取…</p> : null}
      {current?.grants.filter(g => g.propertyId === propertyId).map(g => <article key={g.id} className="mt-4 rounded-2xl border p-5">
        <h3 className="font-semibold">{labels[g.provider]} · {g.sourceLabel ?? "待連接來源帳號"}</h3>
        <p className="mt-2 text-sm text-slate-600">{g.status === "active" ? "已核准" : g.status === "awaiting_owner" ? "待業主核准來源帳號" : g.status === "awaiting_source" ? "等待連接服務驗證" : "已撤銷"}{g.sourceAccount ? ` · 來源帳號 ${g.sourceAccount}` : ""}{g.ownerSubject ? ` · LINE 業主識別 ${g.ownerSubject}` : ""}</p>
        <div className="mt-4 flex gap-3">{g.status === "awaiting_owner" ? <button className={button} disabled={busy} onClick={() => act(g,"approve")}>核准此帳號</button> : null}
          {g.status !== "revoked" ? <button className={secondary} disabled={busy} onClick={() => act(g,"revoke")}>撤銷授權</button> : null}</div>
      </article>)}
      {current && !current.grants.some(g => g.propertyId === propertyId) ? <p className="mt-3 text-slate-600">尚無已連接來源。</p> : null}
    </section>
    {current?.fences.some(f => f.propertyId === propertyId) ? <section className="mt-10 rounded-2xl border border-amber-300 bg-amber-50 p-5">
      <h2 className="text-xl font-semibold">通路房態待核對</h2><p className="mt-2 text-sm">以下房晚由 OS 持續保留，未完成提供者讀回前不會自行開放。</p>
      <ul className="mt-3 list-disc pl-5 text-sm">{current.fences.filter(f => f.propertyId === propertyId).map(f => <li key={f.id}>{f.checkIn} 至 {f.checkOut}（退房日不含）· {f.roomIds.length} 房 · {f.state === "pending" ? "操作結果待核對" : "OwlNest 已關房"}</li>)}</ul>
    </section> : null}
    <section className="mt-10"><h2 className="text-xl font-semibold">新增連接</h2><div className="mt-4 grid gap-3 sm:grid-cols-3">{current?.clients.flatMap(c => c.providers.map(provider => ({ client: c, provider }))).map(({ client, provider }) => client.startUrl && propertyId ? <a key={`${client.id}:${provider}`} className="rounded-xl border p-4 underline" href={startHref(client.startUrl, provider)} rel="noreferrer">連接 {labels[provider]} ↗</a> : null)}</div>
      {!current?.clients.length ? <p className="mt-3 text-slate-600">此環境尚未設定新的來源連接；現有房況與訂單不會因此變更。</p> : null}</section>
  </main>;
}
