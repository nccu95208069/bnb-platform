"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Job, Report, Fact } from "@/lib/order-health/types";
import { messageFor } from "@/lib/order-health/messages";
import styles from "./health.module.css";
type ViewJob = Pick<
  Job,
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
      if (data.job) {
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
  const showInput = upload || (!job && !report);
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
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <div>
          <a href={back} className={styles.back}>
            ← 返回工作台
          </a>
          <p className={styles.eyebrow}>{name} · 經營分析</p>
          <h1>訂單健檢</h1>
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
              小時，報告保存 30 天；可在資料與口徑中提前清除明細。AI
              欄位辨識只接收遮蔽後的欄名；問答只使用本報告的彙總數字。來源更新是完整替換快照，不會把消失的資料判定為取消。
            </p>
          </details>
        </section>
      )}
      {!showInput && job && connecting && (
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
      {!showInput && job?.connection?.status === "connected" && !["complete", "failed", "blocked"].includes(job.state) && (
        <div className={styles.connected} role="status">✓ 已取得讀取權限 · {job.sourceTitle}<span>僅讀取，不修改試算表</span></div>
      )}
      {!showInput && job && ["reading", "analyzing"].includes(job.state) && (
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
      {!showInput && job && (job.state === "confirm" || editing) && q && (
        <section className={styles.card}>
          <div className={styles.questionTop}>
            <span>
              確認重點 {qIndex + 1}／{job.questions.length}
            </span>
            <small>整次最多 5 題</small>
          </div>
          <p className={styles.small}>
            {job.sourceTitle} · {job.summary.reduce((s, t) => s + t.rows, 0)}{" "}
            資料列 ·{" "}
            {job.mappingMode === "gemini"
              ? "AI 已協助檢查欄位"
              : "已依欄名辨識"}
          </p>
          <h2>{q.title}</h2>
          <p>{q.note}</p>
          <details>
            <summary>查看來源資料</summary>
            {job.summary
              .filter(
                (t) =>
                  job.summary.length === 1 ||
                  job.answers.table === "all" ||
                  t.id === job.answers.table,
              )
              .map((t) => (
                <div key={t.id}>
                  {t.samples?.map((r) => (
                    <p className={styles.small} key={r.row}>
                      {t.title}!{r.row} ·{" "}
                      {r.values
                        .map((v) => `${v.label}：${v.value}`)
                        .join(" ／ ")}
                    </p>
                  ))}
                </div>
              ))}
          </details>
          <div className={styles.options}>
            {q.options.map((o) => (
              <button
                key={o.value}
                className={job.answers[q.id] === o.value ? styles.selected : ""}
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
                {o.label}
                <span>→</span>
              </button>
            ))}
          </div>
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
      {!showInput && job && job.state === "ready" && !editing && (
        <section className={styles.card}>
          <p className={styles.eyebrow}>已完成 {job.questions.length} 題確認</p>
          <h2>準備好查看分析</h2>
          <p>{job.sourceTitle}</p>
          {job.preview?.error ? (
            <div className={styles.notice}>{messageFor(job.preview.error)}</div>
          ) : (
            job.preview && (
              <div className={styles.notice}>
                可納入 {job.preview.includedRows} 列、{num(job.preview.nights)}{" "}
                房晚；排除 {job.preview.excluded} 列。
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
      {!showInput &&
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
      {!showInput && report && (
        <>
          {job && job.state !== "complete" && (
            <p className={styles.notice}>
              以下保留上次成功報告，更新失敗不會覆蓋。
            </p>
          )}
          <Dashboard
            key={report.snapshot}
            report={report}
            endpoint={endpoint}
            canWrite={state?.canWrite ?? false}
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
      {state && !state.canWrite && (
        <p className={styles.small}>
          目前為唯讀權限，更新資料請聯絡工作區管理者。
        </p>
      )}
    </div>
  );
}
function Dashboard({
  report: r,
  endpoint,
  canWrite,
}: {
  report: Report;
  endpoint: string;
  canWrite: boolean;
}) {
  const [chatOpen, setChatOpen] = useState(false),
    [chart, setChart] = useState("overview"),
    [input, setInput] = useState(""),
    [busy, setBusy] = useState(false),
    [messages, setMessages] = useState<
      { question: string; answer: string; facts: Fact[] }[]
    >([]),
    [chatError, setChatError] = useState("");
  useEffect(() => {
    let active = true;
    fetch(`${endpoint}&chat=${r.id}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw Error(data.error);
        if (active) setMessages(data.history ?? []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [endpoint, r.id]);
  async function ask(question = input) {
    if (!question.trim() || busy) return;
    setBusy(true);
    setChatError("");
    try {
      const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "chat",
            id: r.id,
            message: question,
            chart,
          }),
        }),
        data = await response.json();
      if (!response.ok) throw Error(data.error);
      if (data.snapshot !== r.snapshot)
        throw Error("報告版本已改變，請重新開啟。");
      setMessages((m) => [
        ...m,
        { question, answer: data.answer, facts: data.facts },
      ]);
      setInput("");
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "暫時無法回答");
    } finally {
      setBusy(false);
    }
  }
  const askChart = (id: string) => {
    setChart(id);
    setChatOpen(true);
    setInput("這張圖有哪些數字依據？");
  };
  const max = Math.max(1, ...r.monthly.map((m) => m.nights));
  return (
    <>
      <div className={styles.reportHead}>
        <div>
          <strong>
            {r.from} — {r.to}
          </strong>
          <p className={styles.small}>
            來源：{r.sourceTitle} · 報告產生：
            {new Date(r.createdAt).toLocaleString("zh-TW")}
            <br />
            資料期間依明細推得，來源更新時間未知。
          </p>
        </div>
        <span className={styles.badge}>已完成分析</span>
      </div>
      <div className={styles.insights}>
        {r.insights.map((i) => (
          <article key={i.title} className={styles.insight}>
            <h3>{i.title}</h3>
            <p>{i.body}</p>
            <a href="#health-evidence">查看依據</a>
          </article>
        ))}
      </div>
      <div className={styles.metrics}>
        {[
          ["已訂房晚", num(r.nights), "有效住宿明細"],
          ["可分析房費", num(r.amount), "來源幣別 · 非實收"],
          ["平均房晚價格", num(r.adr), "排除零元與未知金額"],
          ["住房率", "—", "待補每日可售庫存"],
        ].map(([label, value, note]) => (
          <div key={label} className={styles.metric}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </div>
        ))}
      </div>
      <div className={styles.grid}>
        <section className={styles.card}>
          <div className={styles.cardHeading}>
            <h2>月度房晚</h2>
            <button
              className={styles.link}
              disabled={!canWrite}
              onClick={() => askChart("monthly")}
            >
              問這張圖 ↗
            </button>
          </div>
          <p className={styles.small}>按入住日計算；不代表月份資料完整。</p>
          <div
            className={styles.bars}
            role="img"
            aria-label={r.monthly
              .map((m) => `${m.month}：${m.nights} 房晚`)
              .join("；")}
          >
            {r.monthly.map((m) => (
              <div className={styles.barRow} key={m.month}>
                <span>{m.month}</span>
                <div>
                  <i style={{ width: `${(m.nights / max) * 100}%` }} />
                </div>
                <b>{m.nights}</b>
              </div>
            ))}
          </div>
          <details>
            <summary>查看月度明細</summary>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>月份</th>
                    <th>房晚</th>
                    <th>已知房費</th>
                  </tr>
                </thead>
                <tbody>
                  {r.monthly.map((m) => (
                    <tr key={m.month}>
                      <td>{m.month}</td>
                      <td>{num(m.nights)}</td>
                      <td>{num(m.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
        <section className={styles.card}>
          <div className={styles.cardHeading}>
            <h2>通路表現</h2>
            <button
              className={styles.link}
              disabled={!canWrite}
              onClick={() => askChart("channels")}
            >
              問這張圖 ↗
            </button>
          </div>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>通路</th>
                  <th>房晚</th>
                  <th>占比</th>
                  <th>已知房費</th>
                </tr>
              </thead>
              <tbody>
                {r.channels.map((c) => (
                  <tr key={c.channel}>
                    <td>{c.channel}</td>
                    <td>{num(c.nights)}</td>
                    <td>{((c.nights / r.nights) * 100).toFixed(1)}%</td>
                    <td>{num(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className={styles.card}>
          <div className={styles.cardHeading}>
            <h2>房型與星期</h2>
          </div>
          <p className={styles.small}>依來源房號／房型分組，格內數字為房晚。</p>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>來源房間</th>
                  {["日", "一", "二", "三", "四", "五", "六"].map((d) => (
                    <th key={d}>{d}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.rooms.map((room) => (
                  <tr key={room.room}>
                    <td>{room.room}</td>
                    {room.weekdays.map((v, i) => (
                      <td
                        key={i}
                        style={{
                          background: v
                            ? `rgba(32,114,91,${0.07 + (0.3 * v) / Math.max(...room.weekdays, 1)})`
                            : undefined,
                        }}
                      >
                        {v || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className={styles.card}>
          <h2>接單節奏</h2>
          <p>提前預訂中位數</p>
          <strong className={styles.big}>
            {num(r.lead.median)} <small>天</small>
          </strong>
          <p className={styles.small}>
            按入住日與下訂日差值，以房晚加權。已知下訂日涵蓋{" "}
            {num(r.lead.knownNights)}／{num(r.lead.totalNights)} 房晚。
          </p>
          {r.lead.median === null && (
            <p className={styles.notice}>缺少已確認的客人下訂日期。</p>
          )}
        </section>
      </div>
      <details id="health-evidence" className={styles.card}>
        <summary>
          資料與口徑 · 納入 {r.includedRows} 列／排除 {r.excluded.length} 列
        </summary>
        <h3>分析限制</h3>
        <ul>
          {r.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <h3>指標依據</h3>
        {r.facts.map((f) => (
          <details key={f.id}>
            <summary>
              {f.label}：{num(f.value)} {f.unit}
            </summary>
            <p>{f.basis}</p>
            <p className={styles.references}>{f.refs.join("、")}</p>
          </details>
        ))}
        {r.excluded.length > 0 && (
          <>
            <h3>排除清單</h3>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>来源列</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {r.excluded.map((e, i) => (
                    <tr key={i}>
                      <td>{e.ref}</td>
                      <td>{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className={styles.small}>
          快照 {r.snapshot.slice(0, 12)} · 房費計算版本 1
        </p>
      </details>
      {canWrite && (
        <button
          className={styles.chatLauncher}
          onClick={() => {
            setChart("overview");
            setChatOpen(true);
          }}
        >
          ✦ 問小芳
        </button>
      )}
      {chatOpen && (
        <aside
          className={styles.chat}
          role="dialog"
          aria-modal="false"
          aria-labelledby="health-chat-title"
        >
          <div className={styles.cardHeading}>
            <div>
              <h2 id="health-chat-title">和小芳聊這份報告</h2>
              <small>僅引用快照 {r.snapshot.slice(0, 8)} 的數字</small>
            </div>
            <button
              aria-label="關閉問答"
              className={styles.secondary}
              onClick={() => setChatOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className={styles.messages}>
            {messages.length === 0 && (
              <p>
                可以問「已訂房晚有多少？」或從圖表開啟問題。資料不足時，我會說明限制。
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i}>
                <p className={styles.userMessage}>{m.question}</p>
                <p className={styles.answer}>{m.answer}</p>
                {m.facts.map((f) => (
                  <details key={f.id}>
                    <summary>依據：{f.label}</summary>
                    <p>{f.basis}</p>
                    <small>
                      {f.refs.length
                        ? f.refs.join("、")
                        : "請對照本報告的月度／通路明細與來源列。"}
                    </small>
                  </details>
                ))}
              </div>
            ))}
            {busy && <p role="status">正在核對報告依據…</p>}
            {chatError && (
              <p role="alert" className={styles.error}>
                {chatError}
              </p>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <label htmlFor="health-chat-input" className={styles.small}>
              你的問題
            </label>
            <input
              id="health-chat-input"
              maxLength={1000}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="這個月有多少房晚？"
            />
            <button className={styles.primary} disabled={busy || !input.trim()}>
              送出
            </button>
          </form>
        </aside>
      )}
    </>
  );
}
