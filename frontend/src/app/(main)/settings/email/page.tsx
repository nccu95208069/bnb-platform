"use client";

import { useT } from "@/components/i18n/language-provider";
import { useEffect, useState, type FormEvent } from "react";

type MailState = {
  configured: boolean;
  sender: string | null;
  verifiedAt: string | null;
  method?: string | null;
  oauthRequired: boolean;
};

export default function EmailSettings() {
  const uiText = useT();
  const [state, setState] = useState<MailState | null>(null);
  const [appPassword, setAppPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/workspace-mail", { cache: "no-store" })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail);
        setState(body);
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : "寄信狀態讀取失敗"));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/workspace-mail", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appPassword }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail);
      setState(body);
      setAppPassword("");
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "寄信設定未完成");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-xl space-y-5 rounded-2xl border bg-card p-5">
      <h1 className="text-xl font-semibold">{uiText("Gmail 寄信設定")}</h1>
      {error && <p role="alert" className="text-sm text-red-700">{uiText(error)}</p>}
      {!state ? (
        <a className="underline" href="/calendar-access">{uiText("請先以管理者登入")}</a>
      ) : (
        <>
          <p className="text-sm leading-6">
            {uiText(state.oauthRequired ? "候選測試寄件信箱：" : "寄件信箱固定為")}
            <strong>{state.sender ?? uiText("尚未指定")}</strong>
            {uiText("，用於成員邀請及設定密碼的信件。")}
          </p>
          <p className="text-sm">{uiText("狀態：")}{state.configured ? uiText("已連接") : uiText("尚未授權")}</p>
          {state.method === "gmail_oauth" ? (
            <p className="rounded-lg bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
              {uiText("已透過 Google 授權接通寄信，可直接新增成員。你不需要另外設定應用程式密碼。")}
            </p>
          ) : state.oauthRequired ? (
            <p className="rounded-lg bg-amber-50 p-4 text-sm leading-6 text-amber-900">
              {uiText("候選測試寄信尚未完成 Google 授權。請由信箱本人在官方 Google 授權畫面同意後，再由管理者確認寄件信箱及測試信；此處不收取 Gmail 密碼或應用程式密碼。")}
            </p>
          ) : (
            <>
              <ol className="list-decimal space-y-2 pl-5 text-sm leading-6">
                <li>{uiText("以 sweetfuntw@gmail.com 登入 Google，先開啟兩步驟驗證。")}</li>
                <li>{uiText("到")} <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="underline">{uiText("Google 應用程式密碼")}</a> {uiText("建立「Sweetfun OS 寄信」專用密碼。")}</li>
                <li>{uiText("把 Google 提供的 16 碼填在下方。不要填 Gmail 一般登入密碼，也不用傳給我。")}</li>
              </ol>
              <form onSubmit={submit} className="space-y-4">
                <label className="block text-sm font-medium">
                  {uiText("Gmail 應用程式密碼")}
                  <input aria-label={uiText("Gmail 應用程式密碼")} type="password" autoComplete="off" required value={appPassword} onChange={event => setAppPassword(event.target.value)} className="mt-2 block w-full rounded-lg border p-3" />
                </label>
                <p className="text-xs leading-5 text-muted-foreground">{uiText("儲存時會先驗證授權，並寄一封測試信到 sweetfuntw@gmail.com；成功後才開放寄送成員邀請。授權資料會加密保存，不會顯示給其他成員。")}</p>
                <button disabled={busy} className="w-full rounded-lg bg-slate-900 p-3 text-white disabled:opacity-50">{busy ? uiText("驗證與寄送測試信中…") : uiText("儲存並寄測試信")}</button>
              </form>
            </>
          )}
          {saved && <p role="status">{uiText("Gmail 已確認寄出測試信，寄信設定已保存。請到信箱確認收到後，再新增成員。")}</p>}
          <a href="/access" className="block underline">{uiText("回到成員管理")}</a>
        </>
      )}
    </section>
  );
}
