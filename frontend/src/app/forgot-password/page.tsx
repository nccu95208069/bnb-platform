"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/calendar-password-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", email }),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "暫時無法寄送，請稍後再試。");
      setNotice(result.detail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暫時無法寄送，請稍後再試。");
    } finally {
      setBusy(false);
    }
  }

  return <main className="flex min-h-dvh items-center justify-center bg-slate-50 p-5">
    <section className="w-full max-w-sm space-y-5 rounded-2xl border bg-white p-6">
      <h1 className="text-xl font-semibold">重設既有日曆密碼</h1>
      <p className="text-sm leading-6">輸入既有兩館日曆的登入信箱。若帳號已啟用，我們會寄出 30 分鐘有效的一次性連結，讓你自行設定新密碼。</p>
      <form onSubmit={requestLink} className="space-y-4">
        <label className="block text-sm font-medium">登入信箱
          <input aria-label="登入信箱" type="email" autoComplete="email" required maxLength={254}
            value={email} onChange={event => setEmail(event.target.value)}
            className="mt-2 w-full rounded-lg border px-3 py-2.5" />
        </label>
        <button disabled={busy} className="w-full rounded-lg bg-slate-900 p-3 font-medium text-white disabled:opacity-50">
          {busy ? "正在處理…" : "寄送重設連結"}
        </button>
      </form>
      {notice && <p role="status" className="rounded-lg bg-teal-50 p-3 text-sm">{notice}</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <Link href="/calendar-access" className="block text-center text-sm underline">返回既有日曆登入</Link>
    </section>
  </main>;
}
