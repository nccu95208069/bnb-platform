"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

export default function RecoverCalendarPasswordPage() {
  const initialToken = useRef<string | null>(null);
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialToken.current === null) {
      initialToken.current = window.location.hash.slice(1);
      window.history.replaceState(null, "", window.location.pathname);
    }
    const value = initialToken.current ?? "";
    if (!/^[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(value)) {
      setError("重設連結已失效，請重新申請。");
      return;
    }
    setToken(value);
    let active = true;
    fetch("/api/calendar-password-recovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "inspect", token: value }),
      cache: "no-store",
    }).then(async response => {
      if (!response.ok) throw new Error((await response.json()).detail || "重設連結已失效，請重新申請。");
      if (active) setReady(true);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "暫時無法驗證連結。"); });
    return () => { active = false; };
  }, []);

  async function reset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy || done) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/calendar-password-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "consume", token, password, confirmPassword }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error((await response.json()).detail || "重設失敗，請重新申請連結。");
      setToken("");
      setPassword("");
      setConfirmPassword("");
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重設失敗，請重新申請連結。");
    } finally {
      setBusy(false);
    }
  }

  return <main className="flex min-h-dvh items-center justify-center bg-slate-50 p-5">
    <section className="w-full max-w-sm space-y-5 rounded-2xl border bg-white p-6">
      <h1 className="text-xl font-semibold">設定既有日曆的新密碼</h1>
      {done ? <>
        <p role="status" className="text-sm leading-6">密碼已更新。舊的登入狀態已失效，請使用新密碼重新登入。</p>
        <Link href="/calendar-access" className="block rounded-lg bg-slate-900 p-3 text-center text-white">前往登入</Link>
      </> : <>
        <p className="text-sm leading-6">新密碼需為不易猜測的 12～128 個字元。重設連結只能使用一次。</p>
        {ready && <form onSubmit={reset} className="space-y-4">
          <label className="block text-sm font-medium">新密碼
            <input aria-label="新密碼" type="password" autoComplete="new-password" required minLength={12} maxLength={128}
              value={password} onChange={event => setPassword(event.target.value)}
              className="mt-2 w-full rounded-lg border px-3 py-2.5" />
          </label>
          <label className="block text-sm font-medium">再次輸入新密碼
            <input aria-label="再次輸入新密碼" type="password" autoComplete="new-password" required minLength={12} maxLength={128}
              value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)}
              className="mt-2 w-full rounded-lg border px-3 py-2.5" />
          </label>
          <button disabled={busy} className="w-full rounded-lg bg-slate-900 p-3 font-medium text-white disabled:opacity-50">
            {busy ? "正在更新…" : "儲存新密碼"}
          </button>
        </form>}
        {!ready && !error && <p role="status" className="text-sm">正在驗證連結…</p>}
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        <Link href="/forgot-password" className="block text-center text-sm underline">重新申請連結</Link>
      </>}
    </section>
  </main>;
}
