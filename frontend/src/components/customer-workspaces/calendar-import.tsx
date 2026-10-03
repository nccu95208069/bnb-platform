"use client";
import { useRef, useState } from "react";
import type { Property } from "@/lib/customer-workspaces/types";
import {
  CALENDAR_KINDS,
  CALENDAR_LABELS,
  type CalendarKind,
  type CalendarSnapshot,
  type CalendarMapping,
  type CalendarPreview,
  type CalendarBinding,
  type CalendarBatch,
  type CalendarEventOverride,
} from "@/lib/customer-workspaces/calendar-types";
import { api, button, field, plusDays, secondary, today } from "./client";
import { useCommand } from "./use-command";
import { formatMoney } from "./order-finance";

type Status = {
  version: number;
  sources: CalendarBinding[];
  batches: CalendarBatch[];
  readiness: {
    complete: boolean;
    unresolvedCount: number;
    coverageFrom?: string;
    coverageTo?: string;
    stale?: boolean;
  };
};
const panel = "rounded-2xl border border-slate-200 bg-white p-5 sm:p-6";
const disposition = {
  ready: "可匯入",
  existing: "已匯入，內容相同",
  changed: "既有記錄有變更",
  cancelled: "來源已取消或移除",
  ignored: "已排除",
  issue: "待核對",
};
export function CalendarImport({
  slug,
  property,
  initialKind,
  initialStatus,
  configured,
  syncReady,
  connected,
}: {
  slug: string;
  property: Property;
  initialKind: CalendarKind;
  initialStatus: Status;
  configured: boolean;
  syncReady: boolean;
  connected: boolean;
}) {
  const endpoint = `/api/customer-workspaces/${slug}/calendar-import`;
  const [kind, setKind] = useState(initialKind),
    [status, setStatus] = useState(initialStatus),
    [bindingId, setBindingId] = useState(""),
    [from, setFrom] = useState(today()),
    [to, setTo] = useState(plusDays(today(), 365)),
    [timezone, setTimezone] = useState("Asia/Taipei"),
    [file, setFile] = useState<File | null>(null),
    [calendars, setCalendars] = useState<{ id: string; name: string }[]>([]),
    [googleIds, setGoogleIds] = useState<string[]>([]),
    [source, setSource] = useState<CalendarSnapshot | null>(null),
    [mapping, setMapping] = useState<CalendarMapping>({
      calendarIds: [],
      rooms: {},
      dateMode: "stay",
      titleRooms: false,
      extractLabels: true,
      overrides: {},
    }),
    [preview, setPreview] = useState<CalendarPreview | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [coverage, setCoverage] = useState(false),
    [acceptChanges, setAcceptChanges] = useState(false),
    [mode, setMode] = useState<"migration" | "connected">("migration"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(
      connected ? "Google 授權已完成，請讀取並選擇日曆。" : "",
    );
  const [disconnectConfirmed, setDisconnectConfirmed] = useState(false);
  const disconnect = useCommand(endpoint);
  const running = useRef(false),
    commit = useCommand(endpoint),
    undo = useCommand(endpoint);
  const locked =
    busy ||
    commit.busy ||
    commit.uncertain ||
    undo.busy ||
    undo.uncertain ||
    disconnect.busy ||
    disconnect.uncertain;
  const binding = status.sources.find((b) => b.id === bindingId);
  function clearPreview() {
    setPreview(null);
    setSelected([]);
    setConfirmed(false);
    setCoverage(false);
    setAcceptChanges(false);
    setNotice("");
  }
  function updateMapping(next: CalendarMapping) {
    setMapping(next);
    clearPreview();
  }
  function acceptSource(next: CalendarSnapshot, rules?: CalendarMapping) {
    setSource(next);
    clearPreview();
    const candidates =
      rules ??
      (binding &&
      binding.calendarIds.length === next.calendars.length &&
      binding.calendarIds.every((id) => next.calendars.some((c) => c.id === id))
        ? binding.mapping
        : undefined);
    const savedRules = candidates
      ? {
          ...candidates,
          overrides: Object.fromEntries(
            Object.entries(candidates.overrides).filter(([key]) =>
              next.events.some((e) => e.key === key),
            ),
          ),
        }
      : undefined;
    setMapping(
      savedRules ?? {
        calendarIds: next.calendars.map((c) => c.id),
        rooms: {},
        dateMode: "stay",
        titleRooms: false,
        extractLabels: true,
        overrides: {},
      },
    );
  }
  async function read<T>(input: Record<string, unknown>) {
    return api<T>(endpoint, "POST", { ...input, propertyId: property.id });
  }
  async function work(task: () => Promise<void>) {
    if (running.current || locked) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function showPreview(next: CalendarPreview) {
    setPreview(next);
    setSelected(
      next.rows
        .filter((r) => r.disposition === "ready" && !r.issues.length)
        .map((r) => r.id),
    );
    setConfirmed(false);
    setCoverage(false);
    setAcceptChanges(false);
  }
  async function refreshStatus() {
    setStatus(await read<Status>({ action: "status" }));
  }
  async function save() {
    if (!preview && !commit.uncertain) return;
    const result = await commit.execute<CalendarBatch>({
      action: "commit",
      propertyId: property.id,
      previewId: preview?.id,
      selected,
      confirmed,
      confirmedCoverage: coverage,
      acceptChanges,
      mode,
    });
    if (!result) return;
    setSource(null);
    clearPreview();
    setNotice(
      `匯入已保存並核對：${result.data.bookingIds.length} 筆訂單、${result.data.blockIds.length} 筆封房。${result.data.unresolvedCount ? "仍有資料待確認，房況暫不列為可售。" : "所選日期範圍已核對。"}`,
    );
    try {
      await refreshStatus();
    } catch {
      setError("匯入已保存；狀態暫時未更新，請重新整理。不要重複建立來源。");
    }
  }
  async function undoBatch(batchId?: string) {
    const result = await undo.execute<{ removed: string[]; skipped: string[] }>(
      {
        action: "undo",
        propertyId: property.id,
        batchId,
        version: status.version,
      },
    );
    if (!result) return;
    setSource(null);
    clearPreview();
    setNotice(
      `已撤銷 ${result.data.removed.length} 筆；${result.data.skipped.length} 筆已有修改或收款，保留供人工核對。`,
    );
    try {
      await refreshStatus();
    } catch {
      setError("撤銷已保存；請重新整理確認最新狀態。");
    }
  }
  async function disconnectSource() {
    const result = await disconnect.execute({
      action: "disconnect",
      propertyId: property.id,
      version: status.version,
      confirmed: disconnectConfirmed,
    });
    if (!result) return;
    setSource(null);
    clearPreview();
    setDisconnectConfirmed(false);
    setNotice(
      "已移除本館儲存的 Google 授權並停止同步。訂單與收款仍保留，請重新核對來源後再使用可售房況。",
    );
    try {
      await refreshStatus();
    } catch {
      setError("連線已解除；請重新整理確認狀態。");
    }
  }
  function eventOverride(key: string, changes: CalendarEventOverride) {
    updateMapping({
      ...mapping,
      overrides: {
        ...mapping.overrides,
        [key]: { ...mapping.overrides[key], ...changes },
      },
    });
  }
  const hasChanges = preview?.rows.some(
    (r) =>
      selected.includes(r.id) &&
      ["changed", "cancelled"].includes(r.disposition),
  );
  return (
    <main className="min-h-dvh bg-stone-50 p-4 text-slate-900 sm:p-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <a
          className="text-sm text-teal-800 underline"
          href={`/w/${slug}/calendar?property=${encodeURIComponent(property.id)}`}
        >
          ← 回 {property.name} 房況
        </a>
        <header>
          <p className="mt-4 text-sm font-medium text-teal-800">日曆快速加入</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">
            把日曆紀錄整理成訂單
          </h1>
          <p className="mt-3 max-w-3xl leading-7 text-slate-600">
            選擇來源、確認房間與住宿日期，再預覽匯入。沒有記載的房費與實收會保留未知，多房同一筆訂金只算一次。
          </p>
        </header>
        {notice && (
          <p role="status" className="rounded-xl bg-teal-50 p-4 leading-7">
            {notice}
          </p>
        )}
        {(error || commit.error || undo.error || disconnect.error) && (
          <p role="alert" className="rounded-xl bg-red-50 p-4 leading-7">
            {error || commit.error || undo.error || disconnect.error}
          </p>
        )}
        {(commit.uncertain || undo.uncertain || disconnect.uncertain) && (
          <div className="rounded-xl bg-amber-50 p-4">
            <p>
              結果尚待確認，請保留目前頁面。重試會使用相同內容，避免重複匯入。
            </p>
            <button
              disabled={commit.busy || undo.busy || disconnect.busy}
              className={`${button} mt-3`}
              onClick={() =>
                void (commit.uncertain
                  ? save()
                  : undo.uncertain
                    ? undoBatch()
                    : disconnectSource())
              }
            >
              重試並確認相同操作
            </button>
          </div>
        )}
        <section className={panel}>
          <h2 className="text-lg font-semibold">目前進度</h2>
          <p className="mt-2 text-sm leading-6">
            {status.readiness.complete
              ? `已核對 ${status.readiness.coverageFrom} 至 ${status.readiness.coverageTo}（不含末日）`
              : status.readiness.stale
                ? "同步尚未恢復，未顯示訂單的日期暫不能視為空房。"
                : "尚有來源或資料待核對，未顯示訂單的日期暫不能視為空房。"}
          </p>
          {status.sources.map((s) => (
            <div
              className="mt-3 rounded-xl bg-slate-50 p-3 text-sm leading-6"
              key={s.id}
            >
              <b>{s.name}</b> ·{" "}
              {s.mode === "connected" ? "Google 持續同步" : "一次搬入"}
              <p>
                最後成功讀取：
                {new Date(s.lastSuccessfulAt).toLocaleString("zh-TW")} · 待核對{" "}
                {s.pendingCount + s.issueCount} 筆
                {s.error ? " · 同步中斷，請重新授權或讀取" : ""}
              </p>
              {s.transport === "google" && (
                <button
                  disabled={locked}
                  className={`${secondary} mt-2`}
                  onClick={() =>
                    void work(async () => {
                      const result = await read<{
                        source: CalendarSnapshot;
                        preview: CalendarPreview;
                      }>({ action: "refresh", bindingId: s.id });
                      setBindingId(s.id);
                      setKind(s.kind);
                      setMode(s.mode);
                      setFrom(s.from);
                      setTo(s.to);
                      setTimezone(s.timezone);
                      acceptSource(result.source, result.preview.mapping);
                      showPreview(result.preview);
                    })
                  }
                >
                  重新讀取並核對變更
                </button>
              )}
            </div>
          ))}
        </section>
        {(connected ||
          status.sources.some((s) => s.transport === "google")) && (
          <details className={panel}>
            <summary className="cursor-pointer text-sm font-medium">
              停止本館的 Google 連線
            </summary>
            <p className="mt-3 text-sm leading-6">
              會解除本館所有 Google
              日曆來源在系統內儲存的授權，保留訂單與收款。之後需重新核對來源與完整範圍，才會恢復可售房況；Google
              帳號中的其他應用程式授權不受影響。
            </p>
            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                disabled={locked}
                checked={disconnectConfirmed}
                onChange={(e) => setDisconnectConfirmed(e.target.checked)}
              />
              <span>確認停止本館 Google 同步，並保留已匯入的記錄</span>
            </label>
            <button
              className={`${secondary} mt-3`}
              disabled={locked || !disconnectConfirmed}
              onClick={() => void disconnectSource()}
            >
              解除本館 Google 連線
            </button>
          </details>
        )}
        <fieldset className={panel} disabled={locked || Boolean(source)}>
          <legend className="sr-only">選擇日曆來源</legend>
          <h2 className="text-lg font-semibold">1. 選擇你使用的日曆</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {CALENDAR_KINDS.map((k) => (
              <label
                key={k}
                className={`cursor-pointer rounded-xl border p-4 ${kind === k ? "border-teal-700 bg-teal-50" : "border-slate-200"}`}
              >
                <input
                  type="radio"
                  className="mr-2"
                  name="calendar-kind"
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                {CALENDAR_LABELS[k]}
              </label>
            ))}
          </div>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            {kind === "google_calendar"
              ? "可授權讀取 Google 日曆，或從電腦版 Google 日曆「設定 → 匯入與匯出 → 匯出」下載 ZIP／ICS。"
              : kind === "ios_calendar"
                ? "先在 iPhone／iPad 的「行事曆 → 行事曆」確認帳號。Google 帳號可直接授權；iCloud 可在已同步的 Mac「行事曆 → 檔案 → 輸出 → 輸出」取得 ICS。"
                : "先在日曆 App 的帳號或日曆清單確認來源。Google 帳號可直接授權；其他帳號請從服務商或支援匯出的日曆 App 取得 ICS。"}
          </p>
          {kind !== "google_calendar" && (
            <p className="mt-2 text-sm leading-7 text-slate-600">
              網頁無法直接讀取手機本機日曆。只有存在手機的資料，需先由日曆 App
              匯出，或同步到你自己的 Google 帳號；這裡不會要求 Apple
              ID、手機密碼或公開日曆。
            </p>
          )}
          <label className="mt-4 block">
            這次要更新哪個來源？
            <select
              className={field}
              value={bindingId}
              onChange={(e) => {
                const b = status.sources.find((s) => s.id === e.target.value);
                setBindingId(e.target.value);
                setMode(b?.mode ?? "migration");
                if (b) {
                  setKind(b.kind);
                  setFrom(b.from);
                  setTo(b.to);
                  setTimezone(b.timezone);
                }
              }}
            >
              <option value="">新增來源（首次匯入）</option>
              {status.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <label>
              核對起日
              <input
                className={field}
                type="date"
                value={from}
                min="2000-01-01"
                max="2100-12-30"
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              核對末日（不含當日）
              <input
                className={field}
                type="date"
                value={to}
                min={from}
                max="2100-12-31"
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <label>
              旅宿時區
              <input
                className={field}
                value={timezone}
                maxLength={100}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </label>
          </div>
          <p className="mt-2 text-xs leading-6 text-slate-500">
            每次最多兩年、2,000
            個活動。起日前入住、範圍內仍在住的訂單也會一起核對。
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl bg-slate-50 p-4">
              <h3 className="font-medium">日曆資料存在 Google</h3>
              <p className="my-2 text-sm leading-6">
                授權為唯讀。Google
                權限涵蓋帳號內可讀取的日曆；系統只匯入你接下來勾選的日曆，不會修改
                Google 活動。
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  className={secondary}
                  disabled={!configured}
                  onClick={() =>
                    void work(async () => {
                      const result = await read<{ url: string }>({
                        action: "connect",
                      });
                      window.location.assign(result.url);
                    })
                  }
                >
                  連結 Google 帳號
                </button>
                <button
                  className={secondary}
                  disabled={!configured}
                  onClick={() =>
                    void work(async () => {
                      const result = await read<{
                        calendars: { id: string; name: string }[];
                      }>({ action: "calendars" });
                      setCalendars(result.calendars);
                      setGoogleIds([]);
                    })
                  }
                >
                  讀取可選日曆
                </button>
              </div>
              {!configured && (
                <p className="mt-2 text-sm text-amber-800">
                  此環境尚未設定 Google 授權，可先使用右側日曆檔匯入。
                </p>
              )}
              {calendars.length > 0 && (
                <div className="mt-3 space-y-2">
                  {calendars.map((c) => (
                    <label key={c.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={googleIds.includes(c.id)}
                        onChange={(e) =>
                          setGoogleIds(
                            e.target.checked
                              ? [...googleIds, c.id]
                              : googleIds.filter((id) => id !== c.id),
                          )
                        }
                      />
                      {c.name}
                    </label>
                  ))}
                  <button
                    className={button}
                    disabled={!googleIds.length}
                    onClick={() =>
                      void work(async () => {
                        acceptSource(
                          await read<CalendarSnapshot>({
                            action: "read",
                            kind,
                            from,
                            to,
                            timezone,
                            calendarIds: googleIds,
                          }),
                          binding?.transport === "google"
                            ? binding.mapping
                            : undefined,
                        );
                      })
                    }
                  >
                    讀取選定活動
                  </button>
                </div>
              )}
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <h3 className="font-medium">上傳日曆匯出檔</h3>
              <label className="mt-2 block text-sm">
                ICS 或 ZIP（最多 3 MB）
                <input
                  className={field}
                  type="file"
                  accept=".ics,.zip,text/calendar,application/zip"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <button
                className={`${button} mt-3`}
                disabled={!file}
                onClick={() =>
                  void work(async () => {
                    if (!file || file.size > 3 * 1024 * 1024)
                      throw new Error("請選擇 3 MB 以下的日曆檔。");
                    const query = new URLSearchParams({
                      propertyId: property.id,
                      kind,
                      from,
                      to,
                      timezone,
                      filename: file.name,
                    });
                    const response = await fetch(
                      `${endpoint}/upload?${query}`,
                      {
                        method: "POST",
                        headers: { "Content-Type": "application/octet-stream" },
                        body: file,
                        signal: AbortSignal.timeout(65000),
                      },
                    );
                    const result = await response.json();
                    if (!response.ok)
                      throw new Error(result.detail ?? "無法讀取日曆檔");
                    acceptSource(result);
                  })
                }
              >
                上傳並讀取
              </button>
              <p className="mt-2 text-xs leading-6 text-slate-500">
                檔案僅用於本次匯入。檔案匯入不會持續取得手機或來源日曆的新活動。
              </p>
            </div>
          </div>
        </fieldset>
        {source && (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-slate-600">
                已讀取 {source.events.length} 個活動 · {source.calendars.length}{" "}
                個日曆
              </p>
              <button
                disabled={locked}
                className={secondary}
                onClick={() => {
                  setSource(null);
                  clearPreview();
                }}
              >
                重新選擇來源或日期
              </button>
            </div>
            <fieldset disabled={locked} className={panel}>
              <legend className="sr-only">確認轉換方式</legend>
              <h2 className="text-lg font-semibold">2. 確認房間與紀錄方式</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                每個日曆可代表一間房或整棟。混合多房的日曆可依標題中的完整房名，或逐筆指定。顏色不會自動當成房型。
              </p>
              {source.calendars.map((c) => (
                <div className="mt-4 rounded-xl border p-4" key={c.id}>
                  <label className="flex items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      checked={mapping.calendarIds.includes(c.id)}
                      onChange={(e) => {
                        const ids = e.target.checked
                          ? [...mapping.calendarIds, c.id]
                          : mapping.calendarIds.filter((id) => id !== c.id);
                        updateMapping({
                          ...mapping,
                          calendarIds: ids,
                          rooms: Object.fromEntries(
                            Object.entries(mapping.rooms).filter(([id]) =>
                              ids.includes(id),
                            ),
                          ),
                        });
                      }}
                    />
                    {c.name} · {c.count} 個活動
                  </label>
                  {mapping.calendarIds.includes(c.id) && (
                    <div className="mt-3 flex flex-wrap gap-4">
                      {property.rooms.map((r) => (
                        <label
                          className="flex items-center gap-2 text-sm"
                          key={r.id}
                        >
                          <input
                            type="checkbox"
                            checked={
                              mapping.rooms[c.id]?.includes(r.id) ?? false
                            }
                            onChange={(e) =>
                              updateMapping({
                                ...mapping,
                                rooms: {
                                  ...mapping.rooms,
                                  [c.id]: e.target.checked
                                    ? [...(mapping.rooms[c.id] ?? []), r.id]
                                    : (mapping.rooms[c.id] ?? []).filter(
                                        (id) => id !== r.id,
                                      ),
                                },
                              })
                            }
                          />
                          {r.name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <label className="mt-4 block">
                活動的日期代表什麼？
                <select
                  className={field}
                  value={mapping.dateMode}
                  onChange={(e) =>
                    updateMapping({
                      ...mapping,
                      dateMode: e.target.value as CalendarMapping["dateMode"],
                    })
                  }
                >
                  <option value="stay">
                    活動橫跨完整住宿期間，結束日是退房日
                  </option>
                  <option value="arrival">
                    活動只提醒入住，退房日／晚數寫在文字或逐筆補上
                  </option>
                </select>
              </label>
              <label className="mt-4 flex items-start gap-2">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={mapping.titleRooms}
                  onChange={(e) =>
                    updateMapping({ ...mapping, titleRooms: e.target.checked })
                  }
                />
                <span>
                  未指定房間時，讀取標題內完整房名（房名間用空白或分隔符號）
                </span>
              </label>
              <label className="mt-3 flex items-start gap-2">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={mapping.extractLabels}
                  onChange={(e) =>
                    updateMapping({
                      ...mapping,
                      extractLabels: e.target.checked,
                    })
                  }
                />
                <span>
                  讀取明確文字欄位，例如「客人：王小姐 訂單編號：A123
                  總額：12000 訂金：3000 退房：2026-10-12」
                </span>
              </label>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                同一訂單編號合併為一筆；相同訂金只取一次。有不同金額會留待確認。短時間活動不會自動算一晚。
              </p>
              <details className="mt-5">
                <summary className="cursor-pointer font-medium text-teal-800">
                  逐筆調整、合併訂單或排除私人提醒
                </summary>
                <p className="my-3 text-sm leading-6">
                  不確定的活動可以先保留待核對；排除活動需填原因。不同活動若屬於同一訂單，填相同訂單編號。手動設定會保留；Google
                  原活動變更時需重新核對。調整後需重新產生預覽。
                </p>
                <div className="max-h-[36rem] space-y-3 overflow-auto pr-1">
                  {source.events
                    .filter((e) => mapping.calendarIds.includes(e.calendarId))
                    .map((event) => {
                      const o = mapping.overrides[event.key] ?? {};
                      return (
                        <details
                          key={event.key}
                          className="rounded-xl border p-4"
                        >
                          <summary className="cursor-pointer">
                            <b>{event.title || "未命名活動"}</b>
                            <span className="ml-2 text-sm text-slate-500">
                              {event.start} → {event.end}
                            </span>
                          </summary>
                          {event.description && (
                            <p className="my-3 whitespace-pre-wrap break-words text-sm text-slate-600">
                              {event.description}
                            </p>
                          )}
                          {event.issue && (
                            <p className="my-2 text-sm text-amber-800">
                              {event.issue}
                            </p>
                          )}
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <label>
                              用途
                              <select
                                className={field}
                                value={o.disposition ?? ""}
                                onChange={(e) =>
                                  eventOverride(event.key, {
                                    disposition: (e.target.value ||
                                      undefined) as CalendarEventOverride["disposition"],
                                  })
                                }
                              >
                                <option value="">依規則判讀</option>
                                <option value="booking">住宿訂單</option>
                                <option value="block">封房／維修／自用</option>
                                <option value="ignore">排除此活動</option>
                              </select>
                            </label>
                            <label>
                              排除／封房原因
                              <input
                                className={field}
                                value={o.reason ?? ""}
                                maxLength={500}
                                onChange={(e) =>
                                  eventOverride(event.key, {
                                    reason: e.target.value,
                                  })
                                }
                              />
                            </label>
                            {o.disposition !== "ignore" && (
                              <>
                                <label>
                                  入住日
                                  <input
                                    className={field}
                                    type="date"
                                    value={o.checkIn ?? ""}
                                    onChange={(e) =>
                                      eventOverride(event.key, {
                                        checkIn: e.target.value || undefined,
                                      })
                                    }
                                  />
                                </label>
                                <label>
                                  退房日
                                  <input
                                    className={field}
                                    type="date"
                                    value={o.checkOut ?? ""}
                                    onChange={(e) =>
                                      eventOverride(event.key, {
                                        checkOut: e.target.value || undefined,
                                      })
                                    }
                                  />
                                </label>
                                <label>
                                  訂單編號（同訂單填相同編號）
                                  <input
                                    className={field}
                                    value={o.group ?? ""}
                                    maxLength={100}
                                    onChange={(e) =>
                                      eventOverride(event.key, {
                                        group: e.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <label>
                                  客人（可留白）
                                  <input
                                    className={field}
                                    value={o.guestName ?? ""}
                                    maxLength={100}
                                    onChange={(e) =>
                                      eventOverride(event.key, {
                                        guestName: e.target.value || undefined,
                                      })
                                    }
                                  />
                                </label>
                                <label>
                                  訂單總額（TWD，未知留白）
                                  <input
                                    className={field}
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    value={o.total ?? ""}
                                    onChange={(e) =>
                                      eventOverride(event.key, {
                                        total:
                                          e.target.value === ""
                                            ? null
                                            : Number(e.target.value),
                                      })
                                    }
                                  />
                                </label>
                                <label>
                                  來源累計已付（TWD，未知留白）
                                  <input
                                    className={field}
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    value={o.paid ?? ""}
                                    onChange={(e) =>
                                      eventOverride(event.key, {
                                        paid:
                                          e.target.value === ""
                                            ? null
                                            : Number(e.target.value),
                                      })
                                    }
                                  />
                                </label>
                              </>
                            )}
                          </div>
                          {o.disposition !== "ignore" && (
                            <div className="mt-4 flex flex-wrap gap-4">
                              {property.rooms.map((r) => (
                                <label
                                  key={r.id}
                                  className="flex items-center gap-2 text-sm"
                                >
                                  <input
                                    type="checkbox"
                                    checked={o.roomIds?.includes(r.id) ?? false}
                                    onChange={(e) =>
                                      eventOverride(event.key, {
                                        roomIds: e.target.checked
                                          ? [...(o.roomIds ?? []), r.id]
                                          : (o.roomIds ?? []).filter(
                                              (id) => id !== r.id,
                                            ),
                                      })
                                    }
                                  />
                                  {r.name}
                                </label>
                              ))}
                            </div>
                          )}
                          <button
                            className={`${secondary} mt-3`}
                            onClick={() => {
                              const overrides = { ...mapping.overrides };
                              delete overrides[event.key];
                              updateMapping({ ...mapping, overrides });
                            }}
                          >
                            清除此活動的手動設定
                          </button>
                        </details>
                      );
                    })}
                </div>
              </details>
              <button
                className={`${button} mt-5`}
                disabled={!mapping.calendarIds.length}
                onClick={() =>
                  void work(async () =>
                    showPreview(
                      await read<CalendarPreview>({
                        action: "preview",
                        snapshotId: source.id,
                        mapping,
                        bindingId: bindingId || undefined,
                      }),
                    ),
                  )
                }
              >
                產生匯入預覽
              </button>
            </fieldset>
          </>
        )}
        {preview && source && (
          <fieldset disabled={locked} className={panel}>
            <legend className="sr-only">預覽與確認匯入</legend>
            <h2 className="text-lg font-semibold">3. 核對預覽再匯入</h2>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              可先匯入已核對的資料；未選項目及問題資料會保留待確認，整館暫不列為可售。取消來源活動不會自動退款或釋放房間，需先確認實收為零。
            </p>
            <div className="my-4 space-y-3">
              {preview.rows.map((row) => (
                <div
                  key={row.id}
                  className={`rounded-xl border p-4 ${row.issues.length ? "border-amber-200 bg-amber-50" : "border-slate-200"}`}
                >
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={
                        Boolean(row.issues.length) ||
                        !["ready", "changed", "cancelled"].includes(
                          row.disposition,
                        ) ||
                        (row.disposition === "cancelled" && !row.existingId)
                      }
                      checked={selected.includes(row.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, row.id]
                            : selected.filter((id) => id !== row.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <b>
                        {row.draft?.guestName ||
                          row.titles.join(" ／ ") ||
                          "未命名活動"}
                      </b>
                      <span className="ml-2 text-sm text-slate-500">
                        {disposition[row.disposition]}
                      </span>
                      {row.draft && (
                        <>
                          <span className="mt-1 block text-sm">
                            {row.draft.kind === "block" ? "封房" : "住宿"} ·{" "}
                            {row.draft.stays
                              .map(
                                (s) =>
                                  `${s.checkIn} → ${s.checkOut}｜${s.roomIds.map((id) => property.rooms.find((r) => r.id === id)?.name ?? id).join("、")}`,
                              )
                              .join(" ／ ")}
                          </span>
                          {row.draft.kind === "booking" && (
                            <span className="mt-1 block text-sm">
                              總額：{formatMoney(row.draft.total)} ·
                              來源累計已付：{formatMoney(row.draft.paid)} ·
                              旅宿實收：待確認
                            </span>
                          )}
                        </>
                      )}
                      {row.issues.map((issue) => (
                        <span
                          className="mt-1 block text-sm text-amber-900"
                          key={issue}
                        >
                          {issue}
                        </span>
                      ))}
                    </span>
                  </label>
                </div>
              ))}
            </div>
            {!preview.rows.length && (
              <p className="my-4 rounded-xl bg-slate-50 p-4">
                此範圍沒有活動。請確認已選到完整日曆與日期，再勾選下方確認。
              </p>
            )}
            <label className="block">
              匯入後怎麼新增與調整訂單？
              <select
                className={field}
                value={mode}
                onChange={(e) =>
                  setMode(e.target.value as "migration" | "connected")
                }
              >
                <option value="migration">
                  一次搬入：核對完成後，改在本系統管理訂單
                </option>
                {source.transport === "google" && syncReady && (
                  <option value="connected">
                    Google 持續同步：入住與退房繼續在 Google 日曆修改
                  </option>
                )}
              </select>
            </label>
            <p className="my-3 text-sm leading-6 text-slate-600">
              {mode === "connected"
                ? "系統定期讀取 Google 活動；房況超過 10 分鐘未成功更新即暫停可售判斷。收款在本系統登記，來源金額變更或取消活動會留待你核對。"
                : "來源日曆之後的更動不會自動帶入。請確認切換時間，避免兩邊同時接單；核對範圍外仍不能直接視為空房。"}
            </p>
            {source.transport === "google" && !syncReady && (
              <p className="mb-3 text-sm text-amber-800">
                此環境尚未啟用持續同步，這次只會搬入已核對的資料。
              </p>
            )}
            {hasChanges && (
              <label className="my-3 flex items-start gap-3">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={acceptChanges}
                  onChange={(e) => setAcceptChanges(e.target.checked)}
                />
                <span>
                  我已核對勾選的變更或取消。更新入住、退房與房間時，保留系統內已確認的金額、收退款與備註。
                </span>
              </label>
            )}
            <label className="my-3 flex items-start gap-3">
              <input
                className="mt-1"
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                我已核對房間、入住與退房、訂單分組，以及要匯入的項目。
              </span>
            </label>
            <label className="my-3 flex items-start gap-3">
              <input
                className="mt-1"
                type="checkbox"
                checked={coverage}
                onChange={(e) => setCoverage(e.target.checked)}
              />
              <span>
                這些日曆涵蓋本館所有房間在 {source.from} 至 {source.to}
                （不含末日）的完整訂房與封房紀錄；排除的提醒不占房。
              </span>
            </label>
            <button
              className={`${button} mt-3`}
              disabled={!confirmed || (hasChanges && !acceptChanges)}
              onClick={() => void save()}
            >
              確認匯入 {selected.length} 筆並核對結果
            </button>
          </fieldset>
        )}
        {status.batches.length > 0 && (
          <section className={panel}>
            <h2 className="text-lg font-semibold">最近匯入紀錄</h2>
            <p className="mt-2 text-sm text-slate-600">
              撤銷只處理該批新建、未修改且未登記收款的記錄。已更新的舊訂單會保留，需另行核對。
            </p>
            {status.batches
              .slice()
              .reverse()
              .map((batch) => (
                <div
                  className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm"
                  key={batch.id}
                >
                  <span>
                    {new Date(batch.createdAt).toLocaleString("zh-TW")} ·{" "}
                    {batch.bookingIds.length} 筆訂單、{batch.blockIds.length}{" "}
                    筆封房{batch.undo ? " · 已處理撤銷" : ""}
                  </span>
                  {!batch.undo && (
                    <button
                      disabled={locked}
                      className={secondary}
                      onClick={() => void undoBatch(batch.id)}
                    >
                      撤銷這批未修改的記錄
                    </button>
                  )}
                </div>
              ))}
          </section>
        )}
        {busy && (
          <p role="status" className="text-sm text-teal-800">
            正在讀取與核對，請稍候…
          </p>
        )}
      </div>
    </main>
  );
}
