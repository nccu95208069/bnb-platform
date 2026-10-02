"use client";
import { useEffect, useState, useRef } from "react";
import { api, button, field } from "./client";
export function AccountSetup() {
  const initialized = useRef(false);
  const [token, setToken] = useState(""),
    [info, setInfo] = useState<{ email: string; purpose: string } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const value = location.hash.slice(1);
    if (!value) {
      setError("請使用確認信中的完整連結。");
      return;
    }
    setToken(value);
    history.replaceState(null, "", location.pathname);
    api<{ email: string; purpose: string }>("/api/customer-account", "POST", {
      action: "info",
      token: value,
    })
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(e.currentTarget);
    try {
      const result = await api<{ destination: string }>(
        "/api/customer-account",
        "POST",
        {
          action: "activate",
          token,
          password: data.get("password"),
          confirmPassword: data.get("confirmPassword"),
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
        <a href="/join" className="text-sm underline">
          旅宿服務
        </a>
        <h1 className="my-5 text-2xl font-semibold">
          {info?.purpose === "recovery"
            ? "重新設定密碼"
            : "確認信箱，設定登入密碼"}
        </h1>
        {error && (
          <p role="alert" className="my-4 rounded-xl bg-red-50 p-4">
            {error}
          </p>
        )}
        {info ? (
          <form onSubmit={submit} className="space-y-5">
            <p>{info.email}</p>
            <p className="text-sm text-slate-600">
              請設定 12～128 字元的密碼。密碼只由你保管，服務人員無法查看。
            </p>
            <label className="block">
              新密碼
              <input
                className={field}
                type="password"
                name="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </label>
            <label className="block">
              再次輸入密碼
              <input
                className={field}
                type="password"
                name="confirmPassword"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </label>
            <button className={button} disabled={busy}>
              {busy ? "處理中…" : "確認並繼續"}
            </button>
          </form>
        ) : !error ? (
          <p>確認連結中…</p>
        ) : null}
        <a className="mt-6 block text-sm underline" href="/start">
          回登入頁／忘記密碼
        </a>
      </section>
    </main>
  );
}
