"use client";

import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Loader2,
  MapPin,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";

import type {
  OtaAvailability,
  OtaPlatform,
  OtaPlatformScan,
  OtaScanResponse,
} from "@/lib/competitor-radar/ota-types";
import type {
  CompetitorRadarAnalysis,
  TourismRegistryMatch,
} from "@/lib/competitor-radar/types";

import styles from "./radar-dashboard.module.css";

type Tab = "overview" | OtaPlatform;
type ScanMap = Partial<Record<OtaPlatform, OtaPlatformScan>>;
type ScanProgress = Partial<Record<OtaPlatform, "waiting" | "running" | "done" | "failed">>;

const PLATFORMS: OtaPlatform[] = ["booking", "agoda", "trip"];
const PLATFORM_LABELS: Record<OtaPlatform, string> = {
  booking: "Booking.com",
  agoda: "Agoda",
  trip: "Trip.com",
};
const PLATFORM_MARKS: Record<OtaPlatform, string> = {
  booking: "B.",
  agoda: "A.",
  trip: "T.",
};

function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function taipeiToday(): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function jsonRequest<T>(path: string, body: unknown, timeout: number): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = (await response.json()) as { detail?: string } & T;
    if (!response.ok) throw new Error(payload.detail ?? "資料取得失敗。");
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("平台頁面處理逾時，沒有把未知狀態改成售完。");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function formatDate(value: string, includeYear = false): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "UTC",
    month: "numeric",
    day: "numeric",
    ...(includeYear ? { year: "numeric" as const } : {}),
  }).format(new Date(`${value}T00:00:00Z`));
}

