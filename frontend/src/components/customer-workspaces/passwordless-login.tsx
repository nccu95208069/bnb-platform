"use client";
import { customerReturnPath } from "@/lib/customer-workspaces/return-path";
import { useEffect, useRef, useState } from "react";
import { api, button, field, secondary } from "./client";
import { useCommand } from "./use-command";
import { EmailLoginWaiting, loadEmailChallenge, saveEmailChallenge, type EmailLoginChallenge } from "./email-login-waiting";
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
    [challenge, setChallenge] = useState<EmailLoginChallenge | null>(null),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [preparing, setPreparing] = useState(false);
  const scope = `passwordless:${destination}`;
  useEffect(() => { const saved = loadEmailChallenge(scope); if (saved && (!fixedEmail || saved.email === initialEmail)) { setChallenge(saved); if (saved.email) setEmail(saved.email); } }, [scope, fixedEmail, initialEmail]);
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
      const result = await request.execute<{ detail: string } & EmailLoginChallenge>({
        action: "request",
        protocol: "code-v3",
        email,
        destination,
        ...(destination === "start" ? { returnPath: customerReturnPath(new URLSearchParams(location.search).get("next")) ?? undefined } : {}),
      });
      if (result) {
        setNotice(result.data.detail);
        const next = result.data.codeRequired ? { ...result.data, email: email.trim() } : null;
        setChallenge(next); saveEmailChallenge(scope, next);
      }
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
          : "用信箱登入"}
      </h2>
      <p className="text-sm leading-6 text-slate-600">
        {destination === "calendar"
          ? "預覽會暫存一小時。可在手機驗證信箱，再回到這台裝置確認保存。"
          : "輸入可收信的電子信箱，輸入信件中的登入碼即可繼續。"}
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
              setChallenge(null); saveEmailChallenge(scope, null);
            }}
          />
        </label>
        <button className={button} disabled={locked}>
          {preparing || request.busy
            ? "正在處理…"
            : notice
              ? "重新寄送登入碼"
              : "寄送登入碼"}
        </button>
      </form>
      <p className="text-xs leading-6 text-slate-500">
        登入碼有效 15 分鐘，可使用電腦或手機開啟。
      </p>
      {challenge && <EmailLoginWaiting key={challenge.requestKey} challenge={challenge} scope={scope} />}
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
