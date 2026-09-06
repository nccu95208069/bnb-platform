"use client";
import { useEffect, useState } from "react";
export function CalendarPrivacy({ authenticated }: { authenticated: boolean }) {
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener("pageshow", refresh);
    return () => window.removeEventListener("pageshow", refresh);
  }, []);
  async function logout() {
    const response = await fetch("/api/calendar-session", { method: "DELETE" }).catch(() => null);
    if (!response?.ok) { setError("登出未完成，請再試一次。"); return; }
    window.location.replace("/calendar");
  }
  return <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-xs">
    <span>{authenticated ? "私人檢視 · 旅客姓名已開放" : "目前未登入 · 旅客姓名已隱藏"}</span>
    {authenticated ? <span className="flex gap-3"><a href="/calendar-password" className="underline">變更私人密碼</a><button onClick={logout} className="underline">登出</button></span> : <a href="/calendar-access" className="font-medium underline">登入查看姓名</a>}
    {error && <span role="alert" className="text-red-700">{error}</span>}
  </div>;
}
