"use client";
import { useEffect, useState } from "react";
import {
  isCalendarKind,
  CALENDAR_LABELS,
} from "@/lib/customer-workspaces/calendar-types";
import { api, button, secondary, field } from "../customer-workspaces/client";
import type { IntakeRecord } from "@/lib/customer-intake/types";
import type { Journey } from "@/lib/customer-intake/onboarding";
import type { Delivery } from "@/lib/customer-intake/delivery";
import type { SupportRequest } from "@/lib/customer-workspaces/support";
type Application = {
  record: IntakeRecord;
  journey: Journey | null;
  receipt: Delivery | null;
};
const statuses = {
  verify_email: "等待客戶確認信箱",
  review: "等待讀取來源並確認格式",
  mapping: "等待客戶確認格式",
  help: "需要專人協助",
  partial: "已部分匯入，仍有資料待核對",
  ready: "日曆已建立",
};
export function OnboardingAdmin() {
  const [support, setSupport] = useState<SupportRequest[]>([]);
  const [items, setItems] = useState<Application[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [messages, setMessages] = useState<Record<string, string>>({});
  async function refresh() {
    const result = await api<{
      applications: Application[];
      support?: SupportRequest[];
    }>("/api/onboarding-admin");
    setItems(result.applications);
    setSupport(result.support ?? []);
    setLoaded(true);
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function act(id: string, action: string) {
    setBusy(true);
    setError("");
    try {
      await api("/api/onboarding-admin", "POST", {
        id,
        action,
        message: messages[id],
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-dvh bg-stone-50 p-5 text-slate-900 sm:p-10">
      <div className="mx-auto max-w-4xl">
        <a href="/calendar" className="text-sm underline">
          回營運日曆
        </a>
        <h1 className="my-5 text-2xl font-semibold">客戶加入申請</h1>
        <p className="mb-5 text-sm text-slate-600">
          顯示最近 50
          筆申請。系統讀取客戶提供的來源，再核對格式與匯入結果；不比對 Sheet
          擁有者與申請信箱。
        </p>
        {error && (
          <div role="alert" className="my-4 rounded-xl bg-red-50 p-4">
            <p>{error}</p>
            <a className="underline" href="/calendar-access">
              管理者登入
            </a>
          </div>
        )}
        <button
          disabled={busy}
          className={secondary}
          onClick={() => refresh().catch((e) => setError(e.message))}
        >
          重新整理
        </button>
        {loaded && !items.length && <p className="my-5">目前沒有申請。</p>}
        {support.length > 0 && (
          <section className="my-8">
            <h2 className="text-xl font-semibold">新增旅宿與資料格式協助</h2>
            {support.map((request) => (
              <article
                key={request.id}
                className="my-4 space-y-3 rounded-2xl border bg-white p-5"
              >
                <h3 className="font-semibold">
                  {request.propertyName} ·{" "}
                  {request.kind === "source" ? "來源連結協助" : "格式核對"}
                </h3>
                <p className="text-sm">
                  {request.email} ·{" "}
                  {request.status === "open"
                    ? "待處理"
                    : request.status === "approved"
                      ? "來源已連結"
                      : request.status === "replied"
                        ? "已回覆"
                        : "已完成"}
                </p>
                <p className="whitespace-pre-wrap">{request.message}</p>
                {request.sheetUrl && (
                  <a
                    className="block break-all text-sm underline"
                    href={request.sheetUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    開啟待核對的試算表
                  </a>
                )}
                {request.response && (
                  <p className="text-sm whitespace-pre-wrap">
                    上次回覆：{request.response}
                  </p>
                )}
                <label className="block text-sm">
                  要寄給客戶的核對說明
                  <textarea
                    className={field}
                    maxLength={1000}
                    value={messages[request.id] ?? ""}
                    onChange={(e) =>
                      setMessages({ ...messages, [request.id]: e.target.value })
                    }
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  {request.kind === "source" &&
                    request.status !== "approved" && (
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => act(request.id, "source-approve")}
                      >
                        重新讀取來源並通知客戶
                      </button>
                    )}
                  <button
                    className={secondary}
                    disabled={busy || !messages[request.id]?.trim()}
                    onClick={() => act(request.id, "support-reply")}
                  >
                    保存並寄出說明
                  </button>
                  <button
                    className={secondary}
                    disabled={busy || request.status === "resolved"}
                    onClick={() => act(request.id, "support-resolve")}
                  >
                    標記協助完成並通知
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
        {items.map(({ record: r, journey: j, receipt }) => (
          <article
            key={r.id}
            className="my-5 space-y-3 rounded-2xl border bg-white p-5"
          >
            <h2 className="text-xl font-semibold">
              {r.answers.propertyName || "諮詢需求"}
            </h2>
            <p>
              {r.answers.contactName} · {r.answers.email}
            </p>
            <p className="text-sm">{r.answers.phone || "未填電話／LINE"}</p>
            <p>
              {j ? statuses[j.status] : "諮詢待回覆"} ·{" "}
              {new Date(r.createdAt).toLocaleString("zh-TW", {
                timeZone: "Asia/Taipei",
              })}
            </p>
            <p className="text-sm">
              申請人確認信：
              {receipt?.status === "accepted"
                ? "寄信服務已接受"
                : receipt?.status === "preview"
                  ? "測試未寄信"
                  : "待確認／需重寄"}
            </p>
            <p className="text-sm">
              旅宿型態：{r.answers.kind || "未填"} · 房間：
              {r.answers.rooms.join("、") || "未填"}
            </p>
            <p className="text-sm">
              來源：
              {isCalendarKind(r.answers.source)
                ? CALENDAR_LABELS[r.answers.source]
                : r.answers.source === "sheet"
                  ? "Google Sheet"
                  : "其他／待確認"}
            </p>
            {r.answers.sheetUrl && (
              <a
                className="block break-all text-sm underline"
                href={r.answers.sheetUrl}
                target="_blank"
                rel="noreferrer"
              >
                查看申請人提供的 Sheet
              </a>
            )}
            {j?.message && (
              <p className="whitespace-pre-wrap rounded-xl bg-amber-50 p-3 text-sm">
                待處理事項：{j.message}
              </p>
            )}
            {j?.readyAt && (
              <p className="text-sm">
                已匯入 {j.importedCount ?? 0} 筆；待核對 {j.excludedCount ?? 0}{" "}
                列。
              </p>
            )}
            {r.answers.note && (
              <p className="whitespace-pre-wrap text-sm">{r.answers.note}</p>
            )}
            <div className="flex flex-wrap gap-3">
              <button
                className={secondary}
                disabled={busy}
                onClick={() => act(r.id, "resend")}
              >
                重寄申請人確認信
              </button>
              {r.answers.source === "sheet" &&
                j?.verifiedAt &&
                !j.approvedAt && (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => act(r.id, "approve")}
                  >
                    重新讀取來源，通知客戶確認格式
                  </button>
                )}
            </div>
            {j && (
              <details>
                <summary className="cursor-pointer text-sm underline">
                  需要客戶補充資料
                </summary>
                <label className="mt-3 block text-sm">
                  請具體說明需要核對的欄位或問題
                  <textarea
                    className={field}
                    maxLength={1000}
                    value={messages[r.id] ?? ""}
                    onChange={(e) =>
                      setMessages({ ...messages, [r.id]: e.target.value })
                    }
                  />
                </label>
                <button
                  className={`${secondary} mt-3`}
                  disabled={busy || !messages[r.id]?.trim()}
                  onClick={() => act(r.id, "help")}
                >
                  保存待補資料說明
                </button>
              </details>
            )}
            <p className="break-all text-xs text-slate-500">申請編號：{r.id}</p>
          </article>
        ))}
      </div>
    </main>
  );
}
