"use client";

import { useEffect, useState } from "react";

export default function CalendarAccessPage() {
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
      const response = await fetch("/api/calendar-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }), cache: "no-store" });
      if (!response.ok) throw new Error((await response.json()).detail || "暫時無法登入，請稍後再試。");
      setCode(""); window.location.replace("/calendar");
    } catch (error) { setError(error instanceof Error ? error.message : "暫時無法登入。"); setBusy(false); }
  }
  return <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-5">
    <form onSubmit={enter} className="w-full max-w-sm space-y-5 rounded-2xl border bg-white p-6 shadow-sm">
      <div><p className="text-sm text-slate-500">Sweetfun OS</p><h1 className="mt-2 text-xl font-semibold">私人日曆</h1><p className="mt-2 text-sm text-slate-600">登入後即可在月、週、日曆查看旅客姓名。</p></div>
      <label className="block text-sm font-medium">私人登入碼<input aria-label="私人登入碼" type="password" autoComplete="current-password" required value={code} onChange={e => setCode(e.target.value.trim())} className="mt-2 block w-full rounded-lg border px-3 py-2.5" /></label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button disabled={busy} className="w-full rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-50">{busy ? "登入中…" : "進入私人日曆"}</button>
      <p className="text-xs text-slate-500">此登入限擁有者使用，12 小時後需重新登入。</p>
      <a href="/calendar" className="block text-center text-sm underline">返回不顯示姓名的日曆</a>
    </form>
  </main>;
}
