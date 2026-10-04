"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Fact, Report } from "@/lib/order-health/types";
import { analysisView, checkedFilter, formatNumber as num, PRESETS, presetPeriod, taipeiDate, type AnalysisView, type ViewFilter } from "@/lib/order-health/analytics";
import styles from "./health.module.css";

type Metric = "nights" | "amount" | "adr";
const metricLabels: Record<Metric, string> = { nights: "已訂房晚", amount: "已知房費", adr: "平均房晚價格" };
const changeText = (value: number | null) => value === null ? "未建立可比前期" : `${value > 0 ? "↑" : value < 0 ? "↓" : "→"} ${num(Math.abs(value))}% · 較前期紀錄`;
function Trend({ points, metric }: { points: AnalysisView["series"]; metric: Metric }) {
  const maximum = Math.max(1, ...points.map((p) => p[metric] ?? 0));
  const x = (i: number) => points.length === 1 ? 400 : 42 + i / (points.length - 1) * 706;
  const y = (v: number) => 184 - v / maximum * 142;
  let path = "", connected = false;
  points.forEach((p, i) => {
    const value = p[metric];
    if (value === null) { connected = false; return; }
    path += `${connected ? "L" : "M"}${x(i)},${y(value)} `;
    connected = true;
  });
  const ticks = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter((i) => i >= 0);
  return <svg className={styles.trendChart} viewBox="0 0 790 224" role="img" aria-label={`${metricLabels[metric]}趨勢，可展開下方數據表查看精確數字`}>
    {[0, .5, 1].map((fraction) => <g key={fraction}>
      <line x1="42" x2="748" y1={y(maximum * fraction)} y2={y(maximum * fraction)} stroke="#e4ebe5" strokeDasharray="4 5" />
      <text x="38" y={y(maximum * fraction) - 7} fill="#839084" fontSize="11">{num(maximum * fraction)}</text>
    </g>)}
    <path d={path} fill="none" stroke="#37775d" strokeWidth="2.5" strokeLinejoin="round" />
    {points.map((p, i) => p[metric] !== null && <circle key={p.date} cx={x(i)} cy={y(p[metric]!)} r="3" fill="#37775d">
      <title>{p.date} · {metricLabels[metric]} {num(p[metric])}{!p.observed ? "（本次資料未見紀錄）" : ""}</title>
    </circle>)}
    {ticks.map((i) => <text key={i} x={x(i)} y="212" textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} fill="#6b7f70" fontSize="12">{points[i].date}</text>)}
  </svg>;
}
function Distribution({ title, labels, values }: { title: string; labels: string[]; values: number[] }) {
  const total = values.reduce((sum, n) => sum + n, 0);
  return <div className={styles.distribution}>
    <h3>{title}</h3>
    {labels.map((label, i) => <div className={styles.distributionRow} key={label}>
      <span>{label}</span><div><i style={{ width: `${total ? values[i] / total * 100 : 0}%` }} /></div>
      <b>{total ? num(values[i] / total * 100) : "—"}%</b>
    </div>)}
  </div>;
}
export function AnalysisDashboard({ report: r, endpoint, canWrite }: { report: Report; endpoint: string; canWrite: boolean }) {
  const [today] = useState(() => taipeiDate());
  const [filter, setFilter] = useState<ViewFilter>(() => presetPeriod("last30", r, today));
  const [preset, setPreset] = useState("last30");
  const [from, setFrom] = useState(filter.from), [to, setTo] = useState(filter.to), [filterError, setFilterError] = useState("");
  const [metric, setMetric] = useState<Metric>("nights");
  const v = useMemo(() => analysisView(r, filter, today), [r, filter, today]);
  const [chatOpen, setChatOpen] = useState(false), [chart, setChart] = useState("overview"),
    [input, setInput] = useState(""), [busy, setBusy] = useState(false), [chatError, setChatError] = useState("");
  const [messages, setMessages] = useState<{ question: string; answer: string; facts: Fact[] }[]>([]);
  const messageEnd = useRef<HTMLDivElement>(null);
  const chatInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    fetch(`${endpoint}&chat=${r.id}`, { cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      if (active && response.ok) setMessages((current) => current.length ? current : data.history ?? []);
    }).catch(() => {});
    return () => { active = false; };
  }, [endpoint, r.id]);
  useEffect(() => { if (chatOpen) chatInput.current?.focus(); }, [chatOpen]);
  useEffect(() => { if (chatOpen) messageEnd.current?.scrollIntoView({ block: "nearest" }); }, [messages.length, chatOpen, busy]);
  const choosePeriod = (key: string) => {
    const period = presetPeriod(key, r, today);
    setPreset(key); setFrom(period.from); setTo(period.to); setFilterError("");
    setFilter((current) => ({ ...current, ...period }));
  };
  async function ask(question = input, focus = chart) {
    if (!question.trim() || busy) return;
    setBusy(true); setChatError(""); setChatOpen(true);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "chat", id: r.id, message: question, chart: focus, filter }) });
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      if (data.snapshot !== r.snapshot) throw Error("報告已更新，請重新整理。");
      setMessages((current) => [...current, { question, answer: data.answer, facts: data.facts }]); setInput("");
    } catch (e) { setChatError(e instanceof Error ? e.message : "暫時無法回答，請稍後重試。"); }
    finally { setBusy(false); }
  }
  const askChart = (focus: string, question: string) => { setChart(focus); void ask(question, focus); };
  const exportCsv = () => {
    const rows = [["期間", "已訂房晚", "已知房費", "平均房晚價格", "金額覆蓋率%"],
      ...v.series.map((p) => [p.date, p.nights, p.amount ?? "", p.adr ?? "", p.coverage ?? ""])];
    const csv = "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a"); link.href = url; link.download = `訂房分析-${filter.from}-${filter.to}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  const scopeLabel = [filter.channel, filter.room].filter(Boolean).join(" · ");
  return <>
    <div className={styles.reportHead}>
      <div><strong>經營報告</strong><p className={styles.small}>來源：{r.sourceTitle} · 匯入快照 {new Date(r.createdAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}<br />資料有紀錄的範圍：{r.from} — {r.to}；來源更新時間未知。</p></div>
      <span className={styles.badge}>依你的資料分析</span>
    </div>
    {r.analysis ? <>
      {r.analysis.asOf < today && <p className={styles.notice}>這份資料快照截至 {r.analysis.asOf}，之後的訂房變動尚未納入；可用上方「更新資料」重新讀取。</p>}
      <section className={`${styles.card} ${styles.analysisFilters}`} aria-label="分析範圍">
        <div className={styles.periodPresets}>{PRESETS.map(([key, label]) => <button key={key} aria-pressed={preset === key} onClick={() => choosePeriod(key)}>{label}</button>)}</div>
        <div className={styles.filterControls}>
          <form onSubmit={(e) => { e.preventDefault(); try { const next = checkedFilter({ ...filter, from, to }, r); setFilter(next); setPreset("custom"); setFilterError(""); } catch { setFilterError("請選擇有效的起訖日期，範圍最多 10 年。"); } }}>
            <label>從<input aria-label="分析開始日期" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>到<input aria-label="分析結束日期" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <button className={styles.secondary} type="submit">套用</button>
          </form>
          {r.analysis.dimensions && <>
            <label>通路<select value={filter.channel ?? ""} onChange={(e) => setFilter((current) => ({ ...current, channel: e.target.value || undefined }))}><option value="">全部通路</option>{r.channels.map((c) => <option key={c.channel}>{c.channel}</option>)}</select></label>
            <label>房號／房型<select value={filter.room ?? ""} onChange={(e) => setFilter((current) => ({ ...current, room: e.target.value || undefined }))}><option value="">全部房間</option>{r.rooms.map((room) => <option key={room.room}>{room.room}</option>)}</select></label>
          </>}
        </div>
        {filterError && <p role="alert" className={styles.error}>{filterError}</p>}
        <p className={styles.small}>住宿日期 {filter.from} — {filter.to}{scopeLabel ? ` · ${scopeLabel}` : ""}{v.comparison ? ` ／ 前期 ${v.previousPeriod.from} — ${v.previousPeriod.to}` : ""}。{v.warning}</p>
      </section>
      <section className={styles.brief} aria-labelledby="analysis-brief-title">
        <div className={styles.cardHeading}><div><p className={styles.eyebrow}>這段期間，先看重點</p><h2 id="analysis-brief-title">{v.insights[0].title}</h2></div>
          {canWrite && <button className={styles.secondary} disabled={busy} onClick={() => askChart("overview", "幫我解讀目前這段期間的訂房表現")}>讓小芳解讀 ↗</button>}
        </div>
        <p>{v.insights[0].body}</p>
        <div className={styles.briefNext}><span>先做這件事</span>{v.insights[0].action}</div>
        {!v.total.nights && <button className={styles.link} onClick={() => choosePeriod("all")}>查看全部資料 →</button>}
      </section>
      <div className={styles.metrics}>
        {[
          ["已訂房晚", num(v.total.nights), changeText(v.change.nights)],
          ["已知房費", num(v.total.amount), v.total.coverage !== null && v.total.coverage < 100 ? `金額覆蓋 ${num(v.total.coverage)}% · 非完整營收` : changeText(v.change.amount)],
          ["平均房晚價格", num(v.total.adr), "正金額房費 ÷ 正金額房晚"],
          ["金額覆蓋", v.total.coverage === null ? "—" : `${num(v.total.coverage)}%`, `${num(v.total.knownNights)}／${num(v.total.nights)} 房晚有金額`],
        ].map(([label, value, note]) => <div className={styles.metric} key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}
      </div>
      <section className={styles.card}>
        <div className={styles.cardHeading}><div><h2>表現趨勢</h2><p className={styles.small}>{v.series[0]?.date.length === 7 ? "按月彙總" : "按住宿日期"} · 金額依來源幣別，跨晚房費平均分攤。</p></div>
          {canWrite && <button className={styles.link} disabled={busy} onClick={() => askChart("monthly", "這段期間的表現有什麼變化？")}>問小芳 ↗</button>}
        </div>
        <div className={styles.metricSwitch}>{(["nights", "amount", "adr"] as Metric[]).map((key) => <button key={key} aria-pressed={metric === key} onClick={() => setMetric(key)}>{metricLabels[key]}</button>)}</div>
        <div className={styles.trendViewport}><Trend points={v.series} metric={metric} /></div>
        <p className={styles.small}>房晚 0 代表本次匯入未見紀錄；缺少金額的日期不連線，並不表示房價為 0。</p>
        <details><summary>查看數據表</summary><button className={styles.link} onClick={exportCsv}>下載這段期間 CSV</button><div className={styles.tableWrap}><table>
          <thead><tr><th>日期</th><th>房晚</th><th>已知房費</th><th>平均房晚價格</th><th>金額覆蓋</th></tr></thead>
          <tbody>{v.series.map((p) => <tr key={p.date}><td>{p.date}</td><td>{num(p.nights)}</td><td>{num(p.amount)}</td><td>{num(p.adr)}</td><td>{p.coverage === null ? "—" : `${num(p.coverage)}%`}</td></tr>)}</tbody>
        </table></div></details>
      </section>
      {r.analysis.dimensions && <div className={styles.grid}>
        {(["channels", "rooms"] as const).map((kind) => <section className={styles.card} key={kind}>
          <div className={styles.cardHeading}><h2>{kind === "channels" ? "訂房從哪裡來" : "哪些房間帶來訂房"}</h2>{canWrite && <button className={styles.link} disabled={busy} onClick={() => askChart(kind, kind === "channels" ? "這段期間哪個通路值得注意？" : "這段期間各房型表現如何？")}>問小芳 ↗</button>}</div>
          <p className={styles.small}>{kind === "channels" ? "先看房晚，再看房價；尚未扣除佣金與成本。" : "依來源房號／房型分組；未提供各房型庫存，無法比較住房率。"}</p>
          <div className={styles.tableWrap}><table><thead><tr><th>{kind === "channels" ? "通路" : "來源房間"}</th><th>房晚</th><th>占比</th><th>已知房費</th><th>均價</th></tr></thead>
            <tbody>{v[kind].map((g) => <tr key={g.name}><td><button className={styles.dimensionLink} onClick={() => setFilter((current) => ({ ...current, [kind === "channels" ? "channel" : "room"]: g.name }))}>{g.name}</button></td><td>{num(g.nights)}</td><td>{num(v.total.nights ? g.nights / v.total.nights * 100 : 0)}%</td><td>{num(g.amount)}</td><td>{num(g.adr)}</td></tr>)}</tbody>
          </table></div>{!v[kind].length && <p>這段期間沒有符合篩選的紀錄。</p>}
        </section>)}
      </div>}
      <div className={styles.grid}>
        <section className={styles.card}>
          <div className={styles.cardHeading}><h2>一週哪幾天較有訂房</h2>{canWrite && <button className={styles.link} disabled={busy} onClick={() => askChart("weekday", "平日和週末的訂房分布如何？")}>問小芳 ↗</button>}</div>
          <p className={styles.small}>每個星期的平均可見房晚，已除以期間內該星期出現次數。</p>
          <div className={styles.weekdayChart}>{[1, 2, 3, 4, 5, 6, 0].map((day) => { const d = v.weekdays[day]; return <div key={day}>
            <strong>{num(d.perDay)}</strong><div><i style={{ height: `${d.perDay / Math.max(1, ...v.weekdays.map((w) => w.perDay)) * 100}%`, background: day === 5 || day === 6 ? "#47785e" : "#a0b7a3" }} /></div><span>週{"日一二三四五六"[day]}</span>
          </div>; })}</div>
          <p className={styles.small}>深色標示週五、週六住宿夜；國定假日尚未另外分類。</p>
        </section>
        <section className={styles.card}>
          <div className={styles.cardHeading}><h2>接下來的已訂情況</h2>{canWrite && <button className={styles.link} disabled={busy} onClick={() => askChart("overview", "未來30天的訂房狀況如何？")}>問小芳 ↗</button>}</div>
          <p className={styles.small}>{v.futurePeriod.from} — {v.futurePeriod.to} · 依目前快照</p>
          <strong className={styles.big}>{num(v.future.nights)} <small>房晚已訂</small></strong>
          <p>已知房費 {num(v.future.amount)}。這是目前已存在的訂房，後續可能新增、改期或取消。</p>
          {r.analysis.bookingDates.length > 0 && <div className={styles.bookingNote}><strong>近 7 天建立、目前仍有效</strong><span>{num(v.bookingNights)} 房晚</span><small>按下訂日期；不是淨新增訂房（Pickup）。</small></div>}
        </section>
      </div>
      {(v.total.los !== null || v.total.lead !== null) && <section className={styles.card}>
        <div className={styles.cardHeading}><h2>客人的預訂習慣</h2>{canWrite && <button className={styles.link} disabled={busy} onClick={() => askChart("behavior", "客人通常提前多久訂、住幾晚？")}>問小芳 ↗</button>}</div>
        <div className={styles.behaviorGrid}>
          {v.total.los !== null && <div><p className={styles.small}>平均住宿長度</p><strong className={styles.big}>{num(v.total.los)} <small>晚／房次</small></strong><Distribution title="常見住法" labels={["1 晚", "2 晚", "3–4 晚", "5 晚以上"]} values={v.los} /></div>}
          {v.total.lead !== null && <div><p className={styles.small}>平均提前預訂</p><strong className={styles.big}>{num(v.total.lead)} <small>天</small></strong><Distribution title="提前多久訂" labels={["0–2 天", "3–7 天", "8–30 天", "31–60 天", "61 天以上"]} values={v.lead} /></div>}
        </div><p className={styles.small}>以這段期間入住的房次加權，住宿長度包含整次住宿；提前天數只採用可確認的下訂日。每間房的一次住宿算一房次。</p>
      </section>}
      <section className={styles.card}>
        <div className={styles.cardHeading}><h2>接著可以做什麼</h2>{canWrite && <button className={styles.link} disabled={busy} onClick={() => askChart("overview", "根據目前這段期間，先做哪幾件事最有幫助？")}>和小芳討論 ↗</button>}</div>
        <div className={styles.actionCards}>{v.insights.map((i, index) => <article key={i.id}><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{i.title}</h3><p>{i.body}</p><strong>{i.action}</strong></div></article>)}</div>
      </section>
    </> : <section className={styles.card}><h2>這份報告的總覽</h2><p>{r.from} — {r.to} · {num(r.nights)} 房晚 · 已知房費 {num(r.amount)}</p><p>原始資料已到期或尚未完成新版整理。重新匯入可使用期間比較、房型拆解與接單習慣分析；小芳仍可說明這份報告的已有數字。</p><div className={styles.tableWrap}><table><thead><tr><th>月份</th><th>房晚</th><th>已知房費</th></tr></thead><tbody>{r.monthly.map((m) => <tr key={m.month}><td>{m.month}</td><td>{num(m.nights)}</td><td>{num(m.amount)}</td></tr>)}</tbody></table></div></section>}
    <details id="health-evidence" className={styles.card}>
      <summary>資料依據與待補項目 · 納入 {r.includedRows} 列／排除 {r.excluded.length} 列</summary>
      <div className={styles.dataGaps}>
        <div><strong>住房率、RevPAR、空房</strong><p>需要每日可售實體房數、停賣紀錄及包棟共用庫存規則。</p></div>
        <div><strong>淨收益</strong><p>需要佣金、稅費與成本；目前呈現的是來源中的已知房費。</p></div>
        <div><strong>淨新增訂房、去年同時點比較</strong><p>需要歷史快照與取消／改期紀錄；單次匯入不能還原完整接單變化。</p></div>
        {r.analysis?.unit === "night" && <div><strong>住宿長度與提前預訂</strong><p>每晚拆列的資料尚未還原成整次住宿，需補上可識別的訂單及真正入住日。</p></div>}
      </div>
      <details><summary>這段期間的指標依據</summary>{(r.analysis ? v.facts : r.facts).map((f) => <details key={f.id}><summary>{f.label}：{num(f.value)} {f.unit}</summary><p>{f.basis}</p><p className={styles.references}>{f.refs.join("、") || "本次資料在此期間未見有效紀錄。"}</p></details>)}</details>
      <details><summary>完整計算口徑</summary><ul>{r.limitations.map((l) => <li key={l}>{l}</li>)}</ul></details>
      {r.excluded.length > 0 && <details><summary>查看排除清單</summary><div className={styles.tableWrap}><table><thead><tr><th>來源列</th><th>原因</th></tr></thead><tbody>{r.excluded.slice(0, 200).map((e, i) => <tr key={i}><td>{e.ref}</td><td>{e.reason}</td></tr>)}</tbody></table></div>{r.excluded.length > 200 && <p className={styles.small}>顯示前 200 列，共 {r.excluded.length} 列。</p>}</details>}
      <p className={styles.small}>報告快照 {r.snapshot.slice(0, 12)} · {r.analysis ? "分析版本 2" : "原始彙總版本"}</p>
    </details>
    {canWrite && <button className={styles.chatLauncher} onClick={() => { setChart("overview"); setChatOpen(true); }}>✦ 問小芳</button>}
    {chatOpen && <aside className={styles.chat} role="dialog" aria-modal="false" aria-labelledby="health-chat-title">
      <div className={styles.cardHeading}><div><h2 id="health-chat-title">小芳，幫我看訂房</h2><small>{filter.from} — {filter.to}{scopeLabel ? ` · ${scopeLabel}` : ""}</small></div><button aria-label="關閉問答" className={styles.secondary} onClick={() => setChatOpen(false)}>✕</button></div>
      <div className={styles.chatPrompts}>{["最近訂房表現如何？", "哪個通路值得加強？", "接下來先改善什麼？"].map((question) => <button key={question} disabled={busy} onClick={() => void ask(question)}>{question}</button>)}</div>
      <div className={styles.messages}>
        {!messages.length && <p>直接問我最近的表現、變化和建議。我會先說明看的期間，再用這份資料回答。</p>}
        {messages.map((m, i) => <div key={i}><p className={styles.userMessage}>{m.question}</p><p className={styles.answer}>{m.answer}</p>{m.facts.length > 0 && <details><summary>查看回答依據（{m.facts.length} 項）</summary>{m.facts.map((f) => <details key={f.id}><summary>{f.label}：{num(f.value)} {f.unit}</summary><p>{f.basis}</p><small>{f.refs.join("、") || "本次資料在此期間未見紀錄。"}</small></details>)}</details>}</div>)}
        {busy && <p role="status">正在整理這段期間的表現與建議…</p>}{chatError && <p role="alert" className={styles.error}>{chatError}</p>}<div ref={messageEnd} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void ask(); }}><label htmlFor="health-chat-input" className={styles.small}>你的問題</label><input ref={chatInput} id="health-chat-input" maxLength={1000} value={input} onChange={(e) => setInput(e.target.value)} placeholder="最近訂房表現如何？" /><button className={styles.primary} disabled={busy || !input.trim()}>送出</button></form>
    </aside>}
  </>;
}
