"use client";
import {useT} from "@/components/i18n/language-provider";
import { useEffect, useState } from "react";
import { ROLE_DEFINITIONS, useAccessControl } from "@/lib/access-control";
export function CalendarPrivacy({ authenticated }: { authenticated: boolean }) {
  const uiText = useT();

  const [error, setError] = useState("");
  const membership = useAccessControl(state => state.membership);
  const previewRole = useAccessControl(state => state.previewRole);
  const setPreviewRole = useAccessControl(state => state.setPreviewRole);
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
    <span>{authenticated ? uiText("私人檢視 · 旅客姓名已開放") : uiText("目前未登入 · 旅客姓名已隱藏")}</span>
    {authenticated ? <span className="flex gap-3"><a href="/calendar-password" className="underline">{uiText("變更密碼")}</a><button onClick={logout} className="underline">{uiText("登出")}</button></span> : <a href="/calendar-access" className="font-medium underline">{uiText("登入帳號")}</a>}
    {authenticated && membership?.role === "owner" && previewRole && <div role="status" className="flex w-full flex-wrap items-center justify-between gap-2 border-t pt-2 text-amber-900">
      <span>{uiText("權限預覽：")}{uiText(ROLE_DEFINITIONS[previewRole].label)}{previewRole === "viewer_no_price" ? uiText(" · 房費暫時隱藏") : ""}</span>
      <button className="min-h-9 font-medium underline" onClick={() => setPreviewRole(null)}>{uiText("恢復管理員檢視")}</button>
    </div>}
    {error && <span role="alert" className="text-red-700">{uiText(error)}</span>}
  </div>;
}
