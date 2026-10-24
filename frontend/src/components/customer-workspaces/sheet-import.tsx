"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
const PREVIEW_PAGE_SIZE = 100;
const GRID_PAGE_SIZE = 100;
type RecordMode = Mapping["granularity"] | "auto";
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
  platform: "預訂平台（選填）",
  bookedAt: "實際訂房日期（選填）",
  notes: "訂單備註／需求（選填）",
  sourceRowId: "來源列唯一ID（缺訂單編號時使用）",
};
function mappingReady(mapping: Mapping) {
  const isGrid = mapping.granularity === "grid";
  const isNight = mapping.granularity === "night";
  return (isGrid
    ? Boolean(mapping.grid?.dateColumns.length)
    : mapping.columns.checkIn >= 0 && (isNight || mapping.columns.checkOut >= 0)) &&
    mapping.columns.rooms >= 0 &&
    (!["stay", "night"].includes(mapping.granularity) || mapping.columns.externalId >= 0) &&
    (mapping.amountBasis === "none") === (mapping.columns.total === -1) &&
    (mapping.receivedMeaning === "none") === (mapping.columns.received === -1);
}
function unmappedRoomLabels(rows: string[][], mapping: Mapping) {
  if (mapping.columns.rooms < 0) return [];
  return [...new Set(rows.slice(mapping.headerRow)
    .map((row) => (row[mapping.columns.rooms] ?? "").trim())
    .filter(Boolean))]
    .filter((label) => !mapping.roomMap[label]?.length);
}
function suggestedMapping(current: Mapping, suggestion: FormatSuggestion, mode: RecordMode): Mapping {
  const granularity = mode === "auto" ? suggestion.granularity : mode;
  const grid = granularity === "grid" ? suggestion.grid : undefined;
  const columns = granularity === "grid"
    ? { ...suggestion.columns, checkIn: -1, checkOut: -1, guestName: -1,
      externalId: -1, total: -1, received: -1, status: -1 }
    : { ...suggestion.columns, ...(granularity === "night" ? { checkOut: -1 } : {}) };
  // An ambiguous money heading never becomes a silently assumed amount.
  if (suggestion.amountBasis === "none") columns.total = -1;
  return { ...current, headerRow: suggestion.headerRow, columns,
    roomMap: suggestion.roomMap, granularity,
    amountBasis: granularity === "grid" ? "none" : suggestion.amountBasis,
    receivedMeaning: columns.received < 0 ? "none" : "source", grid,
    missingOrderId: ["stay", "night"].includes(granularity)
      ? suggestion.missingOrderId ?? "review" : "review" };
}
function formatNeedsReview(suggestion: FormatSuggestion) {
  return suggestion.questions.length > 0 ||
    suggestion.messages.some((message) => /有多個.*候選欄|重複標題|多個區塊/.test(message));
}
export function SheetImport({
  slug,
  property,
  configured,
  connected,
  initialBatches,
  initialVersion,
  sharedUrl,
  autoPreview = false,
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
  autoPreview?: boolean;
  helpMessage?: string;
  shareEmail?: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const autoPreviewStarted = useRef(false);
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
  const [fileMeta, setFileMeta] = useState<{
    title: string;
    tabs: { id: number; title: string; sourceId: string }[];
  } | null>(null);
  const [fileTab, setFileTab] = useState("");
  const [stage, setStage] = useState<"source" | "review">("source");
  const [autoStarting, setAutoStarting] = useState(autoPreview && configured && Boolean(sharedUrl));
  const [recordMode, setRecordMode] = useState<RecordMode>("auto");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [startNewImport, setStartNewImport] = useState(false);
  const [showAllRows, setShowAllRows] = useState(false);
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
    from: "2000-01-01",
    coverageFrom: today(),
  });
  const [confirmedEmpty, setConfirmedEmpty] = useState(false);
  const [coverageConfirmed, setCoverageConfirmed] = useState(false);
  const [confirmed, setConfirmed] = useState(false),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [selection, setSelection] = useState<number[]>([]),
    [previewPage, setPreviewPage] = useState(0),
    [gridPage, setGridPage] = useState(0);
  const [batches, setBatches] = useState(initialBatches),
    [version, setVersion] = useState(initialVersion),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => { setCoverageConfirmed(false); }, [source?.id]);
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
    setPreviewPage(0);
    setGridPage(0);
    setConfirmed(false);
    setConfirmedEmpty(false);
    setCoverageConfirmed(false);
    setShowAllRows(false);
  }
  async function prepareSource(nextSource: NonNullable<typeof source>, importWhenClean = false) {
    const nextSuggestion = suggestFormat(nextSource.rows, property);
    const nextMapping = suggestedMapping(mapping, nextSuggestion, recordMode);
    setSource(nextSource);
    setSuggestion(nextSuggestion);
    setMapping(nextMapping);
    setStage("review");
    setShowAdvanced(false);
    setPreview(null);
    setSelection([]);
    setConfirmed(false);
    setConfirmedEmpty(false);
    setCoverageConfirmed(false);
    setShowAllRows(false);
    // A matching room column is insufficient: every source room must map to an
    // actual workspace room before the wizard can skip the review step.
    if (mappingReady(nextMapping) && !unmappedRoomLabels(nextSource.rows, nextMapping).length && !formatNeedsReview(nextSuggestion)) {
      const result = await send<ImportPreview>({
        action: "preview", sourceId: nextSource.id, mapping: nextMapping,
      });
      setPreview(result);
      setPreviewPage(0);
      const readyRows = result.rows.filter((row) => row.draft && !row.issues.length).map((row) => row.row);
      setSelection(readyRows);
      if (importWhenClean && readyRows.length === result.rows.length && readyRows.length > 0)
        await commitPreview(result, readyRows);
    }
  }
  async function continueWithGoogle(importWhenClean = false) {
    setPreview(null);
    setFileMeta(null);
    let activeUrl = boundUrl ?? url;
    if (shareEmail && !boundUrl) {
      const linked = await send<{ status: string; url?: string; version?: number }>({
        action: "bind", url,
      });
      if (linked.status !== "approved") throw new Error("尚未取得 Sheet 檢視權限，請確認分享設定。");
      activeUrl = linked.url ?? url;
      setBoundUrl(activeUrl);
      if (linked.version) setVersion(linked.version);
    }
    const nextMeta = meta ?? await send<NonNullable<typeof meta>>({ action: "tabs", url: activeUrl });
    setMeta(nextMeta);
    if (!nextMeta.tabs.length) throw new Error("這份 Sheet 沒有可讀取的分頁。");
    const linkedGid = /(?:[?#&])gid=(\d+)/.exec(activeUrl)?.[1];
    const selected = nextMeta.tabs.find((item) => String(item.id) === tab) ??
      nextMeta.tabs.find((item) => String(item.id) === linkedGid) ??
      (!linkedGid ? nextMeta.tabs.find((item) => item.title === "工作表1") : undefined) ??
      (!linkedGid && nextMeta.tabs.length === 1 ? nextMeta.tabs[0] : undefined);
    if (!selected) {
      setTab("");
      setNotice("請選擇訂單所在的分頁再繼續。");
      return;
    }
    setTab(String(selected.id));
    const nextSource = await send<NonNullable<typeof source>>({
      action: "read", spreadsheetId: nextMeta.spreadsheetId, sheetId: selected.id,
    });
    await prepareSource(nextSource, importWhenClean);
  }
  useEffect(() => {
    if (!autoPreview || !configured || !sharedUrl || autoPreviewStarted.current) return;
    autoPreviewStarted.current = true;
    void run(continueWithGoogle).finally(() => setAutoStarting(false));
    // This is the one-time continuation of a previously approved onboarding link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPreview, configured, sharedUrl]);
  async function commitPreview(result: ImportPreview, selected: number[], empty = false) {
    pending.current ??= {
      action: "commit",
      previewId: result.id,
      selected,
      confirmed: true,
      confirmedEmpty: empty,
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
      setNotice(`已匯入 ${batch.bookingIds.length} 筆訂房。`);
      setPreview(null);
      setSource(null);
      setStage("source");
      setUncertain(false);
      pending.current = null;
      router.push(`/w/${slug}/calendar?${new URLSearchParams({ property: property.id, imported: batch.id })}`);
    } catch (e) {
      const status = e instanceof Error && "status" in e ? Number(e.status) : 0;
      if (status >= 400 && status < 500) {
        pending.current = null;
        setUncertain(false);
      } else setUncertain(true);
      throw e;
    }
  }
  async function commit() {
    if (preview) await commitPreview(preview, selection, confirmedEmpty);
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
  const needsFormatReview = suggestion ? formatNeedsReview(suggestion) : false;
  const mappingComplete = mappingReady(mapping);
  const missingRoomLabels = source ? unmappedRoomLabels(source.rows, mapping) : [];
  const columnCount = Math.max(0, ...(source?.rows.map((r) => r.length) ?? []));
  const columns = Array.from({ length: columnCount }, (_, i) => ({
    id: i,
    label: `第 ${i + 1} 欄 · ${source?.rows[mapping.headerRow - 1]?.[i] || "未命名"}`,
  }));
  const selectedRows = useMemo(() => new Set(selection), [selection]);
  const activeBatch = [...batches].reverse().find((batch) => !batch.undo && batch.bookingIds.length > 0);
  const showCompleted = stage === "source" && Boolean(activeBatch) && !startNewImport && !autoStarting;
  const currentPreviewRows = preview?.rows.filter((row) =>
    !row.issues.includes("已在選定範圍之前退房")) ?? [];
  const pastPreviewCount = (preview?.rows.length ?? 0) - currentPreviewRows.length;
  const problemRows = currentPreviewRows.filter((row) => !row.draft || row.issues.length > 0);
  const tableRows = showAllRows || !problemRows.length ? currentPreviewRows : problemRows;
  const previewPages = Math.ceil(tableRows.length / PREVIEW_PAGE_SIZE);
  const visiblePreviewRows = tableRows.slice(previewPage * PREVIEW_PAGE_SIZE, (previewPage + 1) * PREVIEW_PAGE_SIZE);
  function sourceValues(row: ImportPreview["rows"][number], column: number) {
    if (!source || column < 0) return "";
    const numbers = row.sourceRows ?? row.references?.map((ref) => ref.row) ?? [row.row];
    const values = [...new Set(numbers.map((number) => source.rows[number - 1]?.[column]?.trim()).filter(Boolean))];
    return values.slice(0, 3).join("、") + (values.length > 3 ? "…" : "");
  }
  const gridCells = useMemo(() =>
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
      : [], [isGrid, source, mapping.headerRow, mapping.columns.rooms, mapping.grid?.dateColumns]);
  const gridPages = Math.ceil(gridCells.length / GRID_PAGE_SIZE);
  const visibleGridCells = gridCells.slice(gridPage * GRID_PAGE_SIZE, (gridPage + 1) * GRID_PAGE_SIZE);
  const helpCard = (boundUrl || shareEmail) ? (
    <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
      <h3 className="font-medium">對欄位或預覽結果有疑問？</h3>
      <p className="mt-1">先不要確認匯入。請說明哪個欄位或來源列需要核對，專人會收到你的說明；原表不會被修改。</p>
      <label className="mt-3 block">需要協助的內容
        <textarea className={field} maxLength={1000} value={help} onChange={(e) => setHelp(e.target.value)} placeholder="例如：第 25 列的包棟訂單應該對應哪些房間？" />
      </label>
      <button className={`${secondary} mt-3`} disabled={busy || !help.trim()} onClick={() => run(async () => {
        const r = await send<{ notification: string }>({ action: "help", message: help });
        setNotice(r.notification === "accepted" ? "協助需求已保存，通知已交由寄信服務送出。" : "協助需求已保存；通知尚待確認，你也可以使用服務信箱聯絡我們。");
      })}>請專人協助核對</button>
    </div>
  ) : null;
  return (
    <main className="min-h-dvh bg-[#f4f7f4] px-4 pb-16 pt-8 text-slate-800 sm:px-8 sm:pt-12">
      <div className="mx-auto max-w-4xl">
        <a className="inline-flex items-center gap-2 text-sm font-medium text-teal-800 hover:underline" href={`/w/${slug}/calendar`}>
          <span aria-hidden="true">←</span> 回房況日曆
        </a>
        <header className="my-10 sm:my-14">
          <div className="mb-5 inline-flex rounded-full border border-teal-200 bg-white px-4 py-2 text-sm font-medium text-teal-900 shadow-sm">
            {property.name}
          </div>
          <p className="text-xs font-semibold tracking-[0.24em] text-teal-700">IMPORT TO CALENDAR</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 sm:text-5xl">把訂房，帶進日曆。</h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-slate-600">
            貼上 Google Sheet 連結，系統會檢查日期、房間和重複訂房。資料沒問題就直接匯入；需要核對的部分才會請你處理。
          </p>
        </header>
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
        {uncertain && (
          <p role="alert" className="my-4 rounded-xl bg-amber-50 p-4">
            寫入結果尚未確認。請按「重試相同匯入」核對；已送出的選擇暫時鎖定。
          </p>
        )}
        {showCompleted && activeBatch ? (
          <section className="rounded-[2rem] border border-teal-100 bg-white p-6 shadow-[0_24px_70px_-42px_rgba(15,86,77,0.45)] sm:p-9" role="status">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-800 text-2xl text-white" aria-hidden="true">✓</div>
            <h2 className="mt-6 text-2xl font-semibold text-slate-900">訂房已在日曆裡</h2>
            <p className="mt-3 text-slate-600">{activeBatch.sourceTitle} · 已匯入 {activeBatch.bookingIds.length} 筆訂房。原始表格沒有被修改。</p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a className={`${button} inline-flex items-center gap-2`} href={`/w/${slug}/calendar?property=${encodeURIComponent(property.id)}`}>
                查看房況日曆 <span aria-hidden="true">→</span>
              </a>
              <button type="button" className={secondary} onClick={() => setStartNewImport(true)}>再次檢查來源</button>
            </div>
          </section>
        ) : stage === "source" && autoStarting ? (
          <section role="status" className="rounded-2xl border bg-white p-5">
            正在檢查已連結的 Google Sheet…
          </section>
        ) : stage === "source" ? <fieldset
          disabled={busy || uncertain}
          className="rounded-[2rem] border border-white bg-white p-6 shadow-[0_24px_70px_-42px_rgba(15,86,77,0.45)] disabled:opacity-60 sm:p-9"
        >
          <legend className="sr-only">匯入資料來源</legend>
          <div className="mb-7 flex items-center gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-teal-50 text-xl text-teal-800" aria-hidden="true">↗</div>
            <div><h2 className="text-xl font-semibold text-slate-900">連結你的訂房表</h2><p className="mt-1 text-sm text-slate-500">只讀取資料，不會修改原表格。</p></div>
          </div>
          <p className="mb-3 text-sm leading-7 text-slate-600">
            {boundUrl
              ? "已連結 Google Sheet；接下來系統會讀取資料並產生預覽。原表不會被修改。"
              : shareEmail
                ? `請將 Sheet 的「檢視者」權限分享給 ${shareEmail}，再貼上連結。不需公開檔案。`
                : "Google 唯讀授權約一小時有效。不需公開分享檔案。"}
          </p>
          {shareEmail && (
            <a href="/guides/share-google-sheet" target="_blank" rel="noopener noreferrer" className="mb-4 inline-block text-sm font-medium text-teal-800 underline underline-offset-4">
              看圖文教學：如何分享 Google Sheet（另開分頁）
            </a>
          )}
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
          <label className="mt-5 block font-medium text-slate-800">
            Google Sheet 連結
            <input
              className={`${field} mt-3 border-slate-200 px-4 py-4 shadow-sm focus:border-teal-700 focus:outline-none focus:ring-4 focus:ring-teal-100`}
              value={url}
              readOnly={Boolean(boundUrl)}
              onChange={(e) => {
                setUrl(e.target.value);
                setMeta(null);
                setTab("");
                setFileMeta(null);
                setSource(null);
                setPreview(null);
              }}
              placeholder="https://docs.google.com/spreadsheets/d/…"
            />
          </label>
          <details className="mt-4 text-sm text-slate-600">
            <summary className="cursor-pointer text-teal-800">表格格式特殊？選擇資料記錄方式</summary>
            <label className="mt-3 block">來源紀錄方式
              <select className={field} value={recordMode}
                onChange={(event) => setRecordMode(event.target.value as RecordMode)}>
                <option value="auto">讓系統辨認（建議）</option>
                <option value="order">一列是一張完整訂單</option>
                <option value="stay">同張訂單可能有多列房間或住宿</option>
                <option value="night">一列是一個住宿夜</option>
                <option value="grid">日期橫排、房間直排的房況格</option>
              </select>
            </label>
          </details>
          {meta && !tab && (
            <label className="mt-4 block">
              訂單所在分頁
              <select className={field} value={tab} onChange={(event) => setTab(event.target.value)}>
                <option value="">請選擇分頁</option>
                {meta.tabs.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
          )}
          <button type="button" className={`${button} mt-7 w-full py-4 text-base shadow-lg shadow-teal-900/10 sm:w-auto`}
            disabled={!configured || !url.trim() || (Boolean(meta) && !tab)}
            onClick={() => run(() => continueWithGoogle(true))}>
            {busy ? "正在檢查訂房資料…" : "檢查並匯入訂房 →"}
          </button>
          <p className="mt-4 text-xs leading-6 text-slate-500">若資料可安全匯入，完成後會直接開啟日曆。有疑義的訂房會先停下來請你核對。</p>
          {!boundUrl && (
            <details className="mt-6 border-t pt-5">
              <summary className="cursor-pointer font-medium text-teal-800">改用 Excel／CSV 檔案</summary>
              <p className="mt-2 text-sm text-slate-600">
                支援未加密的 .xlsx、UTF-8 或 Big5 CSV，最多 3 MB。檔名與分頁名稱是來源識別；更新同一份資料時請保留名稱。上傳後仍需核對欄位、房間和每筆預覽。
              </p>
              <input ref={fileRef} type="file" accept=".xlsx,.csv" className="mt-3 block w-full text-sm" />
              <button
                type="button"
                className={`${secondary} mt-3`}
                disabled={busy}
                onClick={() => run(async () => {
                  const file = fileRef.current?.files?.[0];
                  if (!file) throw new Error("請先選擇檔案。");
                  setFileMeta(null);
                  setSource(null);
                  setSuggestion(null);
                  setPreview(null);
                  setConfirmed(false);
                  setConfirmedEmpty(false);
                  const query = new URLSearchParams({ propertyId: property.id, filename: file.name });
                  const response = await fetch(`${endpoint}/upload?${query}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/octet-stream" },
                    body: file,
                    signal: AbortSignal.timeout(65000),
                  });
                  const result = await response.json();
                  if (!response.ok) throw new Error(result.detail ?? "無法讀取檔案");
                  const staged = result as NonNullable<typeof fileMeta>;
                  setFileMeta(staged);
                  setMeta(null);
                  setPreview(null);
                  if (staged.tabs.length !== 1) {
                    setFileTab("");
                    return;
                  }
                  setFileTab(staged.tabs[0].sourceId);
                  const first = await send<NonNullable<typeof source>>({ action: "file-source", sourceId: staged.tabs[0].sourceId });
                  await prepareSource(first, true);
                })}
              >
                上傳並讀取
              </button>
              {fileMeta && fileMeta.tabs.length > 1 && (
                <label className="mt-4 block">
                  檔案分頁
                  <select
                    className={field}
                    value={fileTab}
                    onChange={(event) => setFileTab(event.target.value)}
                  >
                    <option value="">請選擇訂單所在分頁</option>
                    {fileMeta.tabs.map((tab) => <option key={tab.sourceId} value={tab.sourceId}>{tab.title}</option>)}
                  </select>
                </label>
              )}
              {fileMeta && fileMeta.tabs.length > 1 && <button type="button"
                className={`${button} mt-3`} disabled={!fileTab}
                onClick={() => run(async () => {
                  const selected = await send<NonNullable<typeof source>>({ action: "file-source", sourceId: fileTab });
                  await prepareSource(selected, true);
                })}>檢查並匯入訂房</button>}
            </details>
          )}
          <div className="mt-8 grid gap-3 border-t border-slate-100 pt-6 text-xs text-slate-500 sm:grid-cols-3">
            <span>✓ 原表格不會被修改</span><span>✓ 重複與衝突會先擋下</span><span>✓ 匯入後直接查看日曆</span>
          </div>
        </fieldset> : <section className="rounded-2xl border bg-white p-5">
          <p className="font-semibold">已檢查 {source?.title ?? "來源資料"}</p>
          <p className="mt-1 text-sm text-slate-600">原表格沒有被修改。</p>
          <button type="button" className={`${secondary} mt-3`} onClick={() => {
            setStage("source"); setSource(null); setPreview(null); setShowAdvanced(false);
          }}>更換來源</button>
        </section>}
        {stage === "review" && source && !preview && !showAdvanced && (
          <section className="mt-5 rounded-[2rem] border border-amber-100 bg-white p-6 shadow-sm sm:p-9">
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-xl text-amber-800" aria-hidden="true">?</div>
            <h2 className="text-xl font-semibold text-slate-900">{mappingComplete && !missingRoomLabels.length && !needsFormatReview ? "資料已讀取，請再檢查一次" : "有幾項資料需要你確認"}</h2>
            <p className="mt-3 text-sm leading-7 text-slate-600">{suggestion?.messages[0]}</p>
            {suggestion?.questions.map((question) => <p className="mt-2 text-sm text-amber-800" key={question}>{question}</p>)}
            {missingRoomLabels.length > 0 && <p className="mt-2 text-sm text-amber-800">
              表格中的「{missingRoomLabels.slice(0, 6).join("、")}{missingRoomLabels.length > 6 ? ` 等 ${missingRoomLabels.length} 種` : ""}」還不知道對應哪個房間。請選好房間後再匯入。
            </p>}
            {!mappingComplete && <p className="mt-2 text-sm text-amber-800">
              日期、房間或訂單編號尚無法安全判斷。請確認表格欄位。
            </p>}
            {mappingComplete && !missingRoomLabels.length && !needsFormatReview && <button type="button" className={`${button} mt-4`} onClick={() => run(async () => {
              const result = await send<ImportPreview>({ action: "preview", sourceId: source.id, mapping });
              setPreview(result);
              setPreviewPage(0);
              setSelection(result.rows.filter((row) => row.draft && !row.issues.length).map((row) => row.row));
            })}>重新檢查資料</button>}
            <button type="button" className={`${secondary} mt-4`} onClick={() => setShowAdvanced(true)}>
              確認欄位與房間
            </button>
          </section>
        )}
        {stage === "review" && source && !preview && showAdvanced && (
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
              {source.title} · {source.rows.length} 列。最多 3,001 列（含標題與前置列）、52
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
                  <div>
                    <p className="mb-2 text-sm">共 {gridCells.length} 個有內容的格子。每頁顯示 {GRID_PAGE_SIZE} 個，翻頁會保留已填的訂單編號。</p>
                    {gridPages > 1 && <div className="mb-3 flex items-center gap-3 text-sm">
                      <button type="button" className={secondary} disabled={gridPage === 0} onClick={() => setGridPage((page) => page - 1)}>上一頁</button>
                      <span>第 {gridPage + 1}／{gridPages} 頁</span>
                      <button type="button" className={secondary} disabled={gridPage + 1 >= gridPages} onClick={() => setGridPage((page) => page + 1)}>下一頁</button>
                    </div>}
                    <div className="max-h-96 overflow-auto">
                    {visibleGridCells.map((cell) => (
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
              匯入起始日期（預設 2000 年，包含目前可讀到的歷史資料）
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
            {["stay", "night"].includes(mapping.granularity) && (
              <label className="mt-4 flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-1"
                  checked={mapping.missingOrderId === "source-row"}
                  disabled={(mapping.columns.sourceRowId ?? -1) < 0}
                  onChange={(event) => changeMapping({ ...mapping,
                    missingOrderId: event.target.checked ? "source-row" : "review" })} />
                <span>缺訂單編號時，依來源列唯一ID逐列建立獨立訂單；唯一ID 空白或重複仍待核對。若同一訂單跨多列但沒有訂單編號，房費會保留各列金額。</span>
              </label>
            )}
            <label className="mt-4 block">
              可售房況已核對的起始日（與歷史匯入起始日分開）
              <input className={field} type="date" min="2000-01-01" max="2100-12-31"
                value={mapping.coverageFrom ?? mapping.from}
                onChange={(event) => changeMapping({ ...mapping, coverageFrom: event.target.value || undefined })} />
            </label>
            <label className="mt-4 block">
              來源完整涵蓋到哪一天（不含；留空時不作為官網可售房況）
              <input
                className={field}
                type="date"
                min={mapping.coverageFrom ?? mapping.from}
                max="2100-12-31"
                value={mapping.coverageTo ?? ""}
                onChange={(e) =>
                  changeMapping({ ...mapping, coverageTo: e.target.value || undefined })
                }
              />
            </label>
            {mapping.coverageTo && <label className="mt-4 flex items-start gap-3">
              <input
                type="checkbox"
                checked={coverageConfirmed}
                onChange={(e) => { setCoverageConfirmed(e.target.checked); setConfirmed(false); }}
                className="mt-1"
              />
              <span>我已核對這段期間、所有實體房間的既有訂單與封房，包括其他通路；這是一次匯入快照，日後 OTA 或原檔變動不會自動進入 OS。</span>
            </label>}
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
              disabled={!confirmed || !mappingComplete || (Boolean(mapping.coverageTo) && !coverageConfirmed)}
              onClick={() =>
                run(async () => {
                  const result = await send<ImportPreview>({
                    action: "preview",
                    sourceId: source.id,
                    mapping: { ...mapping, ...(coverageConfirmed ? { coverageConfirmed: true as const } : {}) },
                  });
                  setPreview(result);
                  setPreviewPage(0);
                  setSelection(
                    result.rows
                      .filter((r) => r.draft && !r.issues.length)
                      .map((r) => r.row),
                  );
                })
              }
            >
              產生匯入預覽
            </button>
          </fieldset>
        )}
        {source && !preview && helpCard}
        {preview && (
          <section className="mt-5 rounded-[2rem] border border-white bg-white p-6 shadow-[0_24px_70px_-42px_rgba(15,86,77,0.45)] sm:p-9">
            <div className="flex items-start gap-4">
              <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-xl ${problemRows.length ? "bg-amber-50 text-amber-800" : "bg-teal-50 text-teal-800"}`} aria-hidden="true">
                {problemRows.length ? "!" : "✓"}
              </div>
              <div>
                <h2 className="text-2xl font-semibold text-slate-900">
                  {problemRows.length ? "有幾筆訂房需要核對" : selection.length ? "資料已檢查，可以匯入" : "沒有新的訂房需要匯入"}
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  {problemRows.length
                    ? "有問題的訂房會留在這裡，不會混進日曆。你可以先匯入已確認的訂房。"
                    : "系統已核對日期、房間與重複訂房；原始表格沒有被修改。"}
                </p>
              </div>
            </div>
            <div className="mt-7 grid gap-3 sm:grid-cols-2" role="status">
              <div className="rounded-2xl bg-teal-50 p-5"><strong className="block text-3xl font-semibold text-teal-900">{selection.length}</strong><span className="mt-1 block text-sm text-teal-900">筆可匯入</span></div>
              <div className="rounded-2xl bg-amber-50 p-5"><strong className="block text-3xl font-semibold text-amber-900">{problemRows.length}</strong><span className="mt-1 block text-sm text-amber-900">筆未匯入，需核對或已存在</span></div>
            </div>
            {pastPreviewCount > 0 && <p className="mt-4 text-sm text-slate-500">另有 {pastPreviewCount} 筆在所選日期前退房，已略過。</p>}
            <div className="mt-7 flex flex-wrap items-center gap-3">
              {selection.length > 0 && <button className={`${button} py-4`} disabled={busy} onClick={() => run(commit)}>
                {uncertain ? "重試相同匯入" : `匯入 ${selection.length} 筆並查看日曆 →`}
              </button>}
              {!selection.length && <a href={`/w/${slug}/calendar?property=${encodeURIComponent(property.id)}`} className={secondary}>查看房況日曆</a>}
              <button type="button" className={secondary} disabled={busy || uncertain}
                onClick={() => { setPreview(null); setShowAdvanced(true); setConfirmed(false); }}>
                調整資料辨識
              </button>
            </div>
            <details className="mt-8 border-t border-slate-100 pt-5">
              <summary className="cursor-pointer font-medium text-teal-800">
                {problemRows.length ? `查看 ${problemRows.length} 筆未匯入訂房` : "查看訂房明細"}
              </summary>
              {problemRows.length > 0 && <button type="button" className="mt-4 text-sm text-teal-800 underline" onClick={() => { setShowAllRows((old) => !old); setPreviewPage(0); }}>
                {showAllRows ? "只看未匯入的訂房" : "顯示所有已檢查訂房"}
              </button>}
              <p className="my-4 text-xs leading-6 text-slate-500">每筆訂房的來源與檢查結果都保留在這裡。表格每頁顯示 {PREVIEW_PAGE_SIZE} 筆，翻頁不會清除選擇。</p>
            {previewPages > 1 && (
              <div className="mb-3 flex items-center gap-3 text-sm">
                <button type="button" className={secondary} disabled={previewPage === 0} onClick={() => setPreviewPage((page) => page - 1)}>上一頁</button>
                <span>第 {previewPage + 1}／{previewPages} 頁</span>
                <button type="button" className={secondary} disabled={previewPage + 1 >= previewPages} onClick={() => setPreviewPage((page) => page + 1)}>下一頁</button>
              </div>
            )}
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
                  {visiblePreviewRows.map((r) => (
                    <tr key={r.row}>
                      <td className="border p-2">
                        <input
                          aria-label={`匯入第 ${r.row} 列`}
                          type="checkbox"
                          disabled={busy || uncertain || !!r.issues.length}
                          checked={selectedRows.has(r.row)}
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
                        {r.draft
                          ? (r.draft.guestName || "未填姓名")
                          : (sourceValues(r, mapping.columns.guestName) || "來源姓名未對應")}
                        <br />
                        {r.draft?.externalId && (
                          <>
                            <span className="text-xs">
                              {r.draft.externalId}
                            </span>
                            <br />
                          </>
                        )}
                        {r.draft ? property.rooms
                          .filter((room) => r.draft?.roomIds.includes(room.id))
                          .map((room) => room.name)
                          .join("、") : sourceValues(r, mapping.columns.rooms)}
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
                        {!r.draft && sourceValues(r, mapping.columns.checkIn) && (
                          <span>來源日期：{sourceValues(r, mapping.columns.checkIn)}
                            {sourceValues(r, mapping.columns.checkOut) && ` ～ ${sourceValues(r, mapping.columns.checkOut)}`}
                          </span>
                        )}
                        {r.roomNightCount > 0 && (
                          <span className="text-xs">
                            共 {r.roomNightCount} 個房晚
                          </span>
                        )}
                      </td>
                      <td className="border p-2">{r.draft
                        ? (r.draft.total ?? "未知")
                        : (sourceValues(r, mapping.columns.total)
                          ? `來源房費：${sourceValues(r, mapping.columns.total)}（未核算）`
                          : "來源房費未對應")}</td>
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
            </details>
            {problemRows.length > 0 && helpCard}
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
                  我確認這份資料沒有需要匯入的訂房。
                </span>
              </label>
            )}
            {confirmedEmpty && !selection.length && <button className={`${button} mt-4`} disabled={busy} onClick={() => run(commit)}>
              {uncertain ? "重試相同匯入" : "確認並查看日曆"}
            </button>}
          </section>
        )}
        {!!batches.length && (
          <details className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 text-sm">
            <summary className="cursor-pointer font-medium text-teal-800">管理匯入紀錄</summary>
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
          </details>
        )}
      </div>
    </main>
  );
}
