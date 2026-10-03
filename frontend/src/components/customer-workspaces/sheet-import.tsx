"use client";
import { useRef, useState } from "react";
import type { Property, Workspace } from "@/lib/customer-workspaces/types";
import type {
  ImportPreview,
  Mapping,
} from "@/lib/customer-workspaces/sheet-import";
import { api, button, field, secondary, today } from "./client";
import {
  suggestFormat,
  type FormatSuggestion,
} from "@/lib/customer-workspaces/format-assistant";
type Batch = NonNullable<Workspace["importBatches"]>[number];
const columnLabels = {
  checkIn: "入住日期",
  checkOut: "退房日期",
  rooms: "房間／包棟",
  guestName: "姓名（選填）",
  externalId: "來源訂單編號（建議）",
  total: "房費（選填）",
  received: "累計已付／訂金（選填）",
  status: "訂單狀態（選填）",
};
export function SheetImport({
  slug,
  property,
  configured,
  connected,
  initialBatches,
  initialVersion,
  sharedUrl,
  helpMessage,
  shareEmail,
}: {
  slug: string;
  property: Property;
  configured: boolean;
  connected: boolean;
  initialBatches: Batch[];
  initialVersion: number;
  sharedUrl?: string;
  helpMessage?: string;
  shareEmail?: string;
}) {
  const [boundUrl, setBoundUrl] = useState(sharedUrl);
  const [suggestion, setSuggestion] = useState<FormatSuggestion | null>(null);
  const [url, setUrl] = useState(sharedUrl ?? "");
  const [help, setHelp] = useState("");
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
      status: -1,
    },
    roomMap: {},
    granularity: "order",
    amountBasis: "none",
    receivedMeaning: "none",
    currency: "TWD",
    from: today(),
  });
  const [confirmedEmpty, setConfirmedEmpty] = useState(false);
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
    setConfirmedEmpty(false);
  }
  async function commit() {
    if (!preview) return;
    pending.current ??= {
      action: "commit",
      previewId: preview.id,
      selected: selection,
      confirmed: true,
      confirmedEmpty,
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
  const isGrid = mapping.granularity === "grid";
  const isNight = mapping.granularity === "night";
  const mappingComplete =
    (isGrid
      ? Boolean(mapping.grid?.dateColumns.length)
      : mapping.columns.checkIn >= 0 &&
        (isNight || mapping.columns.checkOut >= 0)) &&
    mapping.columns.rooms >= 0 &&
    (!["stay", "night"].includes(mapping.granularity) ||
      mapping.columns.externalId >= 0) &&
    (mapping.amountBasis === "none") === (mapping.columns.total === -1) &&
    (mapping.receivedMeaning === "none") === (mapping.columns.received === -1);
  const columnCount = Math.max(0, ...(source?.rows.map((r) => r.length) ?? []));
  const columns = Array.from({ length: columnCount }, (_, i) => ({
    id: i,
    label: `第 ${i + 1} 欄 · ${source?.rows[mapping.headerRow - 1]?.[i] || "未命名"}`,
  }));
  const gridCells =
    isGrid && source
      ? source.rows.slice(mapping.headerRow).flatMap((row, i) =>
          (mapping.grid?.dateColumns ?? []).flatMap((column) =>
            row[column]?.trim()
              ? [
                  {
                    key: `${mapping.headerRow + i + 1}:${column + 1}`,
                    row: mapping.headerRow + i + 1,
                    column: column + 1,
                    room: row[mapping.columns.rooms] ?? "",
                    date: source.rows[mapping.headerRow - 1]?.[column] ?? "",
                    content: row[column].trim(),
                  },
                ]
              : [],
          ),
        )
      : [];
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
          系統會把不同紀錄方式轉成標準訂單，保留原表與來源列。這是一次性匯入，往後以
          OS 為準；不會持續讀取原表、通知客人或關閉 OTA 房量。
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
        {helpMessage && (
          <p className="my-4 rounded-xl bg-amber-50 p-4 whitespace-pre-wrap">
            待核對事項：{helpMessage}
          </p>
        )}
        {(boundUrl || shareEmail) && (
          <details className="my-4 rounded-xl border bg-white p-4">
            <summary className="cursor-pointer">
              表格格式不同、逐晚拆列或需要協助？
            </summary>
            <p className="my-3 text-sm">
              不必猜欄位或先改原表。請說明你不確定的部分，服務人員會收到通知協助核對。
            </p>
            <label className="text-sm">
              需要協助的內容
              <textarea
                className={field}
                maxLength={1000}
                value={help}
                onChange={(e) => setHelp(e.target.value)}
              />
            </label>
            <button
              className={`${secondary} mt-3`}
              disabled={busy || !help.trim()}
              onClick={() =>
                run(async () => {
                  const r = await send<{ notification: string }>({
                    action: "help",
                    message: help,
                  });
                  setNotice(
                    r.notification === "accepted"
                      ? "協助需求已保存，通知已交由寄信服務送出。"
                      : "協助需求已保存；通知尚待確認，你也可以使用服務信箱聯絡我們。",
                  );
                })
              }
            >
              請專人協助核對
            </button>
          </details>
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
          <legend className="px-2 font-semibold">1. 連結來源試算表</legend>
          <p className="mb-3 text-sm">
            {boundUrl
              ? "請選擇要匯入的分頁。Sheet 建立者與登入帳號可以不同，不需變更原表格式。"
              : shareEmail
                ? `先將 Sheet 的檢視權限分享給 ${shareEmail}，再貼上連結。不要求建立者與登入帳號相同，也不需公開檔案。`
                : "Google 唯讀授權約一小時有效。不需公開分享檔案。"}
          </p>
          {!configured && (
            <p className="mb-3 text-amber-800">
              此測試環境尚未設定 Google 授權，設定完成後即可使用。
            </p>
          )}
          {connected && !boundUrl && (
            <p className="mb-3 text-teal-800">
              已完成 Google 授權，可貼上連結。
            </p>
          )}
          {!boundUrl && !shareEmail && (
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
          )}
          <label className="mt-4 block">
            Google Sheet 連結
            <input
              className={field}
              value={url}
              readOnly={Boolean(boundUrl)}
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
                if (shareEmail && !boundUrl) {
                  const linked = await send<{
                    status: string;
                    url?: string;
                    version?: number;
                  }>({ action: "bind", url });
                  if (linked.status !== "approved") {
                    setNotice("來源連結尚未完成，請重新讀取或聯絡專人協助。");
                    return;
                  }
                  setBoundUrl(linked.url ?? url);
                  if (linked.version) setVersion(linked.version);
                }
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
                    setConfirmedEmpty(false);
                    const result = await send<NonNullable<typeof source>>({
                      action: "read",
                      spreadsheetId: meta.spreadsheetId,
                      sheetId: Number(tab),
                    });
                    setSource(result);
                    setSuggestion(suggestFormat(result.rows, property));
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
            {suggestion && (
              <section className="mb-5 space-y-3 rounded-xl bg-teal-50 p-4">
                <h2 className="font-semibold">先確認你的紀錄方式</h2>
                {suggestion.messages.map((message, i) => (
                  <p className="text-sm leading-6" key={i}>
                    {message}
                  </p>
                ))}
                <ul className="list-disc space-y-2 pl-5 text-sm">
                  {suggestion.questions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  className={secondary}
                  onClick={() =>
                    changeMapping({
                      ...mapping,
                      headerRow: suggestion.headerRow,
                      columns: suggestion.columns,
                      roomMap: suggestion.roomMap,
                      granularity: suggestion.granularity,
                      amountBasis: suggestion.amountBasis,
                      receivedMeaning:
                        suggestion.columns.received < 0 ? "none" : "source",
                      grid: suggestion.grid,
                    })
                  }
                >
                  採用欄位與房間建議，再由我核對
                </button>
                <p className="text-xs text-slate-600">
                  建議依欄名與房名比對。相同訂單的多列會整組預覽；有歧義時只暫停那組，不需要改原表。
                </p>
              </section>
            )}
            <p className="text-sm">
              {source.title} · {source.rows.length} 列。最多 501 列、前 52
              欄。日期需包含西元年，例如 2026/10/2。金額以新臺幣計。
            </p>
            <label className="mt-3 block">
              來源紀錄方式
              <select
                className={field}
                value={mapping.granularity}
                onChange={(e) => {
                  const granularity = e.target.value as Mapping["granularity"];
                  changeMapping({
                    ...mapping,
                    granularity,
                    ...(granularity === "night"
                      ? { columns: { ...mapping.columns, checkOut: -1 } }
                      : {}),
                    ...(granularity === "grid"
                      ? {
                          columns: {
                            checkIn: -1,
                            checkOut: -1,
                            rooms: mapping.columns.rooms,
                            guestName: -1,
                            externalId: -1,
                            total: -1,
                            received: -1,
                            status: -1,
                          },
                          amountBasis: "none",
                          receivedMeaning: "none",
                          grid: {
                            dateColumns: (
                              source.rows[mapping.headerRow - 1] ?? []
                            ).flatMap((v, i) =>
                              /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(v.trim())
                                ? [i]
                                : [],
                            ),
                            cellMeaning: "guest-name",
                            orderIds: {},
                          },
                        }
                      : {}),
                  });
                }}
              >
                <option value="order">一列是一張完整訂單</option>
                <option value="stay">
                  一列是一間房或一段住宿，同張訂單可能多列
                </option>
                <option value="night">一列是一個住宿夜</option>
                <option value="grid">日期橫排、房間直排的房況格</option>
              </select>
            </label>
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
                    ...(isGrid
                      ? {
                          grid: {
                            dateColumns: [],
                            cellMeaning: "guest-name",
                            orderIds: {},
                          },
                        }
                      : {}),
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
              {Object.entries(columnLabels)
                .filter(([key]) =>
                  isGrid ? key === "rooms" : !(isNight && key === "checkOut"),
                )
                .map(([key, label]) => (
                  <label key={key}>
                    {key === "checkIn" && isNight ? "住宿日期" : label}
                    <select
                      className={field}
                      value={
                        mapping.columns[key as keyof typeof columnLabels] ?? -1
                      }
                      onChange={(e) =>
                        changeMapping({
                          ...mapping,
                          columns: {
                            ...mapping.columns,
                            [key]: Number(e.target.value),
                          },
                          ...(key === "rooms" ? { roomMap: {} } : {}),
                          ...(key === "received"
                            ? {
                                receivedMeaning:
                                  Number(e.target.value) < 0
                                    ? "none"
                                    : "source",
                              }
                            : {}),
                          ...(key === "total" && Number(e.target.value) < 0
                            ? { amountBasis: "none" }
                            : {}),
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
            {!isGrid && (
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
                    <option value="order">
                      整筆訂單、全部房間與夜晚的總額
                    </option>
                    <option value="line">每列的完整金額，合併時相加</option>
                    <option value="night">全部所選房間每晚合計 × 晚數</option>
                    <option value="room-night">
                      每間房每晚價格 × 房間數 × 晚數
                    </option>
                  </select>
                </label>
              </div>
            )}
            <p className="mt-3 text-sm">
              同一訂單重複出現的總額與累計已付只記一次；不同金額會列為待核對。來源累計保留原意，不新增假的付款日期。空白金額維持未知。
            </p>
            {isGrid && (
              <section className="mt-4 space-y-3 rounded-xl border p-4">
                <h3 className="font-medium">房況格對應</h3>
                <p className="text-sm">
                  選擇包含完整年份的日期欄。空白格不建立訂單，有內容的格子都會檢查。若格內是姓名，請為每個格子填來源訂單編號；同名不會自動合併。
                </p>
                <div className="flex flex-wrap gap-3">
                  {columns
                    .filter((c) => c.id !== mapping.columns.rooms)
                    .map((c) => (
                      <label
                        key={c.id}
                        className="flex items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={
                            mapping.grid?.dateColumns.includes(c.id) ?? false
                          }
                          onChange={(e) =>
                            changeMapping({
                              ...mapping,
                              grid: {
                                cellMeaning:
                                  mapping.grid?.cellMeaning ?? "guest-name",
                                orderIds: {},
                                dateColumns: e.target.checked
                                  ? [...(mapping.grid?.dateColumns ?? []), c.id]
                                  : (mapping.grid?.dateColumns ?? []).filter(
                                      (n) => n !== c.id,
                                    ),
                              },
                            })
                          }
                        />
                        {c.label}
                      </label>
                    ))}
                </div>
                <label className="block">
                  格子內容
                  <select
                    className={field}
                    value={mapping.grid?.cellMeaning ?? "guest-name"}
                    onChange={(e) =>
                      changeMapping({
                        ...mapping,
                        grid: {
                          dateColumns: mapping.grid?.dateColumns ?? [],
                          orderIds: {},
                          cellMeaning: e.target.value as
                            "guest-name" | "order-id",
                        },
                      })
                    }
                  >
                    <option value="guest-name">
                      客人姓名，需要指定訂單編號
                    </option>
                    <option value="order-id">已經是完整訂單編號</option>
                  </select>
                </label>
                {mapping.grid?.cellMeaning === "guest-name" && (
                  <div className="max-h-96 overflow-auto">
                    {gridCells.map((cell) => (
                      <label key={cell.key} className="mb-3 block text-sm">
                        第 {cell.row} 列、第 {cell.column} 欄 · {cell.room} ·{" "}
                        {cell.date} · {cell.content}
                        <input
                          className={field}
                          aria-label={`儲存格 ${cell.key} 的訂單編號`}
                          maxLength={200}
                          value={mapping.grid?.orderIds[cell.key] ?? ""}
                          onChange={(e) =>
                            changeMapping({
                              ...mapping,
                              grid: {
                                ...mapping.grid!,
                                orderIds: {
                                  ...mapping.grid!.orderIds,
                                  [cell.key]: e.target.value,
                                },
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                )}
              </section>
            )}
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
            {!mappingComplete && (
              <p className="mt-4 text-sm text-amber-800">
                請選齊此紀錄方式需要的日期、房間與訂單編號。若選了房費欄，請確認金額是整筆、每列或每晚；不匯入金額時，請把對應欄位設為「不匯入」。
              </p>
            )}
            <label className="mt-4 flex items-start gap-3">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-1"
              />
              <span>
                已確認紀錄方式、房間對應與金額是新臺幣。系統會按訂單編號合併，並列出衝突或無法判讀的資料；匯入後以
                OS 為準。
              </span>
            </label>
            <button
              className={`${button} mt-4`}
              disabled={!confirmed || !mappingComplete}
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
              每一列預覽代表合併後的一張訂單。可先匯入無問題的整組資料；有問題的訂單不會只匯入其中幾晚。預覽保留一小時。
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
                      <td className="border p-2">
                        {r.references?.some((ref) => ref.column)
                          ? r.references
                              .map((ref) => `${ref.row}:${ref.column}`)
                              .join("、")
                          : (r.sourceRows ?? [r.row]).join("、")}
                      </td>
                      <td className="border p-2">
                        {r.draft?.guestName || "未填姓名"}
                        <br />
                        {r.draft?.externalId && (
                          <>
                            <span className="text-xs">
                              {r.draft.externalId}
                            </span>
                            <br />
                          </>
                        )}
                        {property.rooms
                          .filter((room) => r.draft?.roomIds.includes(room.id))
                          .map((room) => room.name)
                          .join("、")}
                      </td>
                      <td className="whitespace-nowrap border p-2">
                        {(r.draft?.stays ?? (r.draft ? [r.draft] : [])).map(
                          (stay, i) => (
                            <div key={i}>
                              {stay.checkIn} ～ {stay.checkOut}
                              <br />
                              <span className="text-xs">
                                {property.rooms
                                  .filter((room) =>
                                    stay.roomIds.includes(room.id),
                                  )
                                  .map((room) => room.name)
                                  .join("、")}
                              </span>
                            </div>
                          ),
                        )}
                        {r.roomNightCount > 0 && (
                          <span className="text-xs">
                            共 {r.roomNightCount} 個房晚
                          </span>
                        )}
                      </td>
                      <td className="border p-2">{r.draft?.total ?? "未知"}</td>
                      <td className="border p-2">
                        來源累計已付{" "}
                        {r.draft?.importedFinance?.sourcePaid ??
                          r.draft?.importedFinance?.propertyReceived ??
                          r.draft?.importedFinance?.guestPaid ??
                          "未知"}
                      </td>
                      <td className="min-w-40 border p-2">
                        {r.issues.join("；") || "可匯入"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rows.every((row) =>
              row.issues.includes("已在選定範圍之前退房"),
            ) && (
              <label className="mt-4 flex items-start gap-3">
                <input
                  type="checkbox"
                  disabled={busy || uncertain}
                  checked={confirmedEmpty}
                  onChange={(e) => setConfirmedEmpty(e.target.checked)}
                />
                <span>
                  我已核對來源，確認 {mapping.from}{" "}
                  起沒有尚未退房或未來的有效訂單。
                </span>
              </label>
            )}
            <button
              className={`${button} mt-4`}
              disabled={busy || (!selection.length && !confirmedEmpty)}
              onClick={() => run(commit)}
            >
              {uncertain
                ? "重試相同匯入"
                : selection.length
                  ? `確認匯入 ${selection.length} 筆`
                  : "確認此範圍沒有有效訂單"}
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
                {!b.bookingIds.length ? (
                  <p className="text-sm text-slate-500">
                    本批為空表核對，沒有訂單可撤回；來源變更時請重新讀取與核對。
                  </p>
                ) : b.undo ? (
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
