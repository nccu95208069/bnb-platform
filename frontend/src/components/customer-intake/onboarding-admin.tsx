"use client";
import { useEffect, useState } from "react";
import { api, button, secondary, field } from "../customer-workspaces/client";
import type { IntakeRecord } from "@/lib/customer-intake/types";
import type { Journey } from "@/lib/customer-intake/onboarding";
import type { Delivery } from "@/lib/customer-intake/delivery";
type Application = {
  record: IntakeRecord;
  journey: Journey | null;
  receipt: Delivery | null;
};
const statuses = {
  verify_email: "等待客戶確認信箱",
  review: "等待核對資料權限",
  mapping: "等待客戶確認格式",
  help: "需要專人協助",
  partial: "已部分匯入，仍有資料待核對",
  ready: "日曆已建立",
};
export function OnboardingAdmin() {
  const [items, setItems] = useState<Application[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [identity, setIdentity] = useState<Record<string, boolean>>({}),
    [messages, setMessages] = useState<Record<string, string>>({});
  async function refresh() {
    const result = await api<{ applications: Application[] }>(
      "/api/onboarding-admin",
    );
    setItems(result.applications);
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
        confirmIdentity: identity[id] === true,
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
          筆申請。分享勾勾只代表可讀取；身分、格式與匯入結果分開核對。
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
            {j?.verifiedAt && !j.approvedAt && (
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={identity[r.id] ?? false}
                  onChange={(e) =>
                    setIdentity({ ...identity, [r.id]: e.target.checked })
                  }
                />
                已核對此申請人確實有權使用這份試算表；同意開放給此帳號確認格式。
              </label>
            )}
            <div className="flex flex-wrap gap-3">
              <button
                className={secondary}
                disabled={busy}
                onClick={() => act(r.id, "resend")}
              >
                重寄申請人確認信
              </button>
              {j?.verifiedAt && !j.approvedAt && (
                <button
                  className={button}
                  disabled={busy || !identity[r.id]}
                  onClick={() => act(r.id, "approve")}
                >
                  核對通過，通知客戶確認格式
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
