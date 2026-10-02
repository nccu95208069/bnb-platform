"use client";
import { useEffect, useRef, useState } from "react";
import { api, button, field } from "./client";
type Info = {
  email: string;
  workspace: string;
  role: string;
  properties: string[];
  existingAccount: boolean;
  accepted: boolean;
};
export function InvitationSetup() {
  const initialized = useRef(false),
    [token, setToken] = useState(""),
    [info, setInfo] = useState<Info | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const value = location.hash.slice(1);
    history.replaceState(null, "", location.pathname);
    if (!value) {
      setError("請使用協作邀請信中的完整連結。");
      return;
    }
    setToken(value);
    api<Info>("/api/customer-invitation", "POST", {
      action: "info",
      token: value,
    })
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ destination: string }>(
        "/api/customer-invitation",
        "POST",
        {
          action: "accept",
          token,
          password: form.get("password"),
          confirmPassword: form.get("confirmPassword"),
        },
      );
      location.assign(result.destination);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-dvh bg-stone-50 px-5 py-14 text-slate-900">
      <section className="mx-auto max-w-lg rounded-2xl border bg-white p-7">
        <h1 className="text-2xl font-semibold">加入旅宿協作</h1>
        {error && (
          <p role="alert" className="my-4 rounded-xl bg-red-50 p-4">
            {error}
          </p>
        )}
        {info ? (
          <form onSubmit={submit} className="mt-5 space-y-5">
            <p>
              {info.email} 受邀加入 <strong>{info.workspace}</strong>
            </p>
            <p>角色：{info.role}</p>
            <p>可使用：{info.properties.join("、")}</p>
            <p className="text-sm text-slate-600">
              {info.existingAccount
                ? "使用原帳號密碼確認加入，原本的旅宿與密碼會保留。"
                : "請設定 12～128 字元密碼。之後用本信箱登入即可查看有權限的旅宿。"}
            </p>
            <label className="block">
              {info.existingAccount ? "目前密碼" : "新密碼"}
              <input
                className={field}
                name="password"
                type="password"
                autoComplete={
                  info.existingAccount ? "current-password" : "new-password"
                }
                minLength={info.existingAccount ? undefined : 12}
                maxLength={128}
                required
                disabled={busy}
              />
            </label>
            {!info.existingAccount && (
              <label className="block">
                再次輸入密碼
                <input
                  className={field}
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  disabled={busy}
                />
              </label>
            )}
            <button className={button} disabled={busy}>
              {busy ? "確認中…" : "確認加入，開啟日曆"}
            </button>
          </form>
        ) : !error ? (
          <p className="my-5">確認邀請中…</p>
        ) : null}
        <a href="/start" className="mt-6 block text-sm underline">
          回登入頁／忘記密碼
        </a>
      </section>
    </main>
  );
}
