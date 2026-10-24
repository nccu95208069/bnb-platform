"use client";
import { useEffect, useRef, useState } from "react";
import { api, button } from "./client";
import { EmailCodeInput } from "./email-code-input";

export type EmailLoginChallenge = { requestKey: string; codeRequired?: boolean; expiresAt: number; email?: string };
const storageKey = (scope: string) => `customer-email-code:${scope}`;
export function saveEmailChallenge(scope: string, challenge: EmailLoginChallenge | null) {
  try { if (challenge) localStorage.setItem(storageKey(scope), JSON.stringify({ requestKey: challenge.requestKey, codeRequired: true, expiresAt: challenge.expiresAt, email: challenge.email })); else localStorage.removeItem(storageKey(scope)); } catch { /* Login still works when storage is unavailable. */ }
}
export function loadEmailChallenge(scope: string): EmailLoginChallenge | null {
  try { const value = JSON.parse(localStorage.getItem(storageKey(scope)) || "null"); if (value?.codeRequired && /^[\w-]{36}$/.test(value.requestKey) && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now()) return value; } catch { /* Missing or invalid metadata cannot authenticate. */ }
  saveEmailChallenge(scope, null); return null;
}
export function EmailLoginWaiting({ challenge, scope }: { challenge: EmailLoginChallenge; scope: string }) {
  const [notice, setNotice] = useState(""), [code, setCode] = useState(""), [busy, setBusy] = useState(false), [ended, setEnded] = useState(false);
  const running = useRef(false);
  function finish(url: string) { saveEmailChallenge(scope, null); window.location.assign(url); }
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!active) return;
      if (Date.now() >= challenge.expiresAt) { setNotice("登入碼已過期，請重新寄送。"); setEnded(true); saveEmailChallenge(scope, null); return; }
      if (document.visibilityState === "hidden" || running.current) { timer = setTimeout(poll, 5000); return; }
      try {
        const data = await api<{ status?: string; url?: string }>("/api/customer-login", "POST", { action: "poll", requestKey: challenge.requestKey });
        if (!active) return;
        if (data.url) { saveEmailChallenge(scope, null); window.location.assign(data.url); return; }
        if (data.status === "other_device") { setNotice("已在另一台裝置登入。要登入這台裝置，請重新寄送登入碼。"); setEnded(true); saveEmailChallenge(scope, null); return; }
      } catch (error) {
        if (!active) return;
        const status = error instanceof Error && "status" in error ? Number(error.status) : 0;
        if (status >= 400 && status < 500) { setNotice((error as Error).message); setEnded(true); saveEmailChallenge(scope, null); return; }
        setNotice("連線暫時中斷，恢復後會繼續查詢驗證結果。");
      }
      timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [challenge.requestKey, challenge.expiresAt, scope]);
  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (running.current || ended) return;
    if (!/^\d{6}$/.test(code)) { setNotice("請輸入信件中的 6 位登入碼。"); return; }
    running.current = true; setBusy(true); setNotice("");
    try { const data = await api<{ url: string }>("/api/customer-login", "POST", { action: "consume-code", requestKey: challenge.requestKey, loginCode: code }); finish(data.url); }
    catch (error) { setNotice((error as Error).message); }
    finally { running.current = false; setBusy(false); }
  }
  return <section className="space-y-3 rounded-xl border border-teal-200 bg-teal-50 p-4" aria-label="輸入登入碼">
    <p className="text-sm leading-6">登入碼已寄到{challenge.email || "你的信箱"}，請輸入信件中的 6 位數字。</p>
    <form onSubmit={verify} className="space-y-3"><EmailCodeInput value={code} onChange={setCode} disabled={busy || ended} /><button className={button} disabled={busy || ended}>{busy ? "正在驗證…" : "登入並繼續"}</button></form>
    <p className="text-xs leading-6 text-slate-600">15 分鐘內有效。也可以用手機開啟信中連結並選擇「登入兩台裝置」。若已關閉此頁，在有效期限內用原瀏覽器重新開啟即可接續。</p>
    {notice && <p role="status" className="text-sm">{notice}</p>}
  </section>;
}
