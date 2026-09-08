"use client";
import {useT} from "@/components/i18n/language-provider";
import {LanguageSettings} from "@/components/i18n/language-settings";

import { useEffect, useState } from "react";

export default function CalendarAccessPage() {
  const uiText = useT();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    // Fragments never reach the web server. Remove the private entry code from
    // the current address before navigation or a link can copy it elsewhere.
    const fragment = window.location.hash.slice(1);
    if (/^[A-Za-z0-9_-]{32}$/.test(fragment)) setCode(fragment);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  async function enter(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/calendar-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code }), cache: "no-store" });
      if (!response.ok) throw new Error((await response.json()).detail || "暫時無法登入，請稍後再試。");
      const result = await response.json();
      setCode(""); window.location.replace(result.requires_password_reset ? "/reset-password" : "/calendar");
    } catch (error) { setError(error instanceof Error ? error.message : "暫時無法登入。"); setBusy(false); }
  }
  return <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-5">
    <form onSubmit={enter} className="w-full max-w-sm space-y-5 rounded-2xl border bg-white p-6 shadow-sm">
      <LanguageSettings compact/><div><p className="text-sm text-slate-500">Sweetfun OS</p><h1 className="mt-2 text-xl font-semibold">{uiText("登入 Sweetfun OS")}</h1><p className="mt-2 text-sm text-slate-600">{uiText("請用自己的 Email 或手機號碼與密碼登入，查看獲授權的旅宿。")}</p></div>
      <label className="block text-sm font-medium">{uiText("Email 或手機號碼")}<input aria-label={uiText("Email 或手機號碼")} type="text" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} className="mt-2 block w-full rounded-lg border px-3 py-2.5" /></label>
      <label className="block text-sm font-medium">{uiText("密碼")}<input aria-label={uiText("密碼")} type="password" autoComplete="current-password" required value={code} onChange={e => setCode(e.target.value)} className="mt-2 block w-full rounded-lg border px-3 py-2.5" /></label>
      {error && <p role="alert" className="text-sm text-red-700">{uiText(error)}</p>}
      <button disabled={busy} className="w-full rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-50">{busy ? uiText("登入中…") : uiText("登入")}</button>
      <p className="text-xs text-slate-500">{uiText("管理員已設定帳號密碼者可直接登入；收到邀請信者請先開啟連結設定密碼。登入會在此瀏覽器保留 30 天。")}</p>
      <a href="/forgot-password" className="block text-center text-sm underline">{uiText("忘記密碼？請管理員協助")}</a>
    </form>
  </main>;
}
