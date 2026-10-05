"use client";
import { useMemo, useState } from "react";
import { nightLabel, type StayKind } from "@/lib/hospitality-mode";
import type { Report } from "@/lib/order-health/types";
import { analysisView, checkedFilter, formatNumber as num, taipeiDate } from "@/lib/order-health/analytics";
import { momentumView, monthlyView, monthPeriod, pacingView, previousYearMonth, percentChange, type CohortSummary } from "@/lib/order-health/momentum";
import { InteractiveBarChart, type BarPoint } from "./interactive-bar-chart";
import styles from "./health.module.css";

type Metric = "orders" | "nights" | "amount" | "adr";
const changeText = (value: number | null) => value === null ? "尚無可比數字" : `${value > 0 ? "↑" : value < 0 ? "↓" : "→"} ${num(Math.abs(value))}%`;
const money = (value: number | null) => value === null ? "—" : `NT$ ${num(value)}`;
const count = (s: Pick<CohortSummary, "orders" | "knownOrders">, ready = true) => !ready ? "—" : s.orders === null ? `至少 ${num(s.knownOrders)} 筆` : `${num(s.orders)} 筆`;
const detail = (s: { orders: number | null; nights: number; amount: number | null; adr: number | null }, unit: string) => `${s.orders === null ? "訂單筆數未完整識別" : `${num(s.orders)} 筆訂單`} · ${num(s.nights)} ${unit} · 已知房費 ${money(s.amount)} · 每晚均價 ${money(s.adr)}`;
export function AnalysisDashboard({ report }: { report: Report }) {
  const [kind, setKind] = useState<StayKind>(() => checkedFilter(null, report).kind!);
  return <>
    {report.receptionKind === "mixed" && <><div className={styles.receptionTabs} aria-label="分開查看接客形式">
      <button aria-pressed={kind === "villa"} onClick={() => setKind("villa")}>包棟</button>
      <button aria-pressed={kind === "rooms"} onClick={() => setKind("rooms")}>散客</button>
    </div><p className={styles.small}>共用同一棟庫存，兩種形式的晚數與均價分開計算。</p></>}
    <DashboardPanel key={`${report.snapshot}:${kind}`} report={report} kind={kind} />
  </>;
}
function DashboardPanel({ report: r, kind }: { report: Report; kind: StayKind }) {
  const villa = kind === "villa", unit = nightLabel(kind);
  const [today] = useState(taipeiDate);
  const asOf = r.analysis?.asOf ?? today;
  const ready = Boolean(r.analysis?.cohorts);
  const [channel, setChannel] = useState("");
  const [metric, setMetric] = useState<Metric>("orders");
  const [basis, setBasis] = useState<"stay" | "booked">("stay");
  const [month, setMonth] = useState(asOf.slice(0, 7));
  const [selectedChannel, setSelectedChannel] = useState("");
  const scope = useMemo(() => ({ kind, channel: channel || undefined }), [kind, channel]);
  const m = useMemo(() => momentumView(r, scope), [r, scope]);
  const year = Number(month.slice(0, 4));
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => monthlyView(r, scope, `${year}-${String(i + 1).padStart(2, "0")}`, basis)), [r, scope, year, basis]);
  const selected = months[Number(month.slice(5, 7)) - 1];
  const pace = useMemo(() => pacingView(r, scope, month), [r, scope, month]);
  const v = useMemo(() => analysisView(r, { ...monthPeriod(month), ...scope }, asOf), [r, scope, month, asOf]);
  const metricLabels = { orders: "訂單數", nights: unit, amount: "已知房費", adr: "每晚均價" };
  const dailyMetric = metric === "orders" && !m.countable ? "nights" : metric;
  const selectedMetric = basis === "stay" && dailyMetric === "orders" ? "nights" : dailyMetric;
  const points = (rows: { date: string; orders: number | null; nights: number; amount: number | null; adr: number | null }[], key: Metric): BarPoint[] => rows.map((p) => ({ key: p.date, label: p.date.slice(5).replace("-", "/"), value: p[key], detail: detail(p, unit) }));
  const pickedChannel = m.channels.find((c) => c.channel === selectedChannel);
  const years = [...new Set([year, Number(asOf.slice(0, 4)) - 1, Number(asOf.slice(0, 4)), Number(asOf.slice(0, 4)) + 1, ...r.monthly.map((x) => Number(x.month.slice(0, 4)))])].sort((a, b) => a - b);
  return <>
    <div className={styles.reportHead}><div><strong>{villa ? "包棟經營報告" : "散客經營報告"}</strong><p className={styles.small}>來源：{r.sourceTitle} · 匯入 {new Date(r.createdAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}<br />資料快照截至 {asOf}；來源更新時間未知。</p></div><span className={styles.badge}>依你的訂單分析</span></div>
    {asOf < today && <p className={styles.notice}>這份快照截至 {asOf}；以下「今天」及近 7 天均以快照日為準。用上方「更新資料」納入後續訂房。</p>}
    {r.analysis?.dimensions && <div className={styles.momentumToolbar}><label>分析通路 <select value={channel} onChange={(e) => { setChannel(e.target.value); setSelectedChannel(""); }}><option value="">全部通路</option>{r.channels.map((c) => <option key={c.channel}>{c.channel}</option>)}</select></label>{channel && <button className={styles.link} onClick={() => setChannel("")}>回到全部通路</button>}</div>}
    {!ready && <p className={styles.notice}>這份舊報告尚無訂單動能資料，請更新資料。原有住宿晚數與金額仍保留。</p>}
    <section className={styles.brief} data-tone={m.tone}><p className={styles.eyebrow}>最近接單如何 {channel && `／ ${channel}`}</p><h2>{ready ? m.headline : "更新資料，查看最近接單變化"}</h2><p>{m.detail}</p>
      {m.available && <p>近 7 天已知房費 <strong>{money(m.recent.amount)}</strong>，前 7 天 {money(m.previous.amount)} · 金額變化 {changeText(m.amountChange)}</p>}
      <div className={styles.briefNext}><span>判讀範圍</span>按實際下訂日期、目前仍有效的紀錄計算。近 7 天不含今天；下訂日期覆蓋 {num(m.dateCoverage)}%。取消與改期歷程尚未納入。</div>
    </section>
    <div className={styles.metrics}>
      {[["今天接單", m.today, `${asOf} · 截至匯入時`], ["昨天接單", m.yesterday, "按快照前一天"], ["近 7 天接單", m.recent, `${m.recentPeriod.from} — ${m.recentPeriod.to}`]].map(([label, raw, note]) => { const s = raw as CohortSummary; return <div className={styles.metric} key={label as string}><span>{label as string}</span><strong>{count(s, m.available)}</strong><b>{m.available ? money(s.amount) : "—"}</b><small>{note as string}</small></div>; })}
      <div className={styles.metric}><span>接下來 30 天住宿</span><strong>{count(m.futureOrders, ready)}</strong><b>{r.analysis ? money(m.future.amount) : "—"}</b><small>{num(m.future.nights)} {unit} · 跨期房費按晚分攤</small></div>
    </div>
    {m.available && <>
      <section className={styles.card}><div className={styles.cardHeading}><div><h2>近 30 天，每天接了多少單</h2><p className={styles.small}>按下訂日 · 截至昨天 · 滑動可看完整日期</p></div><span className={styles.badge}>目前仍有效的訂單</span></div>
        <div className={styles.metricSwitch}>{([...(m.countable ? ["orders"] : []), "nights", "amount", "adr"] as Metric[]).map((key) => <button key={key} aria-pressed={dailyMetric === key} onClick={() => setMetric(key)}>{metricLabels[key]}</button>)}</div>
        <InteractiveBarChart points={points(m.daily, dailyMetric)} label={metricLabels[dailyMetric]} />
        <p className={styles.small}>0 表示本次資料未見紀錄；— 表示無法計算。缺少訂單編號的拆列不當成訂單數；房費尚未扣除佣金、稅費與成本。</p>
      </section>
      <section className={styles.card}><div className={styles.cardHeading}><div><p className={styles.eyebrow}>預訂速度</p><h2>{m.baselineChange === null ? "看看最近 8 週的接單節奏" : m.baselineChange < -20 ? "最近一週低於前 4 週常態" : "最近一週與前 4 週相比"}</h2></div><strong className={styles.big}>{changeText(m.baselineChange)}</strong></div>
        <p>近 7 天 {num(m.recent[m.measure])} {m.measureLabel}；前 4 週每週中位數 {num(m.baseline)}。{m.baseline === null ? "可比週數或下訂日期不足，暫不判定速度過慢。" : "每週使用相同 7 天長度，減少單日波動影響。"}</p>
        <InteractiveBarChart label={metricLabels[m.measure]} points={m.weeks.map((w) => ({ key: w.from, label: `${w.from.slice(5)}～${w.to.slice(5)}`, value: w[m.measure], detail: detail(w, unit) }))} />
        <p className={styles.small}>不同週的可售庫存與季節可能不同。此處只比較本次匯入可見的接單量，無法直接判斷市場需求或營業淨利。</p>
      </section>
      <section className={styles.card}><div className={styles.cardHeading}><div><p className={styles.eyebrow}>通路要注意什麼</p><h2>找出接單與價格的變化</h2></div><span className={styles.badge}>近 7 天 vs 前 7 天</span></div>
        <div className={styles.tableWrap}><table><thead><tr><th>通路</th><th>近 7 天訂單</th><th>前 7 天訂單</th><th>接單變化</th><th>新單均價</th><th>提醒</th></tr></thead><tbody>{m.channels.map((c) => <tr key={c.channel} data-selected={c.channel === selectedChannel}><td><button className={styles.dimensionLink} aria-expanded={c.channel === selectedChannel} onClick={() => setSelectedChannel(c.channel === selectedChannel ? "" : c.channel)}>{c.channel} ↗</button></td><td>{count(c.current)}</td><td>{count(c.prior)}</td><td>{changeText(c.change)}{!m.countable && <small>（按{unit}）</small>}</td><td>{money(c.current.adr)}<br /><small>{changeText(c.priceChange)}</small></td><td><span className={styles.attentionBadge} data-tone={c.tone}>{c.attention}</span></td></tr>)}</tbody></table></div>
        {pickedChannel && <div className={styles.channelDetail}><h3>{pickedChannel.channel} · {pickedChannel.attention}</h3><p>{pickedChannel.reason}</p><p>近 7 天已知房費 {money(pickedChannel.current.amount)} · {num(pickedChannel.current.nights)} {unit} · 金額覆蓋 {num(pickedChannel.current.coverage)}%</p><p>前 7 天已知房費 {money(pickedChannel.prior.amount)} · 每晚均價 {money(pickedChannel.prior.adr)}</p>{r.analysis?.dimensions && !channel && <button className={styles.secondary} onClick={() => setChannel(pickedChannel.channel)}>整份報告只看這個通路</button>}</div>}
        <p className={styles.small}>點選通路查看原因。提醒用於安排檢查順序，資料缺漏、季節與庫存變化都可能影響結果。</p>
      </section>
      <section className={styles.card}><p className={styles.eyebrow}>近期新訂單的價格</p><h2>接單量之外，成交價格有沒有守住</h2><div className={styles.priceGrid}>
        {[["每晚均價", money(m.recent.adr), changeText(m.priceChange), `前 7 天 ${money(m.previous.adr)}`], ["每筆完整訂單平均房費", money(m.recent.ticket), changeText(percentChange(m.recent.ticket, m.previous.ticket)), `完整金額 ${num(m.recent.fullPriceOrders)} 筆`], ["每筆平均住宿天數", m.recent.los === null ? "—" : `${num(m.recent.los)} 晚`, "", "只採用可確認完整住宿的訂單"]].map(([label, value, change, note]) => <div key={label}><span>{label}</span><strong>{value}</strong><b>{change}</b><small>{note}</small></div>)}
      </div>
        {r.analysis?.unit !== "night" && <div className={styles.tableWrap}><table><thead><tr><th>依開始住宿日分組</th><th>近 7 天新單均價</th><th>前 7 天新單均價</th><th>變化</th></tr></thead><tbody>{m.priceByStayDay.map((p) => <tr key={p.label}><td>{p.label}</td><td>{money(p.recent.adr)}</td><td>{money(p.previous.adr)}</td><td>{changeText(percentChange(p.recent.adr, p.previous.adr))}</td></tr>)}</tbody></table></div>}
        <p className={styles.small}>均價採用正金額房費與對應{unit}；近 7 天金額覆蓋 {num(m.recent.coverage)}%。房型、方案、平假日及住宿長短改變都會影響均價；開始住宿日分組未另分類國定假日。</p>
      </section>
    </>}
    {r.analysis && <section className={styles.card}><div className={styles.cardHeading}><div><p className={styles.eyebrow}>每月表現</p><h2>每個月，有多少訂單與房費</h2></div><label>年份 <select value={year} onChange={(e) => setMonth(`${e.target.value}${month.slice(4)}`)}>{years.map((y) => <option key={y}>{y}</option>)}</select></label></div>
      <div className={styles.metricSwitch}><button aria-pressed={basis === "stay"} onClick={() => setBasis("stay")}>按住宿月份</button><button aria-pressed={basis === "booked"} disabled={!m.available} onClick={() => setBasis("booked")}>按下訂月份</button></div>
      <p className={styles.small}>{basis === "stay" ? "入住跨月的訂單，在有住宿的月份各計一次；房費按晚分攤，月份筆數不可直接相加。" : "每筆訂單歸入下訂月份，金額是該筆全部已知房費；只納入有下訂日期的紀錄。"} ← 左右滑動 →</p>
      <div className={styles.monthCards}>{months.map((s) => { const prior = monthlyView(r, scope, previousYearMonth(s.month), basis); return <button key={s.month} className={styles.monthCard} ref={(el) => { if (el && month === s.month && el.parentElement) el.parentElement.scrollLeft = el.offsetLeft - (el.parentElement.clientWidth - el.clientWidth) / 2; }} aria-pressed={month === s.month} onClick={() => setMonth(s.month)}><span>{s.month.replace("-", "/")} 月</span><strong>{count(s, ready)}</strong><small>{basis === "stay" ? "本月有住宿的訂單" : "本月新訂、目前有效"}</small><b>{money(s.amount)}</b><small>已知房費 · {num(s.nights)} {unit}</small><hr /><small>{prior.observed ? `去年同月可見 ${count(prior)}` : "去年同月未見紀錄"}</small><small>{s.observed ? `金額覆蓋 ${num(s.coverage)}%` : "本次資料未見紀錄"}</small></button>; })}</div>
      <div className={styles.monthDetail}><h3>{month.replace("-", "/")} · {basis === "stay" ? "每日住宿表現" : "每日接單表現"}</h3><div className={styles.metricSwitch}>{([...(basis === "booked" && m.countable ? ["orders"] : []), "nights", "amount", "adr"] as Metric[]).map((key) => <button key={key} aria-pressed={selectedMetric === key} onClick={() => setMetric(key)}>{metricLabels[key]}</button>)}</div><InteractiveBarChart points={points(selected.daily, selectedMetric)} label={metricLabels[selectedMetric]} /></div>
      {ready && basis === "stay" && <div className={styles.monthDetail}><p className={styles.eyebrow}>這個月份，訂房累積到哪裡</p><h3>{pace.title}</h3><p>截至 {pace.cutoff} 可見 {num(pace.current.nights)} {unit}；去年相同提前天數 {pace.previousExists ? num(pace.previous.nights) : "—"} {unit}。{changeText(pace.change)}</p><InteractiveBarChart label={unit} comparison="去年相同提前天數" points={pace.points.map((p) => ({ key: p.date, label: p.label, value: p.value, secondary: p.previous, detail: `本期截止日 ${p.date}` }))} /><p className={styles.notice}>依目前仍保留的有效訂單與下訂日回推，並非去年當時的歷史快照；無法還原已取消、改期或移除的訂單。{!pace.dateComplete && "兩期資料或下訂日期不完整，暫不判定超前或落後。"}</p></div>}
    </section>}
    {r.analysis && <details className={styles.card}><summary>{month.replace("-", "/")} 住宿分布與預訂習慣</summary>
      <p className={styles.small}>依所選住宿月份與通路計算，與上方按下訂日的接單分析分開。</p>
      <div className={styles.priceGrid}><div><span>已訂{unit}</span><strong>{num(v.total.nights)}</strong><small>本月有紀錄的住宿晚數</small></div><div><span>平均住宿長度</span><strong>{num(v.total.los)} 晚</strong><small>按可確認的入住房次／組數加權</small></div><div><span>平均提前預訂</span><strong>{num(v.total.lead)} 天</strong><small>只採用可確認下訂日的入住紀錄</small></div></div>
      <h3>一週哪幾天有訂房</h3><InteractiveBarChart label={`平均${unit}／日`} points={[1, 2, 3, 4, 5, 6, 0].map((day) => ({ key: String(day), label: `週${"日一二三四五六"[day]}`, value: v.weekdays[day].perDay, detail: "已除以本月該星期出現次數；不代表住房率。" }))} />
      {!villa && r.analysis.dimensions && <><h3>各房號／房型的住宿表現</h3><div className={styles.tableWrap}><table><thead><tr><th>來源房間</th><th>房晚</th><th>已知房費</th><th>每晚均價</th></tr></thead><tbody>{v.rooms.map((room) => <tr key={room.name}><td>{room.name}</td><td>{num(room.nights)}</td><td>{money(room.amount)}</td><td>{money(room.adr)}</td></tr>)}</tbody></table></div></>}
    </details>}
    {villa && r.analysis && <section className={styles.card}><div className={styles.cardHeading}><h2>接下來 30 天的包棟日期</h2><span className={styles.badge}>全棟所有通路</span></div><div className={styles.villaCalendar}>{v.futureCalendar.map((d) => <div key={d.date} className={styles.villaDay} data-state={d.state}><small>週{"日一二三四五六"[new Date(d.date).getUTCDay()]}</small><strong>{d.date.slice(5).replace("-", "/")}</strong><span>{d.state === "booked" ? "包棟已訂" : d.state === "rooms" ? "已有散客" : d.state === "review" ? "資料衝突" : "待核對"}</span></div>)}</div><p className={styles.small}>「待核對」不代表可售空房；仍需核對停賣、公休與資料完整性。</p>{v.singleNightGaps.length > 0 && <p>住宿間只隔一晚：{v.singleNightGaps.map((d) => d.slice(5).replace("-", "/")).join("、")}。確認可售後，可評估單晚或連住方案。</p>}</section>}
    <section className={styles.card}><h2>接著先做什麼</h2><div className={styles.actionCards}>{m.actions.map((a, i) => <article key={a.id} data-tone={a.tone}><span>{String(i + 1).padStart(2, "0")}</span><div><h3>{a.title}</h3><p>{a.detail}</p><strong>{a.action}</strong></div></article>)}</div></section>
    {!r.analysis && <section className={styles.card}><h2>這份報告的每月總覽</h2><div className={styles.tableWrap}><table><thead><tr><th>月份</th><th>{unit}</th><th>已知房費</th></tr></thead><tbody>{r.monthly.map((s) => <tr key={s.month}><td>{s.month}</td><td>{num(s.nights)}</td><td>{money(s.amount)}</td></tr>)}</tbody></table></div></section>}
    <details id="health-evidence" className={styles.card}><summary>資料依據與待補項目 · 納入 {r.includedRows} 列／排除 {r.excluded.length} 列</summary><p>已知房費不等於淨收益。住房率需要完整可售庫存；淨新增訂房與真正的去年同時點比較需要歷史快照及取消、改期紀錄。缺少下訂日期的紀錄仍列入住宿月份，但不列入近期接單。</p><details><summary>本月住宿指標依據</summary>{(r.analysis ? v.facts : r.facts).map((f) => <details key={f.id}><summary>{f.label}：{num(f.value)} {f.unit}</summary><p>{f.basis}</p><p className={styles.references}>{f.refs.join("、") || "本次資料未見有效紀錄。"}</p></details>)}</details>{ready && <details><summary>近 7 天接單來源列</summary><p className={styles.references}>{m.recent.refs.join("、") || "本次資料未見有效紀錄。"}</p></details>}<details><summary>完整計算口徑</summary><ul>{r.limitations.map((l) => <li key={l}>{l}</li>)}</ul></details>{r.excluded.length > 0 && <details><summary>查看排除清單</summary><div className={styles.tableWrap}><table><thead><tr><th>來源列</th><th>原因</th></tr></thead><tbody>{r.excluded.slice(0, 200).map((e, i) => <tr key={i}><td>{e.ref}</td><td>{e.reason}</td></tr>)}</tbody></table></div><p className={styles.small}>顯示前 {Math.min(200, r.excluded.length)} 列，共 {r.excluded.length} 列。</p></details>}</details>
  </>;
}
