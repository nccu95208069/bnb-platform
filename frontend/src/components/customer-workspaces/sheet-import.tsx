"use client";
import { useRef, useState } from "react";
import type { Property, Workspace } from "@/lib/customer-workspaces/types";
import type {
  ImportPreview,
  Mapping,
} from "@/lib/customer-workspaces/sheet-import";
import { api, button, field, secondary, today } from "./client";
type Batch = NonNullable<Workspace["importBatches"]>[number];
const columnLabels = {
  checkIn: "入住日期",
  checkOut: "退房日期",
  rooms: "房間／包棟",
  guestName: "姓名（選填）",
  externalId: "來源訂單編號（建議）",
  total: "房費（選填）",
  received: "已付／實收（選填）",
};
export function SheetImport({
  slug,
  property,
  configured,
  connected,
  initialBatches,
  initialVersion,
}: {
  slug: string;
  property: Property;
  configured: boolean;
  connected: boolean;
  initialBatches: Batch[];
  initialVersion: number;
}) {
  const [url, setUrl] = useState("");
  const [meta, setMeta] = useState<{
    spreadsheetId: string;
    title: string;
    tabs: { id: number; title: string }[];
  } | null>(null);
  const [tab, setTab] = useState("");
  const [source, setSource] = useState<{
    id: string;
    title: string;
    rows: string[][];
  } | null>(null);
  const [mapping, setMapping] = useState<Mapping>({
    headerRow: 1,
    columns: {
      checkIn: -1,
      checkOut: -1,
      rooms: -1,
      guestName: -1,
      externalId: -1,
      total: -1,
      received: -1,
    },
    roomMap: {},
    granularity: "order",
    amountBasis: "none",
    receivedMeaning: "none",
    currency: "TWD",
    from: today(),
  });
  const [confirmed, setConfirmed] = useState(false),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [selection, setSelection] = useState<number[]>([]);
  const [batches, setBatches] = useState(initialBatches),
    [version, setVersion] = useState(initialVersion),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<Record<string, unknown> | null>(null);
  const endpoint = `/api/customer-workspaces/${slug}/import`;
  const send = <T,>(input: Record<string, unknown>) =>
    api<T>(endpoint, "POST", { ...input, propertyId: property.id });
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function changeMapping(next: Mapping) {
    setMapping(next);
    setPreview(null);
    setSelection([]);
    setConfirmed(false);
  }
  async function commit() {
    if (!preview) return;
    pending.current ??= {
      action: "commit",
      previewId: preview.id,
      selected: selection,
    };
    try {
      const batch = await send<Batch>(pending.current);
      setBatches((old) =>
        old.some((b) => b.id === batch.id) ? old : [...old, batch],
      );
      const current = await api<{ version: number }>(
        `/api/customer-workspaces/${slug}`,
      );
      setVersion(current.version);
      setNotice(
        `已匯入 ${batch.bookingIds.length} 筆訂房。原試算表未變更；往後請在 OS 登記。`,
      );
      setPreview(null);
      setSource(null);
      setUncertain(false);
      pending.current = null;
    } catch (e) {
      const status = e instanceof Error && "status" in e ? Number(e.status) : 0;
      if (status >= 400 && status < 500) {
        pending.current = null;
        setUncertain(false);
      } else setUncertain(true);
      throw e;
    }
  }
  const labels =
    source && mapping.columns.rooms >= 0
      ? [
          ...new Set(
            source.rows
              .slice(mapping.headerRow)
              .map((r) => (r[mapping.columns.rooms] ?? "").trim())
              .filter(Boolean),
          ),
        ]
      : [];
  const columnCount = Math.max(0, ...(source?.rows.map((r) => r.length) ?? []));
  const columns = Array.from({ length: columnCount }, (_, i) => ({
    id: i,
    label: `第 ${i + 1} 欄 · ${source?.rows[mapping.headerRow - 1]?.[i] || "未命名"}`,
  }));
  return (
    <main className="min-h-dvh bg-stone-50 p-4 text-slate-800 sm:p-8">
      <div className="mx-auto max-w-5xl">
        <a className="text-teal-800 underline" href={`/w/${slug}/calendar`}>
          ← 回房況日曆
        </a>
        <h1 className="mt-5 text-2xl font-semibold">
          從 Google Sheet 匯入 · {property.name}
        </h1>
        <p className="my-3 text-slate-600">
          一次匯入，往後以 OS
          為準。只讀取試算表，不會回寫或持續同步，也不會通知客人或關閉 OTA
          房量。
        </p>
        {error && (
          <p role="alert" className="my-4 rounded-xl bg-red-50 p-4">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="my-4 rounded-xl bg-teal-50 p-4">
            {notice}
          </p>
        )}
        {uncertain && (
          <p role="alert" className="my-4 rounded-xl bg-amber-50 p-4">
            寫入結果尚未確認。請按「重試相同匯入」核對；已送出的選擇暫時鎖定。
          </p>
        )}
        <fieldset
          disabled={busy || uncertain}
          className="rounded-2xl border bg-white p-5 disabled:opacity-60"
        >
          <legend className="px-2 font-semibold">1. 連結自己的試算表</legend>
          <p className="mb-3 text-sm">
            Google 唯讀授權約一小時有效。不需公開分享檔案。
          </p>
          {!configured && (
            <p className="mb-3 text-amber-800">
              此測試環境尚未設定 Google 授權，設定完成後即可使用。
            </p>
          )}
          {connected && (
            <p className="mb-3 text-teal-800">
              已完成 Google 授權，可貼上連結。
            </p>
          )}
          <button
            disabled={!configured}
            className={secondary}
            onClick={() =>
              run(async () => {
                const result = await send<{ url: string }>({
                  action: "connect",
                });
                location.assign(result.url);
              })
            }
          >
            連結／切換 Google 帳號
          </button>
          <label className="mt-4 block">
            Google Sheet 連結
            <input
              className={field}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setMeta(null);
                setSource(null);
                setPreview(null);
              }}
              placeholder="https://docs.google.com/spreadsheets/d/…"
            />
          </label>
          <button
            disabled={!configured || !url}
            className={`${secondary} mt-3`}
            onClick={() =>
              run(async () => {
                setSource(null);
                setPreview(null);
                const result = await send<NonNullable<typeof meta>>({
                  action: "tabs",
                  url,
                });
                setMeta(result);
                setTab(String(result.tabs[0]?.id ?? ""));
              })
            }
          >
            讀取分頁
          </button>
          {meta && (
            <div className="mt-4">
              <p>{meta.title}</p>
              <label>
                分頁
                <select
                  className={field}
                  value={tab}
                  onChange={(e) => {
                    setTab(e.target.value);
                    setSource(null);
                    setPreview(null);
                  }}
                >
                  {meta.tabs.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={`${button} mt-3`}
                disabled={!tab}
                onClick={() =>
                  run(async () => {
                    setPreview(null);
                    setSource(null);
                    setConfirmed(false);
                    setSource(
                      await send({
                        action: "read",
                        spreadsheetId: meta.spreadsheetId,
                        sheetId: Number(tab),
                      }),
                    );
                  })
                }
              >
                讀取資料
              </button>
            </div>
          )}
        </fieldset>
        {source && (
          <fieldset
            disabled={busy || uncertain}
            className="mt-5 rounded-2xl border bg-white p-5 disabled:opacity-60"
          >
            <legend className="px-2 font-semibold">2. 對應欄位與房間</legend>
            <p className="text-sm">
              {source.title} · {source.rows.length} 列。最多 501 列、前 52
              欄。日期需包含西元年，例如 2026/10/2。金額以新臺幣計。
            </p>
            <label className="mt-3 block">
              標題在第幾列
              <input
                className={field}
                type="number"
                min="1"
                max="20"
                value={mapping.headerRow}
                onChange={(e) =>
                  changeMapping({
                    ...mapping,
                    headerRow: Number(e.target.value),
                    roomMap: {},
                  })
                }
              />
            </label>
            <div className="mt-3 overflow-auto">
              <table className="text-sm">
                <caption className="text-left">來源前 5 列</caption>
                <tbody>
                  {source.rows.slice(0, 5).map((r, i) => (
                    <tr key={i}>
                      <th className="border p-2">{i + 1}</th>
                      {r.map((c, j) => (
                        <td key={j} className="max-w-48 border p-2 break-words">
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {Object.entries(columnLabels).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <select
                    className={field}
                    value={mapping.columns[key as keyof typeof columnLabels]}
                    onChange={(e) =>
                      changeMapping({
                        ...mapping,
                        columns: {
                          ...mapping.columns,
                          [key]: Number(e.target.value),
                        },
                        ...(key === "rooms" ? { roomMap: {} } : {}),
                      })
                    }
                  >
                    <option value={-1}>不匯入／尚未選擇</option>
                    {columns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label>
                房費欄位的意思
                <select
                  className={field}
                  value={mapping.amountBasis}
                  onChange={(e) =>
                    changeMapping({
                      ...mapping,
                      amountBasis: e.target.value as Mapping["amountBasis"],
                    })
                  }
                >
                  <option value="none">不匯入金額</option>
                  <option value="order">整筆訂單、全部房間與夜晚的總額</option>
                  <option value="night">全部所選房間每晚合計 × 晚數</option>
                </select>
              </label>
              <label>
                已付／實收欄位的意思
                <select
                  className={field}
                  value={mapping.receivedMeaning}
                  onChange={(e) =>
                    changeMapping({
                      ...mapping,
                      receivedMeaning: e.target
                        .value as Mapping["receivedMeaning"],
                    })
                  }
                >
                  <option value="none">不匯入收款</option>
                  <option value="property">旅宿實際已收到的累計金額</option>
                  <option value="guest">旅客已付平台，尚非旅宿實收</option>
                </select>
              </label>
            </div>
            <p className="mt-3 text-sm">
              累計實收只保留來源摘要，不會捏造付款日期或交易明細。空白金額維持未知。
            </p>
            {labels.map((label) => (
              <fieldset key={label} className="mt-4 rounded-xl border p-3">
                <legend>來源「{label}」對應哪些實體房間？</legend>
                <div className="flex flex-wrap gap-3">
                  {property.rooms.map((room) => (
                    <label key={room.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={
                          mapping.roomMap[label]?.includes(room.id) ?? false
                        }
                        onChange={(e) => {
                          const old = mapping.roomMap[label] ?? [];
                          changeMapping({
                            ...mapping,
                            roomMap: {
                              ...mapping.roomMap,
                              [label]: e.target.checked
                                ? [...old, room.id]
                                : old.filter((id) => id !== room.id),
                            },
                          });
                        }}
                      />
                      {room.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            <label className="mt-4 block">
              匯入此日期以後仍在住／尚未入住的訂單
              <input
                className={field}
                type="date"
                min="2000-01-01"
                max="2100-12-31"
                value={mapping.from}
                onChange={(e) =>
                  changeMapping({ ...mapping, from: e.target.value })
                }
              />
            </label>
            <label className="mt-4 flex items-start gap-3">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-1"
              />
              <span>
                確認每列是一筆完整訂單、金額是新臺幣，並已核對房間對應。逐晚或逐房拆列、取消訂單請先整理；此版不自動判讀狀態欄。匯入後以
                OS 為準。
              </span>
            </label>
            <button
              className={`${button} mt-4`}
              disabled={!confirmed}
              onClick={() =>
                run(async () => {
                  const result = await send<ImportPreview>({
                    action: "preview",
                    sourceId: source.id,
                    mapping,
                  });
                  setPreview(result);
                  setSelection(
                    result.rows
                      .filter((r) => !r.issues.length)
                      .map((r) => r.row),
                  );
                })
              }
            >
              產生匯入預覽
            </button>
          </fieldset>
        )}
        {preview && (
          <section className="mt-5 rounded-2xl border bg-white p-5">
            <h2 className="font-semibold">3. 選擇要匯入的訂單</h2>
            <p className="my-3 text-sm">
              可先匯入無問題的資料。未勾選與有問題的列不會寫入；預覽保留一小時。
            </p>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {[
                      "選擇",
                      "來源列",
                      "姓名／房間",
                      "住宿日期",
                      "整筆房費",
                      "來源收款摘要",
                      "檢查結果",
                    ].map((h) => (
                      <th key={h} className="border p-2 text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.row}>
                      <td className="border p-2">
                        <input
                          aria-label={`匯入第 ${r.row} 列`}
                          type="checkbox"
                          disabled={busy || uncertain || !!r.issues.length}
                          checked={selection.includes(r.row)}
                          onChange={(e) =>
                            setSelection((old) =>
                              e.target.checked
                                ? [...old, r.row]
                                : old.filter((n) => n !== r.row),
                            )
                          }
                        />
                      </td>
                      <td className="border p-2">{r.row}</td>
                      <td className="border p-2">
                        {r.draft?.guestName || "未填姓名"}
                        <br />
                        {property.rooms
                          .filter((room) => r.draft?.roomIds.includes(room.id))
                          .map((room) => room.name)
                          .join("、")}
                      </td>
                      <td className="whitespace-nowrap border p-2">
                        {r.draft?.checkIn}
                        <br />
                        {r.draft?.checkOut}
                      </td>
                      <td className="border p-2">{r.draft?.total ?? "未知"}</td>
                      <td className="border p-2">
                        旅宿實收{" "}
                        {r.draft?.importedFinance?.propertyReceived ?? "未知"}
                        <br />
                        旅客付平台{" "}
                        {r.draft?.importedFinance?.guestPaid ?? "未知"}
                      </td>
                      <td className="min-w-40 border p-2">
                        {r.issues.join("；") || "可匯入"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              className={`${button} mt-4`}
              disabled={busy || !selection.length}
              onClick={() => run(commit)}
            >
              {uncertain ? "重試相同匯入" : `確認匯入 ${selection.length} 筆`}
            </button>
          </section>
        )}
        {!!batches.length && (
          <section className="mt-6">
            <h2 className="font-semibold">匯入紀錄與撤回</h2>
            <p className="mt-2 text-sm">
              只撤回匯入後未修改的訂單；已修改的訂單會保留並列出數量。撤回保留稽核紀錄，原試算表不變。已撤回的來源訂單不會再次自動匯入。
            </p>
            {[...batches].reverse().map((b) => (
              <div key={b.id} className="mt-3 rounded-xl border bg-white p-4">
                <p>
                  {b.sourceTitle} · {b.bookingIds.length} 筆 ·{" "}
                  {new Date(b.createdAt).toLocaleString("zh-TW")}
                </p>
                {b.undo ? (
                  <p>
                    已撤回 {b.undo.cancelled.length} 筆，保留{" "}
                    {b.undo.skipped.length} 筆已變更訂單。
                  </p>
                ) : (
                  <button
                    className={`${secondary} mt-3`}
                    disabled={busy || uncertain}
                    onClick={() =>
                      run(async () => {
                        if (
                          !window.confirm(
                            `撤回此批 ${b.bookingIds.length} 筆訂房？已修改的訂單會保留。`,
                          )
                        )
                          return;
                        const result = await send<NonNullable<Batch["undo"]>>({
                          action: "undo",
                          batchId: b.id,
                          version,
                        });
                        setBatches((old) =>
                          old.map((item) =>
                            item.id === b.id ? { ...item, undo: result } : item,
                          ),
                        );
                        const current = await api<{ version: number }>(
                          `/api/customer-workspaces/${slug}`,
                        );
                        setVersion(current.version);
                        setPreview(null);
                        setNotice(
                          `已撤回 ${result.cancelled.length} 筆，保留 ${result.skipped.length} 筆。`,
                        );
                      })
                    }
                  >
                    撤回此批匯入
                  </button>
                )}
              </div>
            ))}
            <button
              className={`${secondary} mt-3`}
              disabled={busy || uncertain}
              onClick={() => location.reload()}
            >
              重新載入紀錄
            </button>
          </section>
        )}
      </div>
    </main>
  );
}
