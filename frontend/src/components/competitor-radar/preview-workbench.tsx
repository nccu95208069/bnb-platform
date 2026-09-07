"use client";
/* eslint-disable react-hooks/set-state-in-effect -- This isolated workbench restores browser-local drafts after hydration. */
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { ArrowRight, Check, Download, ExternalLink, Globe2, Loader2, Plus, Radar, Save, ShieldCheck, Trash2, Upload } from "lucide-react";
import type { CanonicalRoomDraft, CompetitorRadarAnalysis, TourismRegistryMatch } from "@/lib/competitor-radar/types";
import { addDays, applySyntheticScenario, bookingSlug, checkBooking, MAX_IMPORT_BYTES, offerObservation, parseBookingImport, parseDraft, roomCandidates, safeLink, scenarioJson, STORAGE_KEY, SYNTHETIC_NOTICE, syntheticDraft, validateDraft, type Gate, type PreviewDraft, type Scenario } from "@/lib/competitor-radar/preview-contract";
import styles from "./preview.module.css";

function Section({ number, title, note, children }: { number: string; title: string; note: string; children: ReactNode }) {
  return <section className={styles.section}><div className={styles.sectionHeading}><span className={styles.step}>{number}</span><div><h2>{title}</h2><p>{note}</p></div></div>{children}</section>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className={styles.field}><span>{label}</span>{children}</label>;
}
function LinkOut({ href, children }: { href?: string; children: ReactNode }) {
  const link = safeLink(href);
  return link ? <a href={link} target="_blank" rel="noreferrer noopener">{children}<ExternalLink size={13} /></a> : null;
}
function GateTag({ name, value }: { name: string; value: Gate }) {
  return <span className={`${styles.tag} ${value === "pass" ? styles.good : styles.warn}`}>{name} · {value === "pass" ? "相符" : value === "fail" ? "不符" : "未確認"}</span>;
}
function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const SCENARIOS: Array<[Scenario, string]> = [["normal", "正常＋僅剩 1 間"], ["unknown", "0 值／未知"], ["date_mismatch", "日期不符"], ["identity_mismatch", "不同住宿"], ["empty", "空陣列"]];
const emptyFormat = { name: "來源實際回傳的住宿名稱", address: "來源實際回傳的地址", url: "https://www.booking.com/hotel/tw/example.html", check_in: "2026-09-28", check_out: "2026-09-29", adults: 2, children: 0, rooms: 1, currency: "TWD", availability: [{ room_id: "source-101", room_name: "雙人房", capacity: 2, total_price: 2400, rooms_left: 0, policies: ["We have 1 left", "不可退款"] }] };

