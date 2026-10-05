"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { receptionChoices, nightLabel, type ReceptionKind } from "@/lib/hospitality-mode";
import type { Job, Report } from "@/lib/order-health/types";
import { messageFor } from "@/lib/order-health/messages";
import type { Recommendation } from "@/lib/order-health/recommend";
import styles from "./health.module.css";
import { AnalysisDashboard } from "./analysis-dashboard";
type ViewJob = Pick<
  Job,
  | "receptionKind"
  | "id"
  | "state"
  | "version"
  | "createdAt"
  | "expiresAt"
  | "sourceTitle"
  | "mappingMode"
  | "questions"
  | "answers"
  | "error"
  | "report"
  | "sourceKind"
  | "connection"
> & {
  sheetUrl: string | null;
  summary: {
    id: string;
    title: string;
    rows: number;
    fields: string[];
    samples?: { row: number; values: { label: string; value: string }[] }[];
  }[];
  preview?: {
    includedRows: number;
    excluded: number;
    nights: number;
    villaNights?: number;
    roomNights?: number;
    money: boolean;
    error?: string;
  } | null;
};
type State = {
  job: ViewJob | null;
  latest: Report | null;
  readerEmail: string | null;
  configured: boolean;
  canWrite: boolean;
  receptionKind: ReceptionKind | null;
};
const num = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
function validSheetLink(value: string) {
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" && u.hostname === "docs.google.com" &&
      !u.username && !u.password && !u.port &&
      /^\/spreadsheets\/d\/[\w-]{20,150}(?:\/|$)/.test(u.pathname);
  } catch { return false; }
}
export function HealthPage({
  workspace,
  property,
  name,
  back = "/calendar",
}: {
  workspace: string;
  property: string;
  name: string;
  back?: string;
}) {
  const endpoint = `/api/order-health?${new URLSearchParams({ workspace, property })}`;
  const [state, setState] = useState<State | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState<"sheet" | "file">("sheet"),
    [url, setUrl] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [upload, setUpload] = useState(false),
    [index, setIndex] = useState<number | null>(null),
    [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [modeEditing, setModeEditing] = useState(false);
  const [suggestion, setSuggestion] = useState<{
    key: string;
    state: "pending" | "done" | "unavailable";
    recommendation: Recommendation | null;
  } | null>(null);
  const requestId = useRef(""), attemptedUrl = useRef(""),
    selectedRef = useRef<HTMLInputElement>(null);
  const job = state?.job;
  const refresh = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" }),
      data = await response.json();
    if (!response.ok) throw Error(data.error);
    setState(data);
  }, [endpoint]);
  useEffect(() => {
    let active = true;
    fetch(endpoint, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        if (active) setState(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  useEffect(() => {
    if (!job || !["checking_access", "awaiting_share", "reading", "analyzing"].includes(job.state)) return;
    const interval = setInterval(
      () => refresh().catch((e) => setError(e.message)),
      2500,
    );
    return () => clearInterval(interval);
  }, [job, refresh]);
  const send = useCallback(async (input: Record<string, unknown> | FormData) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
          method: "POST",
          ...(input instanceof FormData
            ? { body: input }
            : {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
              }),
        }),
        data = await response.json();
      if (!response.ok) throw Error(data.error);
      if ("receptionKind" in data) { setState(data); setUpload(false); }
      else if (data.job) {
        setState((s) => (s ? { ...s, job: data.job } : s));
        setUpload(false);
      } else await refresh();
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "暫時無法完成");
      return null;
    } finally {
      setBusy(false);
    }
  }, [endpoint, refresh]);
  const read = useCallback(async () => {
    if (!requestId.current) requestId.current = crypto.randomUUID();
    setIndex(null);
    setEditing(false);
    if (mode === "file") {
      if (!file) {
        setError("請先選擇檔案。");
        return;
      }
      const form = new FormData();
      form.set("file", file);
      form.set("requestId", requestId.current);
      await send(form);
    } else {
      if (!validSheetLink(url)) { setError("請貼上完整的 Google 試算表連結。"); return; }
      attemptedUrl.current = url.trim();
      await send({ action: "sheet", url: url.trim(), requestId: requestId.current });
    }
  }, [mode, file, send, url]);
  function chooseFile(f: File | null) {
    if (f && (!/\.(xlsx|xls|csv)$/i.test(f.name) || f.size > 3000000)) {
      setError("請選擇 3 MB 以內的 xlsx、xls 或 CSV。");
      return;
    }
    setError("");
    setFile(f);
    requestId.current = "";
  }
  const report = job?.state === "complete" ? job.report : state?.latest;
  const needsReception = Boolean(state && (!state.receptionKind || modeEditing || (job && job.receptionKind !== state.receptionKind)));
  const showInput = !needsReception && (upload || (!job && !report));
  useEffect(() => {
    if (!showInput || mode !== "sheet" || busy || !state?.configured || !state.canWrite ||
      !state.readerEmail || !validSheetLink(url) || attemptedUrl.current === url.trim()) return;
    const timer = setTimeout(() => { void read(); }, 800);
    return () => clearTimeout(timer);
  }, [showInput, mode, busy, state?.configured, state?.canWrite, state?.readerEmail, url, read]);
  const connecting = Boolean(job?.connection && (
    ["checking_access", "awaiting_share"].includes(job.state) ||
    (job.state === "blocked" && ["HEALTH_SHARE_TIMEOUT", "SHEET_READ_FAILED", "SHEET_NOT_SHARED"].includes(job.error ?? ""))
  ));
  const qIndex =
      index ??
      Math.max(0, job?.questions.findIndex((q) => !job.answers[q.id]) ?? 0),
    q = job?.questions[qIndex];
  const suggestionKey = job && q ? `${job.id}:${job.version}:${q.id}` : "";
  const suggestionJobId = job?.id, suggestionQuestionId = q?.id;
  const canSuggest = Boolean(!needsReception && !showInput && job && q && state?.canWrite &&
    (job.state === "confirm" || editing) && ["unit", "money", "date", "booked"].includes(q.id));
  useEffect(() => {
    if (!canSuggest || !suggestionJobId || !suggestionQuestionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    async function fetchSuggestion() {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "suggest", id: suggestionJobId, question: suggestionQuestionId }),
          signal: controller.signal,
        });
        if (!response.ok) throw Error("SUGGESTION_UNAVAILABLE");
        const data = await response.json();
        if (controller.signal.aborted) return;
        const pending = data.state === "pending" && attempts++ < 12;
        setSuggestion({ key: suggestionKey, state: pending ? "pending" : data.state === "done" ? "done" : "unavailable", recommendation: data.recommendation });
        if (pending) timer = setTimeout(fetchSuggestion, 2500);
      } catch {
        if (!controller.signal.aborted)
          setSuggestion({ key: suggestionKey, state: "unavailable", recommendation: null });
      }
    }
    void fetchSuggestion();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [canSuggest, endpoint, suggestionKey, suggestionJobId, suggestionQuestionId]);
  const currentSuggestion = suggestion?.key === suggestionKey ? suggestion : null;
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <div>
          <a href={back} className={styles.back}>
            ← 返回工作台
          </a>
          <p className={styles.eyebrow}>{name} · 經營分析</p>
          <h1>{report ? "訂房分析" : "訂單健檢"}</h1>
          <p>看看你的訂單，藏著哪些經營機會。</p>
        </div>
        {state?.canWrite && (report || job) && (
          <button
            className={styles.secondary}
            onClick={() => {
              setUpload(true);
              requestId.current = "";
              setError("");
            }}
          >
            更新資料
          </button>
        )}
      </header>
      {state?.receptionKind && !needsReception && <div className={styles.receptionSummary}>
        <span>接客形式：{receptionChoices.find((c) => c.value === state.receptionKind)?.label}</span>
        {state.canWrite && <button className={styles.link} disabled={busy} onClick={() => setModeEditing(true)}>修改</button>}
      </div>}
      {needsReception && <section className={styles.card}>
        <p className={styles.eyebrow}>先認識你的民宿</p><h2>你如何接待客人？</h2>
        <div className={styles.options}>{receptionChoices.map((choice) => <button key={choice.value}
          disabled={busy || !state?.canWrite} aria-pressed={state?.receptionKind === choice.value}
          onClick={async () => {
            const result = await send({ action: "reception", kind: choice.value, expected: state?.receptionKind ?? null, requestId: crypto.randomUUID() });
            if (result) { setModeEditing(false); setEditing(false); setIndex(null); requestId.current = ""; attemptedUrl.current = ""; }
          }}><span className={styles.optionCopy}><strong>{choice.label}</strong><span>{choice.detail}</span></span><span aria-hidden="true">→</span></button>)}</div>
        <p className={styles.small}>這會決定晚數與平均價格的算法。既有資料會再確認記法，舊報告保留原口徑。</p>
        {modeEditing && state?.receptionKind && <button className={styles.link} onClick={() => setModeEditing(false)}>取消修改</button>}
        {!state?.canWrite && <p>請旅宿管理者完成設定。</p>}
      </section>}
      {error && (
        <div role="alert" className={styles.error}>
          {error}
          <button
            className={styles.link}
            onClick={() =>
              refresh()
                .then(() => setError(""))
                .catch((e) => setError(e.message))
            }
          >
            重新整理
          </button>
        </div>
      )}
      {!state && !error && <p role="status">正在讀取工作區…</p>}
      {state && !state.configured && (
        <div className={styles.notice}>訂單健檢尚未完成伺服器設定。</div>
      )}
      {(showInput || (job && job.state !== "complete")) && (
        <ol className={styles.steps}>
          {["提供資料", "確認重點", "查看分析"].map((s, i) => (
            <li
              key={s}
              aria-current={
                (showInput || connecting || job?.state === "reading"
                  ? 0
                  : job?.state === "confirm" || job?.state === "ready"
                    ? 1
                    : 2) === i
                  ? "step"
                  : undefined
              }
            >
              <span>{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      )}
      {showInput && state && (
        <section className={styles.card}>
          <p className={styles.eyebrow}>從你的訂單開始</p>
          <h2>連接你的 Google 試算表</h2>
          <p>貼上連結，我們會先檢查讀取權限，再幫你辨識訂單資料。</p>
          <div className={styles.tabs} role="group" aria-label="資料來源">
            <button
              aria-pressed={mode === "sheet"}
              onClick={() => setMode("sheet")}
            >
              Google 試算表
            </button>
            <button
              aria-pressed={mode === "file"}
              onClick={() => setMode("file")}
            >
              上傳檔案
            </button>
          </div>
          {mode === "sheet" ? (
            <>
              <label htmlFor="sheet-url">試算表連結</label>
              <input
                id="sheet-url"
                type="url"
                placeholder="https://docs.google.com/spreadsheets/d/…"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError("");
                  requestId.current = "";
                  attemptedUrl.current = "";
                }}
              />
              <p className={styles.small}>貼上後會自動檢查。若尚未分享，下一步會帶你完成。</p>
              {!state.readerEmail && (
                <div className={styles.notice}>
                  Google 試算表接收帳號尚未設定，請先上傳檔案。
                </div>
              )}
            </>
          ) : (
            <div
              className={styles.drop}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                chooseFile(e.dataTransfer.files[0] ?? null);
              }}
            >
              <strong>{file?.name || "將檔案拖曳到這裡"}</strong>
              <p>Excel（.xlsx／.xls）或 CSV，最大 3 MB</p>
              <input
                ref={selectedRef}
                id="health-file"
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
              />
              <label htmlFor="health-file" className={styles.fileLabel}>
                選擇檔案
              </label>
            </div>
          )}
          <p className={styles.small}>
            最多 12 張工作表、合計 10,000 列、每表 64
            欄。請使用訂單明細格式，包含入住日期、退房日期或晚數。
          </p>
          <div className={styles.actions}>
            <button
              className={styles.primary}
              disabled={
                busy ||
                !state.canWrite ||
                !state.configured ||
                (mode === "sheet" ? !state.readerEmail || !validSheetLink(url) : !file)
              }
              onClick={read}
            >
              {busy ? "正在連接…" : mode === "sheet" ? "檢查試算表連線" : "讀取我的訂單"}
            </button>
            {upload && (
              <button
                className={styles.secondary}
                onClick={() => setUpload(false)}
              >
                返回目前報告
              </button>
            )}
          </div>
          <p className={styles.small}>唯讀分析 · 不修改原始資料 · 最多確認 5 題</p>
          <details className={styles.privacy}>
            <summary>資料如何保存？</summary>
            <p>
              排除已辨識的姓名、電話、信箱與備註欄位。解析後的明細加密保存 24
              小時，報告與每日房晚彙總保存 30 天；可在資料與口徑中提前清除明細。AI
              欄位辨識只接收遮蔽後的欄名；選項建議只使用記錄方式的統計線索，不傳送原始資料列；問答只使用本報告的彙總數字。來源更新是完整替換快照，不會把消失的資料判定為取消。
            </p>
          </details>
        </section>
      )}
      {!needsReception && !showInput && job && connecting && (
        <section className={`${styles.card} ${styles.connectionCard}`} aria-live="polite">
          <div className={styles.connectionHeading}>
            <span className={styles.connectionIcon}>{job.state === "checking_access" ? "↗" : "◎"}</span>
            <div>
              <p className={styles.eyebrow}>Google 試算表連線</p>
              <h2>{job.state === "checking_access" ? "正在檢查讀取權限" :
                job.error === "SHEET_READ_FAILED" ? "Google 暫時無法回應" :
                job.connection?.status === "paused" ? "分享完成後，繼續檢查" : "還差一步：分享試算表"}</h2>
            </div>
          </div>
          {job.state === "checking_access" ? (
            <div className={styles.connectionStatus} role="status"><div className={styles.spinner} /><span>正在向 Google 確認連線，請稍候…</span></div>
          ) : (
            <>
              <p>{job.error === "SHEET_READ_FAILED" ? "這次未能確認權限，請稍後重試。你的分享設定不一定有問題。" :
                "我們目前還讀不到這份試算表。請先確認連結正確，再完成以下分享設定。"}</p>
              <ol className={styles.shareSteps}>
                <li><strong>開啟試算表，點右上角「共用」</strong>{job.sheetUrl && <a className={styles.link} href={job.sheetUrl} target="_blank" rel="noopener noreferrer">開啟我的試算表 ↗</a>}</li>
                <li><strong>加入以下帳號，權限選「檢視者」</strong><div className={styles.readerBox}>
                  <code>{state?.readerEmail}</code>
                  <button className={styles.secondary} onClick={async () => {
                    try { await navigator.clipboard.writeText(state?.readerEmail ?? ""); setCopied(true); }
                    catch { setError("請手動複製上方帳號。"); }
                  }}>{copied ? "已複製" : "複製帳號"}</button>
                </div></li>
                <li><strong>按「傳送」或「分享」，回到這裡</strong><span>不用設成公開。偵測成功後，會自動讀取資料並進入下一步。</span></li>
              </ol>
              <div className={styles.connectionStatus} role="status">
                {job.state === "awaiting_share" && <span className={styles.statusDot} />}
                <span>{job.state === "awaiting_share" ? "自動偵測中 · 每 10 秒檢查一次" : "自動檢查已暫停，可隨時繼續"}
                  {job.connection?.checkedAt && <small>上次檢查 {new Date(job.connection.checkedAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small>}
                </span>
              </div>
            </>
          )}
          <div className={styles.actions}>
            {job.state !== "checking_access" && <button className={styles.primary} disabled={busy || !state?.canWrite}
              onClick={() => send({ action: "check_access", id: job.id })}>{busy ? "正在確認…" : job.state === "awaiting_share" ? "我已分享，立即檢查" : "重新檢查"}</button>}
            <button className={styles.secondary} disabled={busy || !state?.canWrite} onClick={async () => {
              const result = await send({ action: "delete-source", id: job.id });
              if (result) { setUpload(true); setUrl(""); requestId.current = ""; attemptedUrl.current = ""; }
            }}>更換連結</button>
          </div>
          <p className={styles.small}>自動檢查會持續 15 分鐘；關閉頁面後，背景仍會每分鐘檢查。</p>
        </section>
      )}
      {!needsReception && !showInput && job?.connection?.status === "connected" && !["complete", "failed", "blocked"].includes(job.state) && (
        <div className={styles.connected} role="status">✓ 已取得讀取權限 · {job.sourceTitle}<span>僅讀取，不修改試算表</span></div>
      )}
      {!needsReception && !showInput && job && ["reading", "analyzing"].includes(job.state) && (
        <section className={styles.card} role="status">
          <div className={styles.spinner} />
          <h2>
            {job.state === "reading"
              ? "正在讀取與辨識資料"
              : "正在計算指標與整理報告"}
          </h2>
          <p>{job.sourceTitle}</p>
          <p className={styles.small}>可以關閉頁面，稍後回來接續查看。</p>
        </section>
      )}
      {!needsReception && !showInput && job && (job.state === "confirm" || editing) && q && (
        <section className={styles.card}>
          <div className={styles.questionTop}>
            <span>
              確認重點 {qIndex + 1}／{job.questions.length}
            </span>
            <small>整次最多 5 題</small>
          </div>
          <p className={styles.small}>
            {job.sourceTitle} · {job.summary.reduce((s, t) => s + t.rows, 0)}{" "}
            列
          </p>
          <h2>{q.title}</h2>
          {q.id === "unit" && job.receptionKind !== "mixed" ? (
            <article className={styles.exampleOrder} aria-label={job.receptionKind === "villa" ? "示意包棟訂單，9 月 1 日入住，9 月 3 日退房，共 2 晚" : "示意訂單：201 河景雙人房，9 月 1 日入住，9 月 3 日退房，共 2 晚"}>
              <div className={styles.exampleOrderHeader}>
                <span>示意訂單</span>
                <span className={styles.exampleOrderStay}>{job.receptionKind === "villa" ? "1 組客人 · 2 晚" : "1 間房 · 2 晚"}</span>
              </div>
              <h3>{job.receptionKind === "villa" ? "整棟包棟" : "201 河景雙人房"}</h3>
              <div className={styles.exampleOrderDates}>
                <div><span>入住</span><strong>9/1</strong></div>
                <span className={styles.exampleOrderArrow} aria-hidden="true">→</span>
                <div><span>退房</span><strong>9/3</strong></div>
              </div>
            </article>
          ) : q.note && <p>{q.note}</p>}
          {canSuggest && <p className={styles.suggestionStatus} role="status">
            {!currentSuggestion || currentSuggestion.state === "pending" ? "AI 正在看你的資料…" :
              currentSuggestion.recommendation ? `AI 判斷依據：${currentSuggestion.recommendation.reason}` :
                currentSuggestion.state === "unavailable" ? "AI 暫時無法判斷，你可以直接選擇。" : "目前線索不足，請選最接近的記法。"}
          </p>}
          <div className={styles.options}>
            {q.options.map((o) => (
              <button
                key={o.value}
                className={`${job.answers[q.id] === o.value ? styles.selected : ""} ${o.value === "skip" ? styles.skipOption : ""} ${currentSuggestion?.recommendation?.value === o.value ? styles.recommended : ""}`}
                aria-pressed={job.answers[q.id] === o.value}
                disabled={
                  busy ||
                  !state?.canWrite ||
                  Boolean(
                    q.id === "table" &&
                    job.answers.table &&
                    job.answers.table !== o.value,
                  )
                }
                onClick={async () => {
                  const data = await send({
                    action: "answer",
                    id: job.id,
                    version: job.version,
                    answers: { [q.id]: o.value },
                  });
                  if (data) {
                    if (editing && qIndex < job.questions.length - 1)
                      setIndex(qIndex + 1);
                    else {
                      setIndex(null);
                      setEditing(false);
                    }
                  }
                }}
              >
                <span className={styles.optionCopy}>
                  <strong>{o.label}</strong>
                  {currentSuggestion?.recommendation?.value === o.value && <span className={styles.recommendBadge}>AI 判斷較可能</span>}
                  {o.description && <span>{o.description}</span>}
                </span>
                <span className={styles.optionArrow} aria-hidden="true">→</span>
              </button>
            ))}
          </div>
          <details key={q.id} className={styles.sourcePreview}>
            <summary>查看我的資料</summary>
            {job.summary
              .filter(
                (t) =>
                  job.summary.length === 1 ||
                  job.answers.table === "all" ||
                  t.id === job.answers.table,
              )
              .map((t) => (
                <div key={t.id} className={styles.sourceTable}>
                  <strong>{t.title}</strong>
                  {t.samples?.map((r) => (
                    <div className={styles.sourceRow} key={r.row}>
                      <span className={styles.rowNumber}>第 {r.row} 列</span>
                      <dl>{r.values.map((v, i) => (
                        <div key={i}><dt>{v.label}</dt><dd>{v.value}</dd></div>
                      ))}</dl>
                    </div>
                  ))}
                </div>
              ))}
          </details>
          {editing && (
            <button
              className={styles.link}
              onClick={() => {
                if (qIndex < job.questions.length - 1) setIndex(qIndex + 1);
                else {
                  setEditing(false);
                  setIndex(null);
                }
              }}
            >
              保留答案，繼續 →
            </button>
          )}
          {qIndex > 0 && (
            <button
              className={styles.link}
              onClick={() => setIndex(qIndex - 1)}
            >
              ← 返回上一題
            </button>
          )}
        </section>
      )}
      {!needsReception && !showInput && job && job.state === "ready" && !editing && (
        <section className={styles.card}>
          <p className={styles.eyebrow}>已完成 {job.questions.length} 題確認</p>
          <h2>準備好查看分析</h2>
          <p>{job.sourceTitle}</p>
          {job.preview?.error ? (
            <div className={styles.notice}>{messageFor(job.preview.error)}</div>
          ) : (
            job.preview && (
              <div className={styles.notice}>
                可納入 {job.preview.includedRows} 列；{job.receptionKind === "mixed"
                  ? `包棟 ${num(job.preview.villaNights ?? 0)} 晚、散客 ${num(job.preview.roomNights ?? 0)} 房晚`
                  : `${num(job.preview.nights)} ${nightLabel(job.receptionKind)}`}；排除 {job.preview.excluded} 列。
                <br />
                {job.preview.money ? "可分析已知房費。" : "暫不分析房費。"}
                住房率與未來空檔尚未啟用。
              </div>
            )
          )}
          <p className={styles.small}>
            報告將保存本次口徑與來源列號，金額不足的區塊會標示限制。
          </p>
          <div className={styles.actions}>
            <button
              className={styles.primary}
              disabled={busy || !state?.canWrite || Boolean(job.preview?.error)}
              onClick={() =>
                send({ action: "start", id: job.id, version: job.version })
              }
            >
              開始分析
            </button>
            <button
              className={styles.secondary}
              onClick={() => {
                setIndex(0);
                setEditing(true);
              }}
            >
              修改答案
            </button>
          </div>
        </section>
      )}
      {!needsReception && !showInput &&
        job &&
        ["blocked", "failed"].includes(job.state) &&
        !connecting &&
        !editing && (
          <section className={styles.card}>
            <h2>目前資料不足以產生可信報告</h2>
            <p>{messageFor(job.error || "HEALTH_EMPTY")}</p>
            <div className={styles.actions}>
              <button
                className={styles.primary}
                onClick={() => {
                  setUpload(true);
                  requestId.current = "";
                }}
              >
                更換來源
              </button>
              {job.questions.length > 0 && (
                <button
                  className={styles.secondary}
                  onClick={() => {
                    setIndex(0);
                    setEditing(true);
                  }}
                >
                  修改答案
                </button>
              )}
            </div>
          </section>
        )}
      {!needsReception && !showInput && report && (!state?.receptionKind || report.receptionKind === state.receptionKind) && (
        <>
          {job && job.state !== "complete" && (
            <p className={styles.notice}>
              以下保留上次成功報告，仍採用當時接客形式與口徑；完成新分析後才會更新。
            </p>
          )}
          <AnalysisDashboard
            key={report.snapshot}
            report={report}
          />
          {state?.canWrite && job?.state === "complete" && (
            <button
              className={styles.link}
              disabled={busy}
              onClick={() => send({ action: "delete-source", id: job.id })}
            >
              提前清除本次解析明細（保留報告）
            </button>
          )}
          {state?.canWrite && job?.state === "complete" && (
            <button
              className={styles.secondary}
              disabled={busy}
              onClick={async () => {
                const data = await send({
                  action: "revise",
                  id: job.id,
                  requestId: crypto.randomUUID(),
                });
                if (data) {
                  setIndex(0);
                  setEditing(true);
                }
              }}
            >
              分析設定
            </button>
          )}
        </>
      )}
      {!needsReception && report && report.receptionKind !== state?.receptionKind && !showInput && !job && <section className={styles.card}>
        <h2>請重新讀取訂單</h2><p>原始明細已到期，舊報告尚未套用接客形式。重新匯入後會以正確單位計算。</p>
        <button className={styles.primary} disabled={!state?.canWrite} onClick={() => setUpload(true)}>更新資料</button>
      </section>}
      {state && !state.canWrite && (
        <p className={styles.small}>
          目前為唯讀權限，更新資料請聯絡工作區管理者。
        </p>
      )}
    </div>
  );
}
