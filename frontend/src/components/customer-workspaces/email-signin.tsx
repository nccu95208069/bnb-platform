"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, button, field, secondary } from "./client";
import { useCommand } from "./use-command";
export function EmailSignIn() {
  const router = useRouter(), token = useRef(""), loaded = useRef(false),
    command = useCommand("/api/customer-login");
  const { setError } = command;
  const [info, setInfo] = useState<{ email: string; sameDevice: boolean } | null>(null);
  const [ready, setReady] = useState(false), [pairingCode, setPairingCode] = useState("");
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true;
      token.current = window.location.hash.slice(1);
      window.history.replaceState(null, "", "/signin");
    }
    let active = true;
    async function inspect() {
      if (!/^(?:v2\.)?[\w-]{36}\.[\w-]{43}$/.test(token.current)) {
        setError("沒有可用的登入連結。請重新開啟信件中的完整連結，或回登入頁申請新連結。");
        return;
      }
      if (!token.current.startsWith("v2.")) { if (active) setReady(true); return; }
      try {
        await api("/api/customer-login", "POST", { action: "prepare" });
        const result = await api<{ email: string; sameDevice: boolean }>("/api/customer-login", "POST", { action: "inspect", token: token.current });
        if (active) { setInfo(result); setReady(true); }
      } catch (error) { if (active) setError((error as Error).message); }
    }
    void inspect();
    return () => { active = false; };
  }, [setError]);
  async function signIn(mode: "current" | "both") {
    if (!ready || !token.current) return;
    if (mode === "both" && !/^\d{6}$/.test(pairingCode.trim())) {
      command.setError("請輸入原裝置顯示的 6 位確認碼，或選擇只登入這台裝置。");
      return;
    }
    const result = await command.execute<{ url: string }>({
      action: "consume", token: token.current, mode, pairingCode: pairingCode.trim(),
    });
    if (result) router.replace(result.data.url);
  }
  return (
    <main className="min-h-dvh bg-stone-50 px-5 py-12 text-slate-900">
      <section className="mx-auto max-w-lg space-y-5 rounded-2xl border bg-white p-6">
        <h1 className="text-2xl font-semibold">確認登入旅宿工作區</h1>
        <p className="leading-7 text-slate-600">確認以下信箱後，即可繼續。若有日曆預覽，請回原裝置確認保存。</p>
        {info && <strong className="block break-words">{info.email}</strong>}
        {info && !info.sameDevice && <label className="block space-y-2">
          <span>原裝置顯示的 6 位確認碼</span>
          <input className={field} inputMode="numeric" autoComplete="off" maxLength={6} pattern="[0-9]{6}" placeholder="000000"
            value={pairingCode} disabled={command.busy || command.uncertain} onChange={event => setPairingCode(event.target.value)} />
          <span className="block text-sm leading-6 text-slate-600">輸入後，這台裝置與原本申請的裝置都會登入。原裝置請保留登入頁。</span>
        </label>}
        <button className={button} disabled={!ready || command.busy}
          onClick={() => void signIn(info && !info.sameDevice ? "both" : "current")}>
          {command.busy ? "正在驗證…" : command.uncertain ? "重試並確認登入結果" : info && !info.sameDevice ? "確認兩台裝置登入" : "確認登入並繼續"}
        </button>
        {info && !info.sameDevice && !command.uncertain && <button className={secondary} disabled={!ready || command.busy}
          onClick={() => void signIn("current")}>只登入這台裝置</button>}
        {command.error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-800">{command.error}</p>}
        <a className="block text-sm text-teal-800 underline" href="/start">回登入頁</a>
      </section>
    </main>
  );
}