function weekday(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatMoney(amount: number, currency = "TWD"): string {
  if (currency === "TWD") {
    return `NT$${new Intl.NumberFormat("zh-TW", {
      maximumFractionDigits: 0,
    }).format(amount)}`;
  }
  try {
    return new Intl.NumberFormat("zh-TW", {
      style: "currency",
      currency,
      currencyDisplay: "code",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString("en-US")}`;
  }
}

function statusLabel(state: OtaPlatformScan["state"] | undefined): string {
  switch (state) {
    case "ready":
      return "已取得";
    case "partial":
      return "部分資料";
    case "blocked":
      return "平台限制";
    case "not_found":
      return "未找到";
    case "failed":
      return "取得失敗";
    default:
      return "尚未抓取";
  }
}

function availabilityLabel(value: OtaAvailability): string {
  if (value === "available") return "有房";
  if (value === "sold_out") return "售完";
  return "未知";
}

function roomDay(
  scan: OtaPlatformScan | undefined,
  roomId: string,
  stayDate: string,
): { availability: OtaAvailability; amount?: number; currency?: string } {
  const day = scan?.observations.find((item) => item.stayDate === stayDate);
  const rooms = day?.rooms.filter((room) => room.canonicalRoomId === roomId) ?? [];
  if (!rooms.length) return { availability: "unknown" };
  const availability = rooms.some((room) => room.availability === "available")
    ? "available"
    : rooms.every((room) => room.availability === "sold_out")
      ? "sold_out"
      : "unknown";
  const currencies = [...new Set(rooms.map((room) => room.currency).filter(Boolean))];
  const prices = rooms
    .map((room) => room.amount)
    .filter((amount): amount is number => amount !== undefined);
  return {
    availability,
    amount: currencies.length === 1 && prices.length ? Math.min(...prices) : undefined,
    currency: currencies.length === 1 ? currencies[0] : undefined,
  };
}

function roomSummary(scan: OtaPlatformScan | undefined, roomId: string) {
  if (!scan) return { primary: "—", secondary: "尚未抓取", tone: "muted" as const };
  const values = scan.observations.map((day) => roomDay(scan, roomId, day.stayDate));
  const availableDays = values.filter((item) => item.availability === "available").length;
  const soldOutDays = values.filter((item) => item.availability === "sold_out").length;
  const knownDays = availableDays + soldOutDays;
  const prices = values.filter(
    (item): item is { availability: OtaAvailability; amount: number; currency: string } =>
      item.amount !== undefined && Boolean(item.currency),
  );
  const currencies = [...new Set(prices.map((item) => item.currency))];
  let primary = "價格未公開";
  if (currencies.length === 1 && prices.length) {
    const amounts = prices.map((item) => item.amount);
    const minimum = Math.min(...amounts);
    const maximum = Math.max(...amounts);
    primary =
      minimum === maximum
        ? formatMoney(minimum, currencies[0])
        : `${formatMoney(minimum, currencies[0])} – ${formatMoney(maximum, currencies[0])}`;
  }
  if (knownDays) {
    return {
      primary,
      secondary: `有房 ${availableDays} 天 · 售完 ${soldOutDays} 天`,
      tone: availableDays ? ("good" as const) : ("danger" as const),
    };
  }
  if (scan.platform === "booking" && scan.identity.status === "confirmed") {
    return { primary: "房型已辨識", secondary: "日期價格未能驗證", tone: "warning" as const };
  }
  if (scan.platform === "trip" && scan.completedDays) {
    return {
      primary: "日期已核對",
      secondary: `${scan.completedDays}/${scan.requestedDays} 天 · 價格未公開`,
      tone: "warning" as const,
    };
  }
  return { primary, secondary: statusLabel(scan.state), tone: "muted" as const };
}

function platformDay(scan: OtaPlatformScan | undefined, stayDate: string) {
  return scan?.observations.find((item) => item.stayDate === stayDate);
}

function StatusDot({ value, title }: { value: OtaAvailability; title?: string }) {
  return (
    <span
      className={`${styles.statusDot} ${
        value === "available"
          ? styles.dotAvailable
          : value === "sold_out"
            ? styles.dotSoldOut
            : styles.dotUnknown
      }`}
      title={title ?? availabilityLabel(value)}
      aria-label={title ?? availabilityLabel(value)}
    />
  );
}

function EmptyChart({ children }: { children: React.ReactNode }) {
  return <div className={styles.emptyChart}>{children}</div>;
}

function PriceChart({ scan, roomId }: { scan?: OtaPlatformScan; roomId: string }) {
  const points = (scan?.observations ?? []).flatMap((day, index) => {
    const value = roomDay(scan, roomId, day.stayDate);
    return value.amount !== undefined && value.currency
      ? [{ index, date: day.stayDate, amount: value.amount, currency: value.currency }]
      : [];
  });
  const currencies = [...new Set(points.map((point) => point.currency))];
  if (points.length < 2 || currencies.length !== 1) {
    return <EmptyChart>目前沒有至少兩天、同一幣別且通過日期核對的價格。</EmptyChart>;
  }
  const min = Math.min(...points.map((point) => point.amount));
  const max = Math.max(...points.map((point) => point.amount));
  const range = Math.max(max - min, 1);
  const coordinates = points.map((point) => ({
    ...point,
    x: 32 + (point.index / 13) * 536,
    y: 150 - ((point.amount - min) / range) * 112,
  }));
  const path = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <div className={styles.chartWrap}>
      <svg viewBox="0 0 600 190" role="img" aria-label="14 天價格趨勢">
        {[38, 94, 150].map((y) => (
          <line key={y} x1="32" x2="568" y1={y} y2={y} className={styles.gridLine} />
        ))}
        <polyline points={path} className={styles.chartLine} />
        {coordinates.map((point) => (
          <circle key={point.date} cx={point.x} cy={point.y} r="4" className={styles.chartPoint}>
            <title>{`${formatDate(point.date)} ${formatMoney(point.amount, point.currency)}`}</title>
          </circle>
        ))}
        <text x="32" y="178" className={styles.chartLabel}>{formatDate(points[0]!.date)}</text>
        <text x="568" y="178" textAnchor="end" className={styles.chartLabel}>{formatDate(points.at(-1)!.date)}</text>
        <text x="32" y="22" className={styles.chartValue}>{formatMoney(max, currencies[0])}</text>
      </svg>
    </div>
  );
}

function PlatformBadge({ platform }: { platform: OtaPlatform }) {
  return (
    <span className={`${styles.platformMark} ${styles[`mark_${platform}`]}`}>
      {PLATFORM_MARKS[platform]}
    </span>
  );
}

function ProgressBadge({ progress, scan }: { progress?: ScanProgress[OtaPlatform]; scan?: OtaPlatformScan }) {
  if (progress === "running") {
    return <span className={styles.progressBadge}><Loader2 size={13} className={styles.spin} />抓取中</span>;
  }
  return <span className={styles.progressBadge}>{statusLabel(scan?.state)}</span>;
}

export default function RadarDashboard() {
  const [url, setUrl] = useState("https://www.sweetfuntw.com/");
  const [analysis, setAnalysis] = useState<CompetitorRadarAnalysis | null>(null);
  const [scans, setScans] = useState<ScanMap>({});
  const [progress, setProgress] = useState<ScanProgress>({});
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const startDate = addDays(taipeiToday(), 1);
  const dates = useMemo(
    () => Array.from({ length: 14 }, (_, index) => addDays(startDate, index)),
    [startDate],
  );

  const selectedRoom =
    analysis?.canonicalRooms.find((room) => room.id === selectedRoomId) ??
    analysis?.canonicalRooms[0];

  async function scanPlatform(platform: OtaPlatform, current: CompetitorRadarAnalysis) {
    setProgress((state) => ({ ...state, [platform]: "running" }));
    try {
      const sweetfun = /水芳|sweetfun|新北市民宿\s*402/i.test(
        [current.property.name, current.property.registrationNumber, current.property.sourceUrl]
          .filter(Boolean)
          .join(" "),
      );
      const discoveredUrl = current.platformSources.find(
        (source) => source.platform === platform,
      )?.sourceUrl;
      const sourceUrl = platform === "agoda" && sweetfun ? undefined : discoveredUrl;
      const result = await jsonRequest<OtaScanResponse>(
        "/api/radar-ota",
        {
          platform,
          startDate,
          days: 14,
          adults: 2,
          property: current.property,
          canonicalRooms: current.canonicalRooms,
          sourceUrl,
        },
        280_000,
      );
      setScans((state) => ({ ...state, [platform]: result.scan }));
      setProgress((state) => ({ ...state, [platform]: "done" }));
    } catch (reason) {
      setProgress((state) => ({ ...state, [platform]: "failed" }));
      setMessage(
        `${PLATFORM_LABELS[platform]} 暫時未完成：${reason instanceof Error ? reason.message : "請稍後重試"}`,
      );
    }
  }

  async function scanAll(current: CompetitorRadarAnalysis) {
    setScans({});
    setProgress({ booking: "waiting", agoda: "waiting", trip: "waiting" });
    for (const platform of ["agoda", "booking", "trip"] as OtaPlatform[]) {
      await scanPlatform(platform, current);
    }
  }

  async function analyze() {
    if (!/^https?:\/\//i.test(url)) {
      setError("請貼上完整的 http:// 或 https:// 網址。");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("正在辨識住宿與官網房型…");
    setAnalysis(null);
    setScans({});
    try {
      const website = await jsonRequest<CompetitorRadarAnalysis>(
        "/api/radar-preview",
        { phase: "website", url },
        60_000,
      );
      let complete = website;
      try {
        setMessage("已建立房型，正在核對政府旅宿資料…");
        const registry = await jsonRequest<TourismRegistryMatch>(
          "/api/radar-preview",
          { phase: "registry", property: website.property },
          40_000,
        );
        complete = { ...website, tourismRegistry: registry };
      } catch {
        complete = website;
      }
      if (!complete.canonicalRooms.length) {
        throw new Error("官網沒有辨識到房型，請換成住宿的房型頁網址再試一次。");
      }
      setAnalysis(complete);
      setSelectedRoomId(complete.canonicalRooms[0]!.id);
      setMessage("住宿已辨識，正在讀取各 OTA 公開頁面；平台會依序完成。");
      await scanAll(complete);
      setMessage("分析完成。未知代表平台沒有回傳足夠證據，不是沒有房。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "無法完成分析。");
    } finally {
      setBusy(false);
    }
  }

  function editRoom(roomId: string, field: "name" | "capacity", value: string) {
    setAnalysis((current) => {
      if (!current) return current;
      return {
        ...current,
        canonicalRooms: current.canonicalRooms.map((room) =>
          room.id === roomId
            ? {
                ...room,
                [field]: field === "capacity" ? (value ? Number(value) : undefined) : value,
              }
            : room,
        ),
      };
    });
  }

  const registryCandidate = analysis?.tourismRegistry?.candidates.find(
    (candidate) => candidate.hotelId === analysis.tourismRegistry?.selectedHotelId,
  );
  const verified = analysis?.tourismRegistry?.status === "matched" || analysis?.property.identityStatus === "confirmed";
  const displayTabScan = activeTab === "overview" ? undefined : scans[activeTab];

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo}><Radar size={22} /></span>
          <div><strong>Daili 競品雷達</strong><small>一個連結，核對各平台公開價格與可售狀態</small></div>
        </div>
        <span className={styles.previewTag}>測試版 · 公開資料</span>
      </header>

      <section className={styles.searchCard}>
        <form onSubmit={(event) => { event.preventDefault(); void analyze(); }}>
          <div className={styles.searchInput}>
            <Search size={19} />
            <input
              aria-label="民宿官網網址"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="貼上民宿官網網址"
              disabled={busy}
            />
          </div>
          <button className={styles.primaryButton} disabled={busy}>
            {busy ? <Loader2 size={17} className={styles.spin} /> : <Search size={17} />}
            {busy ? "分析中" : "開始分析"}
          </button>
        </form>
        <p>目前可直接測試水芳官網。系統會辨識住宿、建立房型，再讀取 Booking、Agoda 與 Trip.com 公開頁面。</p>
      </section>

      {error && <div className={styles.error} role="alert"><AlertCircle size={17} />{error}</div>}
      {message && <div className={styles.message} role="status">{busy && <Loader2 size={15} className={styles.spin} />}{message}</div>}

      {analysis && (
        <>
          <section className={styles.propertyCard}>
            <div className={styles.propertyAvatar}>{analysis.property.name.slice(0, 1)}</div>
            <div className={styles.propertyInfo}>
              <div className={styles.propertyTitleRow}>
                <h1>{analysis.property.name}</h1>
                <span className={verified ? styles.verified : styles.review}>
                  {verified ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                  {verified ? "住宿已核對" : "請核對住宿"}
                </span>
              </div>
              <p><MapPin size={15} />{analysis.property.address ?? "官網未公開完整地址"}</p>
              <div className={styles.propertyMeta}>
                <span>{analysis.property.registrationNumber ?? registryCandidate?.registrationNumber ?? "未找到民宿編號"}</span>
                <span>{analysis.canonicalRooms.length} 個官網房型</span>
              </div>
            </div>
            <button className={styles.secondaryButton} onClick={() => setEditing((value) => !value)}>
              <Settings2 size={15} />{editing ? "完成編輯" : "編輯民宿資訊"}
            </button>
          </section>

          {editing && (
            <section className={styles.editor}>
              <div className={styles.editorHeading}>
                <div><h2>確認官網房型</h2><p>官網是房型草稿來源；修改後重新抓取 OTA，系統會重新對應。</p></div>
                <button onClick={() => void scanAll(analysis)} disabled={busy}><RefreshCw size={14} />重新抓取 OTA</button>
              </div>
              <div className={styles.editorGrid}>
                {analysis.canonicalRooms.map((room) => (
                  <div className={styles.editorRoom} key={room.id}>
                    <input aria-label={`${room.name} 房型名稱`} value={room.name} onChange={(event) => editRoom(room.id, "name", event.target.value)} />
                    <label>入住<input aria-label={`${room.name} 入住人數`} type="number" min={1} max={20} value={room.capacity ?? ""} onChange={(event) => editRoom(room.id, "capacity", event.target.value)} /></label>
                  </div>
                ))}
              </div>
              {analysis.tourismRegistry && <details><summary>查看住宿比對依據</summary><p>{analysis.tourismRegistry.message}</p>{analysis.tourismRegistry.candidates.slice(0, 3).map((candidate) => <p key={candidate.hotelId}><strong>{candidate.name}</strong> · {candidate.address ?? "無地址"} · {Math.round(candidate.score * 100)}%</p>)}</details>}
            </section>
          )}

          <nav className={styles.tabs} aria-label="平台切換">
            <button className={activeTab === "overview" ? styles.activeTab : ""} onClick={() => setActiveTab("overview")}>總覽</button>
            {PLATFORMS.map((platform) => (
              <button key={platform} className={activeTab === platform ? styles.activeTab : ""} onClick={() => setActiveTab(platform)}>
                <PlatformBadge platform={platform} />
                {PLATFORM_LABELS[platform]}
                <ProgressBadge progress={progress[platform]} scan={scans[platform]} />
              </button>
            ))}
          </nav>

          {activeTab === "overview" ? (
            <section className={styles.contentCard}>
              <div className={styles.contentHeading}>
                <div><h2>未來 14 天價格與可售狀態</h2><p>房量是平台公開頁面的參考狀態，不是實體庫存或確認訂單。</p></div>
                <span className={styles.dateRange}><CalendarDays size={15} />{formatDate(startDate, true)} – {formatDate(addDays(startDate, 13), true)}</span>
              </div>
              <div className={styles.tableScroll}>
                <table className={styles.overviewTable}>
                  <thead><tr><th>房型（共 {analysis.canonicalRooms.length} 間）</th>{PLATFORMS.map((platform) => <th key={platform}><PlatformBadge platform={platform} />{PLATFORM_LABELS[platform]}</th>)}</tr></thead>
                  <tbody>
                    {analysis.canonicalRooms.map((room) => (
                      <tr key={room.id}>
                        <td><strong>{room.name}</strong><small>{room.capacity ? `${room.capacity} 人` : "人數待確認"}{room.roomNumber ? ` · ${room.roomNumber}` : ""}</small></td>
                        {PLATFORMS.map((platform) => {
                          const summary = roomSummary(scans[platform], room.id);
                          return <td key={platform}><div className={styles.summaryCell}><strong>{summary.primary}</strong><small className={styles[summary.tone]}>{summary.secondary}</small><ChevronRight size={15} /></div></td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className={styles.visualGrid}>
                <section className={styles.visualCard}>
                  <div className={styles.visualHeading}><div><h3>價格趨勢</h3><p>只畫通過住宿、日期與幣別核對的數字</p></div><select aria-label="價格趨勢房型" value={selectedRoom?.id ?? ""} onChange={(event) => setSelectedRoomId(event.target.value)}>{analysis.canonicalRooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></div>
                  <div className={styles.chartTabs}>{PLATFORMS.map((platform) => <button key={platform} onClick={() => setActiveTab(platform)}><PlatformBadge platform={platform} />{PLATFORM_LABELS[platform]}</button>)}</div>
                  <PriceChart scan={scans.agoda} roomId={selectedRoom?.id ?? ""} />
                  <small className={styles.chartNote}>目前優先顯示 Agoda；其他平台沒有足夠日期證據時維持空白。</small>
                </section>
                <section className={styles.visualCard}>
                  <div className={styles.visualHeading}><div><h3>平台可售狀態</h3><p>綠＝有可訂方案、紅＝平台明確售完、灰＝未知</p></div></div>
                  <div className={styles.calendarGrid}>
                    <div />{dates.slice(0, 7).map((date) => <div className={styles.calendarDate} key={date}>{formatDate(date)}<small>{weekday(date)}</small></div>)}
                    {PLATFORMS.map((platform) => <div className={styles.calendarRow} key={platform}><strong>{PLATFORM_LABELS[platform]}</strong>{dates.slice(0, 7).map((date) => { const day = platformDay(scans[platform], date); return <span key={date}><StatusDot value={day?.availability ?? "unknown"} title={day?.message} /></span>; })}</div>)}
                  </div>
                </section>
              </div>
            </section>
          ) : (
            <section className={styles.contentCard}>
              <div className={styles.contentHeading}>
                <div className={styles.platformHeading}><PlatformBadge platform={activeTab} /><div><h2>{PLATFORM_LABELS[activeTab]}</h2><p>{displayTabScan ? `${displayTabScan.completedDays}/${displayTabScan.requestedDays} 天完成日期核對 · ${statusLabel(displayTabScan.state)}` : "尚未取得資料"}</p></div></div>
                <button className={styles.secondaryButton} onClick={() => analysis && void scanPlatform(activeTab, analysis)} disabled={progress[activeTab] === "running"}><RefreshCw size={15} />重新抓取</button>
              </div>
              {displayTabScan?.identity.sourceUrl && <a className={styles.sourceLink} href={displayTabScan.identity.sourceUrl} target="_blank" rel="noreferrer noopener"><ShieldCheck size={15} />{displayTabScan.identity.sourceName ?? "開啟平台來源"}<ExternalLink size={13} /></a>}
              <div className={styles.platformSummary}>
                <span className={displayTabScan?.identity.status === "confirmed" ? styles.verified : styles.review}>{displayTabScan?.identity.status === "confirmed" ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}{displayTabScan?.identity.status === "confirmed" ? "住宿身分相符" : "住宿身分待確認"}</span>
                <span>{displayTabScan?.warnings[0] ?? "平台資料尚未取得。"}</span>
              </div>
              <div className={styles.dayTableScroll}>
                <table className={styles.dayTable}>
                  <thead><tr><th>房型</th>{dates.map((date) => <th key={date}>{formatDate(date)}<small>{weekday(date)}</small></th>)}</tr></thead>
                  <tbody>
                    {analysis.canonicalRooms.map((room) => (
                      <tr key={room.id}><td><strong>{room.name}</strong><small>{room.capacity ? `${room.capacity} 人` : ""}</small></td>{dates.map((date) => { const value = roomDay(displayTabScan, room.id, date); return <td key={date}><StatusDot value={value.availability} />{value.amount !== undefined && <small>{formatMoney(value.amount, value.currency)}</small>}</td>; })}</tr>
                    ))}
                    {activeTab !== "agoda" && <tr><td><strong>平台層狀態</strong><small>未能對應到官網房型時顯示於此</small></td>{dates.map((date) => { const day = platformDay(displayTabScan, date); return <td key={date}><StatusDot value={day?.availability ?? "unknown"} title={day?.message} />{day?.minAmount !== undefined && <small>{formatMoney(day.minAmount, day.currency)}</small>}</td>; })}</tr>}
                  </tbody>
                </table>
              </div>
              {displayTabScan?.warnings.length ? <details className={styles.notes}><summary>資料限制與判讀方式</summary>{displayTabScan.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details> : null}
            </section>
          )}

          <div className={styles.disclaimer}><ShieldCheck size={18} /><span><strong>參考資料，不是確認銷售。</strong> 平台可售量可能受到配額、關房與限制條件影響；未知與抓取失敗不會被當成售完。</span></div>
        </>
      )}

      {!analysis && !busy && (
        <section className={styles.emptyState}>
          <div><Search size={25} /></div>
          <h2>貼一個網址就開始</h2>
          <p>先辨識住宿與房型，再將三個 OTA 的公開資料放到同一張表。</p>
        </section>
      )}
    </main>
  );
}
