"use client";
import {useT} from "@/components/i18n/language-provider";
import { useEffect } from "react";
import { ROLE_DEFINITIONS, useAccessControl } from "@/lib/access-control";
export function CalendarPrivacy({ authenticated }: { authenticated: boolean }) {
  const uiText = useT();

  const membership = useAccessControl(state => state.membership);
  const previewRole = useAccessControl(state => state.previewRole);
  const setPreviewRole = useAccessControl(state => state.setPreviewRole);
  useEffect(() => {
    const refresh = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener("pageshow", refresh);
    return () => window.removeEventListener("pageshow", refresh);
  }, []);
  if (authenticated) {
    return membership?.role === "owner" && previewRole ? <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-900">
      <span>{uiText("權限預覽：")}{uiText(ROLE_DEFINITIONS[previewRole].label)}{previewRole === "viewer_no_price" ? uiText(" · 房費暫時隱藏") : ""}</span>
      <button className="min-h-9 font-medium underline" onClick={() => setPreviewRole(null)}>{uiText("恢復管理員檢視")}</button>
    </div> : null;
  }
  return <a href="/calendar-access" className="text-xs font-medium underline">{uiText("登入帳號")}</a>;
}
