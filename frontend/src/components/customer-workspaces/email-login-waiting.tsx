"use client";
import { useEffect, useState } from "react";
import { api } from "./client";

export type EmailLoginChallenge = { requestKey: string; pairingCode: string; expiresAt: number };
export function EmailLoginWaiting({ challenge }: { challenge: EmailLoginChallenge }) {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!active) return;
      if (Date.now() >= challenge.expiresAt) { setNotice("登入連結已過期，請重新寄送。"); return; }
      if (document.visibilityState === "hidden") { timer = setTimeout(poll, 5000); return; }
      try {
        const data = await api<{ status?: string; url?: string }>("/api/customer-login", "POST", { action: "poll", requestKey: challenge.requestKey });
        if (!active) return;
        if (data.url) { window.location.assign(data.url); return; }
        if (data.status === "other_device") { setNotice("已在另一台裝置登入。要登入這台裝置，請重新寄送登入連結。"); return; }
      } catch (error) {
        if (!active) return;
        const status = error instanceof Error && "status" in error ? Number(error.status) : 0;
        if (status >= 400 && status < 500) { setNotice((error as Error).message); return; }
        setNotice("連線暫時中斷，恢復後會繼續查詢驗證結果。");
      }
      timer = setTimeout(poll, 5000);
    }
    timer = setTimeout(poll, 5000);
    return () => { active = false; clearTimeout(timer); };
  }, [challenge.requestKey, challenge.expiresAt]);
  return <section className="space-y-3 rounded-xl border border-teal-200 bg-teal-50 p-4" aria-label="跨裝置登入確認">
    <p className="text-sm leading-6">在手機開啟登入信後，輸入下方確認碼，即可讓這台裝置接續登入。</p>
    <strong className="block text-3xl tracking-[0.25em] tabular-nums" aria-label="原裝置確認碼">{challenge.pairingCode}</strong>
    <p className="text-xs leading-6 text-slate-600">請保留此頁，驗證完成後會自動繼續。確認碼只輸入在你剛開啟的驗證頁。</p>
    {notice && <p role="status" className="text-sm">{notice}</p>}
  </section>;
}
