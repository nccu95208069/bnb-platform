"use client";
import { useEffect, useRef, useState } from "react";
import { api, button, field, secondary } from "./client";
import { standardSheetErrors } from "@/lib/customer-workspaces/standard-sheet-messages";
type Status = {
  state: "unlinked" | "synced" | "pending" | "error";
  url?: string;
  workspaceVersion: number;
  exportedVersion?: number;
  synchronizedAt?: string;
  error?: string;
  configured: boolean;
  canCreate: boolean;
  writerEmail: string | null;
};
export function StandardSheetPanel({ slug }: { slug: string }) {
  const endpoint = `/api/customer-workspaces/${slug}/standard-sheet`;
  const [status, setStatus] = useState<Status | null>(null),
    [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const pending = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    let active = true;
    api<Status>(endpoint)
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setStatus(await api<Status>(endpoint));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function run(input: Record<string, unknown>) {
    if (busy) return;
    pending.current ??= input;
    setBusy(true);
    setError("");
    try {
      setStatus(await api<Status>(endpoint, "POST", pending.current));
      pending.current = null;
      setUncertain(false);
    } catch (e) {
      const code = e instanceof Error && "status" in e ? Number(e.status) : 0;
      setError((e as Error).message);
      if (code >= 400 && code < 500) {
        pending.current = null;
        setUncertain(false);
      } else setUncertain(true);
      // The binding may already have committed even if the Sheet reply was lost.
      try {
        setStatus(await api<Status>(endpoint));
      } catch {
        /* Retain last status. */
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-5 rounded-2xl border bg-white p-5">
      <h2 className="text-xl font-semibold">標準帳本</h2>
      <p className="text-sm leading-6 text-slate-600">
        訂單、每房每晚的住宿明細、收付款與來源對照，保存到這個工作區專用的
        Google Sheet。帳本由系統更新；客戶原始 Sheet 保留原樣。
      </p>
      <p className="text-sm text-slate-600">
        完整帳本只在業主介面提供。協作成員繼續使用各自有權限的日曆與收款畫面。
      </p>
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 p-4">
          {error}
        </p>
      )}
      {!status && !error && <p>讀取帳本狀態…</p>}
      {status && (
        <>
          <p
            role="status"
            className={`rounded-xl p-4 ${status.state === "synced" ? "bg-teal-50" : "bg-amber-50"}`}
          >
            {status.state === "unlinked"
              ? "尚未連結標準帳本。"
              : status.state === "synced"
                ? "帳本已更新，並已讀回核對。"
                : status.state === "pending"
                  ? "工作區有新資料，標準帳本尚待更新。"
                  : (standardSheetErrors[status.error ?? ""]?.[1] ??
                    "帳本尚未更新完成，工作區資料仍保留。")}
            {status.synchronizedAt && (
              <span className="mt-2 block text-xs">
                上次完成：
                {new Date(status.synchronizedAt).toLocaleString("zh-TW", {
                  timeZone: "Asia/Taipei",
                })}
              </span>
            )}
          </p>
          <div className="flex flex-wrap gap-3">
            {status.url && (
              <a
                className={secondary}
                href={status.url}
                target="_blank"
                rel="noreferrer"
              >
                開啟標準帳本
              </a>
            )}
            {status.url && (
              <button
                className={button}
                disabled={busy || uncertain}
                onClick={() => void run({ action: "sync" })}
              >
                更新並核對帳本
              </button>
            )}
            {!status.url && status.canCreate && (
              <button
                className={button}
                disabled={busy || uncertain}
                onClick={() => void run({ action: "create" })}
              >
                建立標準帳本
              </button>
            )}
            <a className={secondary} href={`${endpoint}?download=1`}>
              下載標準資料
            </a>
            <button
              className={secondary}
              disabled={busy}
              onClick={() => void refresh()}
            >
              重新查看狀態
            </button>
          </div>
          {!status.url && !status.canCreate && (
            <p className="text-sm">
              服務人員可準備一份空白的標準帳本副本，再連結到此工作區。訂單仍可先匯入、預覽及下載標準資料。
            </p>
          )}
          {!status.url && (
            <details className="rounded-xl border p-4">
              <summary className="cursor-pointer font-medium">
                連結已準備好的標準帳本
              </summary>
              <form
                className="mt-4 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run({ action: "bind", url });
                }}
              >
                <p className="text-sm">
                  請貼上空白標準帳本副本，不要貼客戶原始
                  Sheet。連結後會寫入此工作區的完整訂單。
                </p>
                {status.writerEmail && (
                  <p className="break-all text-sm">
                    將目的帳本的編輯權限分享給：{status.writerEmail}
                  </p>
                )}
                <label className="block">
                  標準帳本副本連結
                  <input
                    type="url"
                    className={field}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    disabled={busy || uncertain}
                    required
                  />
                </label>
                <button
                  className={button}
                  disabled={
                    !status.configured || busy || uncertain || !url.trim()
                  }
                >
                  連結並寫入標準帳本
                </button>
              </form>
            </details>
          )}
        </>
      )}
      {uncertain && (
        <div className="rounded-xl bg-amber-50 p-4">
          <p className="text-sm">
            結果尚未確認，保留原請求重試。這個操作只更新帳本，不會重新登記訂單或付款。
          </p>
          <button
            className={`${button} mt-3`}
            disabled={busy}
            onClick={() => void run(pending.current!)}
          >
            重試相同帳本操作
          </button>
        </div>
      )}
    </section>
  );
}
