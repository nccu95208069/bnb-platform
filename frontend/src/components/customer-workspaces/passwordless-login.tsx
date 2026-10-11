"use client";
import { customerReturnPath } from "@/lib/customer-workspaces/return-path";
import { useRef, useState } from "react";
import { api, button, field, secondary } from "./client";
import { useCommand } from "./use-command";
export function PasswordlessLogin({
  destination = "start",
  initialEmail = "",
  fixedEmail = false,
  googleConfigured = false,
}: {
  destination?: "start" | "calendar";
  initialEmail?: string;
  fixedEmail?: boolean;
  googleConfigured?: boolean;
}) {
  const [email, setEmail] = useState(initialEmail),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [preparing, setPreparing] = useState(false);
  const request = useCommand("/api/customer-login"),
    running = useRef(false);
  const locked = preparing || request.busy || request.uncertain;
  async function send(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (running.current || preparing || request.busy) return;
    running.current = true;
    setPreparing(true);
    setError("");
    try {
      await api("/api/customer-login", "POST", { action: "prepare" });
      const result = await request.execute<{ detail: string }>({
        action: "request",
        email,
        destination,
        ...(destination === "start" ? { returnPath: customerReturnPath(new URLSearchParams(location.search).get("next")) ?? undefined } : {}),
      });
      if (result) setNotice(result.data.detail);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      running.current = false;
      setPreparing(false);
    }
  }
  async function google() {
    if (locked || running.current) return;
    running.current = true;
    setPreparing(true);
    setError("");
    try {
      const result = await api<{ url: string }>("/api/customer-login", "POST", {
        action: "google",
        returnPath: customerReturnPath(new URLSearchParams(location.search).get("next")) ?? undefined,
      });
      window.location.assign(result.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      running.current = false;
      setPreparing(false);
    }
  }
  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <h2 className="text-lg font-semibold">
        {destination === "calendar"
          ? "確認信箱，接著保存這份預覽"
          : "免密碼登入"}
      </h2>
      <p className="text-sm leading-6 text-slate-600">
        {destination === "calendar"
          ? "預覽會在伺服器暫存一小時，並綁定目前的瀏覽器。開啟登入連結後，仍需由你確認保存；不需要重新上傳或設定密碼。"
          : "使用登入連結回到自己的旅宿工作區，不需要另設密碼。"}
      </p>
      {destination === "start" && googleConfigured && (
        <button
          type="button"
          className={secondary}
          disabled={locked}
          onClick={() => void google()}
        >
          使用 Google 登入
        </button>
      )}
      <form onSubmit={send} className="space-y-4">
        <label className="block">
          登入信箱
          <input
            className={field}
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            disabled={locked}
            readOnly={fixedEmail}
            onChange={(e) => {
              setEmail(e.target.value);
              setNotice("");
            }}
          />
        </label>
        <button className={button} disabled={locked}>
          {preparing || request.busy
            ? "正在處理…"
            : notice
              ? "重新申請登入連結"
              : "寄送登入連結"}
        </button>
      </form>
      <p className="text-xs leading-6 text-slate-500">
        連結有效 15 分鐘，請在剛才操作的同一個瀏覽器開啟。
      </p>
      {notice && (
        <p
          role="status"
          className="rounded-xl bg-teal-50 p-3 text-sm leading-6"
        >
          {notice}
        </p>
      )}
      {(error || request.error) && (
        <p
          role="alert"
          className="rounded-xl bg-red-50 p-3 text-sm text-red-800"
        >
          {error || request.error}
        </p>
      )}
      {request.uncertain && (
        <div className="rounded-xl bg-amber-50 p-3 text-sm">
          <p>寄送結果尚待確認。請先查看信箱；重試會查詢同一封登入信。</p>
          <button
            className={`${secondary} mt-2`}
            disabled={preparing || request.busy}
            onClick={() => void send()}
          >
            確認同一封登入信
          </button>
        </div>
      )}
    </section>
  );
}