export default function PreviewWorkbench() {
  const [draft, setDraft] = useState<PreviewDraft | null>(null);
  const [url, setUrl] = useState("https://www.sweetfuntw.com/");
  const [busy, setBusy] = useState<"" | "website" | "registry">("");
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");
  const [raw, setRaw] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [saveError, setSaveError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState<Scenario>("normal");
  const [build, setBuild] = useState("");
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const restored = parseDraft(stored); setDraft(restored); setUrl(restored.analysis.requestedUrl);
        setSavedAt(restored.savedAt ?? ""); setNotice("已還原此瀏覽器的草稿。保存的價格不是即時更新。");
      }
    } catch { setSaveError("無法還原本機草稿；原資料未被刪除，可重新建立或匯入備份。"); }
    setHydrated(true);
    fetch("/api/radar-preview").then(r => r.json()).then(r => { if (typeof r.build === "string") setBuild(r.build.slice(0, 7)); }).catch(() => undefined);
    return () => { generation.current++; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!hydrated || !draft) return;
    dirty.current = true;
    const invalid = validateDraft(draft);
    if (invalid) { setSaveError(invalid); return; }
    const timer = setTimeout(() => {
      try {
        const now = new Date().toISOString();
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...draft, savedAt: now }));
        setSavedAt(now); setSaveError(""); dirty.current = false;
      } catch { setSaveError("瀏覽器無法保存資料。請用「匯出草稿」備份；目前編輯仍保留在畫面上。"); }
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, hydrated]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", preventLoss); return () => window.removeEventListener("beforeunload", preventLoss);
  }, []);

  const checks = useMemo(() => draft ? checkBooking(draft) : null, [draft]);
  const sourceRooms = useMemo(() => [...new Map(draft?.booking?.offers.map(o => [o.roomKey, o]) ?? []).values()], [draft?.booking]);
  const registry = draft?.analysis.tourismRegistry;
  const invalid = draft ? validateDraft(draft) : null;
  function change(patch: Partial<PreviewDraft>) { setDraft(d => d ? { ...d, ...patch } : d); }
  function editProperty(key: "name" | "address" | "phone" | "registrationNumber", value: string) {
    setDraft(d => d ? { ...d, registryDecision: undefined, analysis: { ...d.analysis, tourismRegistry: undefined, property: { ...d.analysis.property, [key]: value, identityStatus: "review" } } } : d);
  }
  function editRoom(id: string, key: "name" | "capacity" | "roomNumber", value: string) {
    setDraft(d => d ? { ...d, mappings: {}, analysis: { ...d.analysis, canonicalRooms: d.analysis.canonicalRooms.map(r => r.id !== id ? r : { ...r, [key]: key === "capacity" ? value === "" ? undefined : Number(value) : value }) } } : d);
  }
  function addRoom() {
    const room: CanonicalRoomDraft = { id: crypto.randomUUID(), name: "新房型", sourceName: "手動新增", capacity: 2, bundle: false, features: [], origin: "manual", editable: true };
    setDraft(d => d ? { ...d, analysis: { ...d.analysis, canonicalRooms: [...d.analysis.canonicalRooms, room] } } : d);
  }
  function saveNow() {
    if (!draft) return;
    const error = validateDraft(draft); if (error) { setProblem(error); return; }
    try {
      const now = new Date().toISOString(); localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...draft, savedAt: now }));
      setSavedAt(now); setSaveError(""); dirty.current = false; setNotice("已儲存在此瀏覽器；沒有寫入正式資料庫。");
    } catch { setSaveError("本機保存失敗。請匯出草稿備份。"); }
  }
  function loadSample() {
    if (draft && draft.mode !== "synthetic" && !window.confirm("改用合成範例會取代目前畫面及本機草稿。建議先匯出備份，是否繼續？")) return;
    const sample = syntheticDraft(); sample.booking = parseBookingImport(scenarioJson("normal"), "synthetic");
    setDraft(sample); setUrl("https://www.sweetfuntw.com/"); setRaw(""); setSelectedScenario("normal"); setProblem(""); setNotice(SYNTHETIC_NOTICE);
  }
  function scenario(value: Scenario) {
    setDraft(current => applySyntheticScenario(current, value));
    setSelectedScenario(value); setRaw(""); setProblem(""); setNotice(SYNTHETIC_NOTICE);
  }
  async function request<T>(body: unknown, milliseconds: number, signal: AbortSignal): Promise<T> {
    const response = await fetch("/api/radar-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.detail ?? "分析失敗。"); return payload as T;
  }
  async function registryRequest(current: PreviewDraft, run: number, signal: AbortSignal) {
    setBusy("registry");
    try {
      const result = await request<TourismRegistryMatch>({ phase: "registry", property: current.analysis.property }, 35_000, signal);
      if (generation.current !== run || signal.aborted) return;
      setDraft(d => d ? { ...d, registryDecision: undefined, analysis: { ...d.analysis, tourismRegistry: result } } : d);
      setNotice(result.status === "unavailable" ? result.message : "分析完成。請核對住宿、房型與政府候選，再測試 Booking 資料。");
    } catch (e) {
      if (generation.current === run && !signal.aborted) setNotice(`官網結果已保留，政府比對未完成：${e instanceof Error ? e.message : "請重試"}`);
    }
  }
  async function analyze() {
    if (!safeLink(url)) { setProblem("請輸入完整的 http:// 或 https:// 官網網址。"); return; }
    if (draft && !window.confirm("重新分析會建立新草稿並取代目前草稿。需保留的編輯請先匯出，是否繼續？")) return;
    const run = ++generation.current; controller.current?.abort(); controller.current = new AbortController();
    const signal = controller.current.signal; setBusy("website"); setProblem(""); setNotice("正在讀取公開官網，尚未替換既有草稿。");
    try {
      const result = await request<CompetitorRadarAnalysis>({ phase: "website", url }, 55_000, signal);
      if (generation.current !== run || signal.aborted) return;
      const start = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const next: PreviewDraft = { schemaVersion: 1, mode: "live_website", analysis: result, bookingUrl: result.platformSources.find(s => s.platform === "booking")?.sourceUrl ?? "", checkIn: addDays(start, 7), checkOut: addDays(start, 8), adults: 2, mappings: {} };
      setDraft(next); setRaw(""); setNotice("官網結果已取得，正在比對政府資料；下方可先查看房型。");
      await registryRequest(next, run, signal);
    } catch (e) {
      if (generation.current === run && !signal.aborted) setProblem(e instanceof Error ? e.message : "無法分析官網。");
    } finally { if (generation.current === run) setBusy(""); }
  }
  async function retryRegistry() {
    if (!draft) return;
    const run = ++generation.current; controller.current = new AbortController(); setProblem("");
    await registryRequest(draft, run, controller.current.signal); if (generation.current === run) setBusy("");
  }
  function cancel() { generation.current++; controller.current?.abort(); setBusy(""); setNotice("已取消等待；畫面上已取得的資料與既有草稿保留。"); }
  function decide(hotelId: string, action: "confirmed" | "rejected") {
    const candidate = registry?.candidates.find(c => c.hotelId === hotelId);
    if (!draft || !candidate) return;
    setDraft({ ...draft, registryDecision: { hotelId, action } });
    setNotice(action === "confirmed" ? "已記錄你的候選確認（僅本機）。政府欄位只在核對時作為有來源的證據，不會寫回官網／手動欄位。" : "已記錄候選不採用（僅本機）；先前候選資料不會殘留在住宿欄位。");
  }
  function importBooking(input = raw) {
    if (!draft) return;
    try {
      const parsed = parseBookingImport(input); change({ booking: parsed, mappings: {} }); setRaw(""); setProblem("");
      setNotice("已在瀏覽器解析匯入資料。原始 JSON 沒有上傳；下方顯示欄位一致性檢查，不等於驗證來源真實性。");
    } catch (e) { setProblem(e instanceof Error ? e.message : "匯入失敗。"); }
  }
  async function readFile(event: ChangeEvent<HTMLInputElement>, kind: "booking" | "draft") {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { setProblem("檔案超過 1 MB 上限。"); return; }
    try {
      const input = await file.text();
      if (kind === "booking") importBooking(input);
      else {
        const restored = parseDraft(input);
        if (draft && !window.confirm("匯入備份將取代目前本機草稿，是否繼續？")) return;
        setDraft(restored); setUrl(restored.analysis.requestedUrl); setRaw(""); setProblem(""); setNotice("草稿備份已載入；所有檢查會依目前條件重新計算。");
      }
    } catch (e) { setProblem(e instanceof Error ? e.message : "檔案無法讀取。"); }
  }

  return <main className={styles.page}>
    <header className={styles.header}><div className={styles.brand}><Radar size={25}/><strong>Daili</strong><span>COMPETITOR RADAR</span></div><span className={styles.tag}>獨立測試站 · v0.3{build ? ` · ${build}` : ""}</span></header>
    <div className={styles.hero}><div><div className={styles.eyebrow}>從資料來源，到你確認的競品檔案</div><h1>先認對住宿，<br/>再比較市場。</h1><p>貼上官網，核對旅宿身分與房型。每個價格、每個數量，都保留來源與不確定性。</p></div><aside className={styles.testCard}><ShieldCheck size={22}/><strong>這裡可以放心測試</strong><p>不改動訂單、不調整 OTA 庫存、不發送付費採集。草稿只存在你的瀏覽器。</p><button onClick={loadSample} disabled={Boolean(busy) || !hydrated}>載入完整範例 <ArrowRight size={16}/></button><small>使用合成資料走完流程，不需要 API Key。</small></aside></div>
    <div className={styles.banner}><span className={`${styles.tag} ${styles.good}`}>可用</span> 即時官網解析、政府比對、草稿編輯、Booking JSON 匯入 <span className={`${styles.tag} ${styles.warn}`}>未啟用</span> OTA 即時採集、跨裝置同步與每日監控</div>
    {notice && <div className={styles.notice} role="status" aria-live="polite">{notice}</div>}
    {problem && <div className={styles.error} role="alert">{problem}<button onClick={() => setProblem("")}>關閉</button></div>}
    {saveError && <div className={styles.error} role="alert">{saveError}</div>}

    <Section number="01" title="建立住宿檔案" note="官網資料是真的讀取；政府來源獨立查詢，失敗不會覆蓋已取得的結果。">
      <form className={styles.urlForm} onSubmit={e => { e.preventDefault(); void analyze(); }}><Field label="官網網址"><div className={styles.urlInput}><Globe2 size={18}/><input aria-label="官網網址" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://你的旅宿官網" required disabled={Boolean(busy)} /></div></Field><button className={styles.primary} disabled={Boolean(busy) || !hydrated}>{busy ? <Loader2 size={16} className={styles.spin}/> : <ArrowRight size={16}/>} {busy === "website" ? "讀取官網中" : busy === "registry" ? "比對政府資料中" : "分析官網"}</button>{busy && <button type="button" onClick={cancel}>取消等待</button>}</form>
      <div className={styles.toolbar}><span className={styles.muted}>支援公開 HTTP/HTTPS 官網；私有 IP、登入頁與過大的頁面會拒絕。</span><label className={styles.fileButton}><Upload size={14}/>匯入草稿備份<input type="file" accept="application/json,.json" disabled={Boolean(busy)} onChange={e => void readFile(e, "draft")}/></label></div>
    </Section>

    {draft && <>
      <div className={styles.stats}><div><small>官網／手動房型</small><strong>{draft.analysis.canonicalRooms.length}<span> 個</span></strong></div><div><small>政府資料候選</small><strong>{registry?.candidates.length ?? 0}<span> 筆</span></strong></div><div><small>Booking 來源房型 / 方案</small><strong>{sourceRooms.length}<span> / {draft.booking?.offers.length ?? 0}</span></strong></div></div>
      {draft.mode === "synthetic" && <div className={styles.synthetic} data-testid="synthetic-notice">{SYNTHETIC_NOTICE} 所有範例價格均為虛構。</div>}
      <fieldset disabled={Boolean(busy)} className={styles.fieldset}>
      <Section number="02" title="核對身分與房型" note="政府資料是身分證據，不是房型真相；所有修改只保存到本機草稿。">
        <div className={styles.columns}><div className={styles.panel}><h3>住宿基本資料 <span className={styles.tag}>{draft.mode === "synthetic" ? "合成範例" : "官網擷取草稿"}</span></h3><div className={styles.formGrid}><Field label="住宿名稱"><input aria-label="住宿名稱" maxLength={200} value={draft.analysis.property.name} onChange={e => editProperty("name", e.target.value)}/></Field><Field label="旅館民宿證號"><input aria-label="旅館民宿證號" maxLength={100} value={draft.analysis.property.registrationNumber ?? ""} placeholder="未找到，可留空" onChange={e => editProperty("registrationNumber", e.target.value)}/></Field><Field label="地址"><input aria-label="住宿地址" maxLength={500} value={draft.analysis.property.address ?? ""} onChange={e => editProperty("address", e.target.value)}/></Field><Field label="電話"><input aria-label="住宿電話" maxLength={50} value={draft.analysis.property.phone ?? ""} onChange={e => editProperty("phone", e.target.value)}/></Field></div><LinkOut href={draft.analysis.finalUrl}>開啟分析來源</LinkOut><p className={styles.muted}>修改身分欄位後，舊政府比對會失效；請重新比對。空白資料不會被視為已驗證。</p></div>
        <div className={styles.panel}><div className={styles.toolbar}><h3>政府旅宿資料</h3><button onClick={() => void retryRegistry()} disabled={draft.mode === "synthetic"}>重新比對政府資料</button></div><p className={styles.muted}>{registry?.message ?? (draft.mode === "synthetic" ? "合成範例不會查詢或冒充政府紀錄。" : "尚未比對，或你已修改住宿身分資料。")}</p>{registry?.candidates.map(c => <article key={c.hotelId} className={styles.candidate}><div className={styles.toolbar}><strong>{c.name}</strong><span className={styles.tag}>{c.status === "confirmed" ? "高信心候選" : c.status === "rejected" ? "有反證" : "待複核"}</span></div><p>{c.address ?? "未提供地址"}</p><p>{c.registrationNumber ?? "未提供證號"} · {c.phone ?? "未提供電話"}</p><small>資料 ID：{c.hotelId}（不是證號）{c.updateTime ? ` · 更新 ${c.updateTime}` : ""}</small>{typeof c.totalRooms === "number" && c.totalRooms !== draft.analysis.canonicalRooms.length && <p className={styles.warningText}>政府登載 {c.totalRooms} 間，草稿有 {draft.analysis.canonicalRooms.length} 個房型：保留差異，不自動增刪。</p>}<details><summary>查看比對證據</summary>{c.evidence.map((e, i) => <p key={i}>{e.label}：{e.detail}</p>)}{c.conflicts.map((v, i) => <p className={styles.warningText} key={i}>{v}</p>)}</details><div className={styles.actions}><button disabled={c.status === "rejected"} onClick={() => decide(c.hotelId, "confirmed")}><Check size={14}/>確認此候選</button><button onClick={() => decide(c.hotelId, "rejected")}>不採用</button></div>{draft.registryDecision?.hotelId === c.hotelId && <span className={styles.tag}>你已{draft.registryDecision.action === "confirmed" ? "確認" : "拒絕"}（本機）</span>}</article>)}</div></div>
        <div className={styles.toolbar}><h3>你的標準房型</h3><button onClick={addRoom} disabled={draft.analysis.canonicalRooms.length >= 100}><Plus size={15}/>新增房型</button></div>
        <div className={styles.roomGrid}>{draft.analysis.canonicalRooms.map(r => <article className={styles.room} key={r.id}><div className={styles.formGrid}><Field label="房型名稱"><input aria-label={`房型名稱 ${r.id}`} maxLength={200} value={r.name} onChange={e => editRoom(r.id, "name", e.target.value)}/></Field><Field label="房號"><input aria-label={`房號 ${r.id}`} maxLength={30} value={r.roomNumber ?? ""} onChange={e => editRoom(r.id, "roomNumber", e.target.value)}/></Field><Field label="標準人數"><input aria-label={`人數 ${r.id}`} type="number" min={1} max={100} value={r.capacity ?? ""} onChange={e => editRoom(r.id, "capacity", e.target.value)}/></Field></div><div className={styles.toolbar}><small>{r.origin === "manual" ? "手動／測試" : r.origin === "golden_fixture" ? "參考範例，非即時擷取" : "官網來源"} {r.bundle ? "· 包棟商品" : ""}</small><button aria-label={`刪除 ${r.name}`} onClick={() => setDraft(d => d ? { ...d, mappings: {}, analysis: { ...d.analysis, canonicalRooms: d.analysis.canonicalRooms.filter(x => x.id !== r.id) } } : d)}><Trash2 size={15}/></button></div><LinkOut href={r.sourceUrl}>房型來源頁</LinkOut></article>)}</div>
        {!draft.analysis.canonicalRooms.length && <p className={styles.empty}>沒有辨識到房型。可手動新增，不會由政府房間數補造房型。</p>}
        {draft.analysis.warnings.length > 0 && <details className={styles.notes}><summary>分析提醒（{draft.analysis.warnings.length}）</summary>{draft.analysis.warnings.map((w, i) => <p key={i}>{w}</p>)}</details>}
      </Section>

      <Section number="03" title="測試 Booking 資料與房型對應" note="可以載入情境範例，或匯入你已有的 JSON；不會向 Booking 或付費供應商發出請求。">
        <div className={styles.formGrid}><Field label="指定的 Booking 房源網址"><input aria-label="Booking 房源網址" value={draft.bookingUrl} maxLength={2048} placeholder="https://www.booking.com/hotel/tw/…html" onChange={e => change({ bookingUrl: e.target.value, mappings: {} })}/></Field><Field label="入住日期"><input aria-label="入住日期" type="date" value={draft.checkIn} onChange={e => change({ checkIn: e.target.value })}/></Field><Field label="退房日期"><input aria-label="退房日期" type="date" value={draft.checkOut} onChange={e => change({ checkOut: e.target.value })}/></Field><Field label="成人"><input aria-label="成人" type="number" min={1} max={30} value={draft.adults} onChange={e => change({ adults: Number(e.target.value) })}/></Field></div><p className={styles.muted}>固定條件：1 間房、0 位兒童、TWD。匯入檔必須有回傳條件；未知欄位不會從輸入值補齊。</p>
        {draft.mode === "synthetic" && <div className={styles.scenarios} aria-label="測試情境">{SCENARIOS.map(([key, label]) => <button key={key} aria-pressed={selectedScenario === key} className={selectedScenario === key ? styles.selected : ""} onClick={() => scenario(key)}>{label}</button>)}</div>}
        <details className={styles.importPanel} open={draft.mode === "live_website" && !draft.booking}><summary>匯入 Booking JSON（只在瀏覽器處理）</summary><p className={styles.muted}>支援單筆 availability / offers 格式。缺少真實回傳欄位時會標示未確認；請勿為通過檢查而填入推測值，也不要貼入 API Key。</p><textarea aria-label="Booking JSON" value={raw} onChange={e => setRaw(e.target.value)} placeholder="貼上單間住宿的 JSON 結果" rows={7}/><div className={styles.actions}><button className={styles.primary} onClick={() => importBooking()} disabled={!raw.trim()}>解析匯入資料</button><label className={styles.fileButton}><Upload size={15}/>選擇 JSON 檔<input type="file" accept="application/json,.json" onChange={e => void readFile(e, "booking")}/></label><button onClick={() => downloadJson(emptyFormat, "booking-import-format-example.json")}><Download size={15}/>下載格式範例</button></div></details>
        {draft.booking && checks && <div className={styles.results} data-testid="booking-results"><div className={styles.toolbar}><h3>{draft.booking.name}</h3><span className={`${styles.tag} ${draft.booking.source === "synthetic" ? styles.warn : ""}`}>{draft.booking.source === "synthetic" ? "合成範例 · 非即時" : "手動匯入 · 來源未獨立驗證"}</span></div><div className={styles.actions}><GateTag name="住宿" value={checks.identity}/><GateTag name="日期" value={checks.dates}/><GateTag name="人數／房數" value={checks.context}/></div>{checks.messages.map((m, i) => <p key={i} className={styles.warningText}>{m}</p>)}{!checks.accepted && <div className={styles.synthetic} data-testid="quarantine">驗證未通過：所有價格與參考數量已隔離，不會採用。</div>}
          <div className={styles.tableScroll}><table><thead><tr><th>來源房型／方案</th><th>本次總價</th><th>參考數量</th><th>判讀</th></tr></thead><tbody>{draft.booking.offers.map(o => { const observation = offerObservation(o, checks.accepted); return <tr key={o.key}><td><strong>{o.name}</strong><small>{o.plan}</small></td><td>{observation.price !== undefined ? `NT$ ${observation.price.toLocaleString("en-US")}` : "—"}</td><td>{observation.quantity ?? "未知"}</td><td><span className={styles.tag}>{observation.label}</span></td></tr>; })}</tbody></table></div>
          {!draft.booking.offers.length && <p className={styles.empty}>沒有方案資料。{draft.booking.soldOut && checks.accepted ? "來源明確回報無房；不代表已成交。" : "沒有明確無房證據，不能當成售罄。"}</p>}
          <h3>確認房型對應</h3><p className={styles.muted}>同房型的多個取消／早餐方案只需對應一次。建議不會自動套用；選擇即記錄你的本機確認，房量永不加總。</p><div className={styles.mappingGrid}>{sourceRooms.map(o => { const candidates = roomCandidates(o, draft.analysis.canonicalRooms); const best = candidates.find(c => !c.conflicts.length && c.score >= 0.55); return <div className={styles.mapping} key={o.roomKey}><strong>{o.name}</strong><select aria-label={`對應 ${o.name}`} disabled={!checks.accepted} value={draft.mappings[o.roomKey] ?? ""} onChange={e => change({ mappings: { ...draft.mappings, [o.roomKey]: e.target.value } })}><option value="">尚未確認對應</option>{candidates.map(c => <option key={c.id} value={c.id} disabled={c.conflicts.length > 0}>{c.name}{c.conflicts.length ? `（${c.conflicts.join("、")}）` : ""}</option>)}</select><small>{best ? `建議：${best.name}；仍需你選擇確認。` : "沒有足夠證據自動建議，請核對房型。"}</small></div>; })}</div>
        </div>}
        {!draft.booking && <div className={styles.empty}>尚未匯入 Booking 資料。可選擇 JSON 檔，或從上方「載入完整範例」直接測試。</div>}
        {draft.bookingUrl && !bookingSlug(draft.bookingUrl) && <p className={styles.warningText}>請使用 Booking /hotel/…html 房源網址，而非搜尋結果頁。</p>}
        <div className={styles.banner}><ShieldCheck size={18}/><span>平台顯示數量不是實體庫存；數量下降也不是確認成交。日期不符、空陣列、0 值與抓取失敗，都不會被自動解讀成售罄。</span></div>
      </Section>
      </fieldset>
      <footer className={styles.saveBar}><div><strong>{saveError ? "草稿尚未成功保存" : savedAt ? "草稿已保存於此瀏覽器" : "正在保存草稿"}</strong><small>{savedAt ? new Date(savedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }) : ""} · 不跨裝置同步，沒有寫入正式資料庫</small></div><div className={styles.actions}><button onClick={() => { if (invalid) setProblem(invalid); else downloadJson({ ...draft, savedAt: new Date().toISOString() }, "daili-radar-test-draft.json"); }} disabled={Boolean(busy)}><Download size={16}/>匯出草稿</button><button className={styles.primary} onClick={saveNow} disabled={Boolean(busy) || Boolean(invalid)}><Save size={16}/>儲存草稿</button></div></footer>
    </>}
    {!draft && <div className={styles.getStarted}><span className={styles.step}>↗</span><div><h3>從水芳官網開始，或先走一次完整範例。</h3><p>本測試版驗證資料取得與核對流程，不提供已驗證的去化率、成交推估或供應商成本結論。</p></div></div>}
    <div className={styles.footer}>Daili · Competitor Radar / 測試版 · 2026-09-07</div>
  </main>;
}
