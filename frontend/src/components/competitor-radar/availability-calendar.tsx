"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarDays, ArrowLeftRight } from "lucide-react";
import type { CapacityProvenance, CapacityStatus, OtaPlatformScan } from "@/lib/competitor-radar/ota-types";
import {
  calendarDay,
  isCapacityConfirmed,
  offsetDate,
  periodDates,
  shiftMonth,
  summarizeCalendar,
  weekStart,
  type CalendarDay,
  type CalendarRoom,
} from "./calendar-data";
import styles from "./availability-calendar.module.css";

const number = (value: number) => value.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];

function inventoryUnits(inventory?: Record<string, number>) {
  if (!inventory) return null;
  const values = Object.values(inventory);
  if (!values.length || values.some(n => !Number.isInteger(n) || n <= 0)) return null;
  return values.reduce((sum, n) => sum + n, 0);
}

export default function AvailabilityCalendar({
  scan,
  rooms,
  inventory,
  startDate,
  assumeUnlisted,
  inventorySource,
  capacityStatus,
  capacityProvenance,
  draftInventory,
}: {
  scan?: OtaPlatformScan;
  rooms: CalendarRoom[];
  /** Only pass when capacityStatus==="confirmed"; pending inventory must not reach rates. */
  inventory?: Record<string, number>;
  startDate: string;
  assumeUnlisted: boolean;
  inventorySource?: string;
  capacityStatus?: CapacityStatus;
  capacityProvenance?: CapacityProvenance;
  /** Display-only draft units; never used for rates/heat. */
  draftInventory?: Record<string, number>;
}) {
  const capacityConfirmed = isCapacityConfirmed(capacityStatus);
  const [mode, setMode] = useState<"month" | "week">("month");
  const [anchor, setAnchor] = useState(startDate);
  const [selection, setSelection] = useState<string | null>(startDate);
  const surface = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const period = useMemo(() => periodDates(anchor, mode), [anchor, mode]);
  const gridDates = useMemo(() => {
    if (mode === "week") return period;
    const first = weekStart(period[0]);
    const daysBefore = (Date.parse(period[0]) - Date.parse(first)) / 86400000;
    return Array.from({ length: Math.ceil((daysBefore + period.length) / 7) * 7 }, (_, i) => offsetDate(first, i));
  }, [period, mode]);
  const days = useMemo(
    () =>
      new Map(
        gridDates.map(date => [
          date,
          calendarDay(date, scan, rooms, capacityConfirmed ? inventory : undefined, assumeUnlisted, capacityConfirmed),
        ]),
      ),
    [gridDates, scan, rooms, inventory, assumeUnlisted, capacityConfirmed],
  );
  const summary = summarizeCalendar(period.map(date => days.get(date)!));
  const total = capacityConfirmed ? days.get(period[0])?.total ?? null : null;
  const draftTotal = !capacityConfirmed ? inventoryUnits(draftInventory) : null;
  const selectedDate = selection && period.includes(selection) ? selection : period.find(date => days.get(date)?.verified) ?? period[0];
  const selected = days.get(selectedDate)!;
  const changePeriod = useCallback(
    (direction: number) => {
      setAnchor(value => (mode === "week" ? offsetDate(weekStart(value), direction * 7) : shiftMonth(value, direction)));
      setSelection(null);
    },
    [mode],
  );

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    let distance = 0;
    let lastEvent = 0;
    let lastTurn = 0;
    function wheel(event: WheelEvent) {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = Date.now();
      if (now - lastEvent > 180) distance = 0;
      lastEvent = now;
      if (now - lastTurn < 600) return;
      distance += event.deltaX;
      if (Math.abs(distance) > 90) {
        changePeriod(distance > 0 ? 1 : -1);
        distance = 0;
        lastTurn = now;
      }
    }
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [changePeriod]);

  const title =
    mode === "month"
      ? `${anchor.slice(0, 4)} 年 ${Number(anchor.slice(5, 7))} 月`
      : `${period[0].slice(0, 4)} 年 ${shortDate(period[0])} – ${shortDate(period[6])}`;

  const provenanceTotal =
    capacityProvenance?.dailyTotalUnits ??
    (capacityConfirmed ? inventoryUnits(inventory) : null);

  function dayCell(day: CalendarDay) {
    const outside = !period.includes(day.date);
    // Heat / meter only when capacity confirmed and day has a real rate.
    const heatEnabled = capacityConfirmed && day.rate !== null;
    const level = !heatEnabled ? "unknown" : day.rate! >= 90 ? "high" : day.rate! >= 60 ? "medium" : "low";
    const rateLabel = heatEnabled ? `${number(day.rate!)}%` : "—";
    return (
      <button
        key={day.date}
        type="button"
        className={`${styles.day} ${styles[level]} ${outside ? styles.outside : ""} ${selectedDate === day.date ? styles.selected : ""}`}
        disabled={outside}
        aria-pressed={selectedDate === day.date}
        aria-label={`${day.date}，${!heatEnabled ? day.state : `推估去化 ${number(day.rate!)}%，剩餘 ${day.remaining} 間，基準 ${day.total} 間`}`}
        onClick={() => setSelection(day.date)}
      >
        <span className={styles.dayDate}>
          {Number(day.date.slice(8))}
          <span>{mode === "week" ? `週${weekdays[(new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7]}` : ""}</span>
        </span>
        <strong className={styles.rate}>{rateLabel}</strong>
        <span className={styles.remaining}>
          {day.remaining !== null
            ? `餘 ${day.remaining} 間`
            : day.observedRemaining !== null
              ? `已知餘 ${day.observedRemaining} 間`
              : day.state}
        </span>
        <small className={styles.depleted}>
          {day.depleted !== null ? (
            <>
              {day.depleted}/{day.total}
              <span className={styles.depletedLabel}> 去化</span>
            </>
          ) : !capacityConfirmed && day.verified ? (
            "容量待確認"
          ) : day.unknownRooms > 0 && day.verified ? (
            `${day.unknownRooms} 房型未知`
          ) : day.total !== null ? (
            `基準 ${day.total} 間`
          ) : day.state === "未抓取" ? (
            "未抓取"
          ) : (
            "容量待確認"
          )}
        </small>
        {heatEnabled && (
          <span className={styles.meter} aria-hidden="true">
            <span style={{ width: `${day.rate}%` }} />
          </span>
        )}
      </button>
    );
  }

  const capacitySourceLabel = !capacityConfirmed
    ? "容量待確認"
    : inventorySource === "user_confirmed" || inventorySource === "confirmed"
      ? "已確認容量"
      : inventorySource === "estimated"
        ? "平台推估（不應用於 github）"
        : "已確認容量";

  return (
    <section className={styles.panel} aria-label="Booking 房況月曆">
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>BOOKING.COM · 房況觀察</span>
          <h2>看懂每一天的去化</h2>
          <p>每格為一晚住宿，點選日期查看各房型。</p>
        </div>
        <div className={styles.mode} role="group" aria-label="月曆與週曆模式">
          <button aria-pressed={mode === "month"} onClick={() => setMode("month")}>
            <CalendarDays size={16} />
            月曆
          </button>
          <button
            aria-pressed={mode === "week"}
            onClick={() => {
              setAnchor(selectedDate);
              setMode("week");
            }}
          >
            <ArrowLeftRight size={16} />
            週曆
          </button>
        </div>
      </div>
      <div className={styles.summary} aria-label="所選期間總結">
        <div>
          <span>期間推估去化率</span>
          <strong>{!capacityConfirmed || summary.rate === null ? "—" : `${number(summary.rate)}%`}</strong>
          <small>{!capacityConfirmed ? "容量待確認，不計去化率" : `僅計 ${summary.completeDays} 個房況完整日`}</small>
        </div>
        <div>
          <span>{total == null ? "已觀測剩餘房晚" : "期間剩餘房晚"}</span>
          <strong>
            {total == null
              ? summary.observedDays
                ? number(summary.observedRemainingNights)
                : "—"
              : summary.completeDays
                ? number(summary.remainingNights)
                : "—"}
            <em> 房晚</em>
          </strong>
          <small>
            {total == null
              ? `${summary.observedDays} 天明示數量合計，未知不計`
              : `去化 ${summary.completeDays ? number(summary.depletedNights) : "—"} / ${summary.capacityNights || "—"} 房晚`}
          </small>
        </div>
        <div>
          <span>每日房量基準</span>
          <strong>
            {total ?? "—"}
            <em> 間</em>
          </strong>
          <small>
            {rooms.length} 種房型 · {capacitySourceLabel}
            {draftTotal != null ? ` · 草稿顯示 ${draftTotal} 間（不計率）` : ""}
          </small>
        </div>
        <div>
          <span>可計去化天數</span>
          <strong>
            {capacityConfirmed ? summary.completeDays : 0}
            <em> / {summary.requestedDays} 天</em>
          </strong>
          <small>{!capacityConfirmed ? "容量待確認" : "未確認日期不計入去化率"}</small>
        </div>
      </div>
      <div className={styles.toolbar}>
        <h3 aria-live="polite" data-testid="calendar-period">
          {title}
        </h3>
        <div>
          <button aria-label={mode === "week" ? "上一週" : "上一月"} onClick={() => changePeriod(-1)}>
            <ChevronLeft size={19} />
          </button>
          <button
            onClick={() => {
              setAnchor(startDate);
              setSelection(startDate);
            }}
          >
            回到資料起日
          </button>
          <button aria-label={mode === "week" ? "下一週" : "下一月"} onClick={() => changePeriod(1)}>
            <ChevronRight size={19} />
          </button>
        </div>
      </div>
      <div className={styles.legend}>
        {capacityConfirmed ? (
          <>
            <span>
              <i className={styles.lowDot} />
              低於 60%
            </span>
            <span>
              <i className={styles.mediumDot} />
              60–89%
            </span>
            <span>
              <i className={styles.highDot} />
              90% 以上
            </span>
          </>
        ) : (
          <span>容量待確認 · 熱力與去化率暫不顯示</span>
        )}
        <span className={styles.gestureHint}>← 左右滑動切換{mode === "week" ? "週" : "月"} →</span>
      </div>
      <div
        ref={surface}
        className={styles.surface}
        tabIndex={0}
        role="group"
        aria-label={`可左右滑動的${mode === "week" ? "週曆" : "月曆"}，也可使用左右方向鍵`}
        onKeyDown={event => {
          if (event.target === event.currentTarget && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            changePeriod(event.key === "ArrowRight" ? 1 : -1);
          }
        }}
        onPointerDown={event => {
          pointer.current = { x: event.clientX, y: event.clientY };
          swiped.current = false;
        }}
        onPointerCancel={() => {
          pointer.current = null;
        }}
        onPointerUp={event => {
          if (!pointer.current) return;
          const dx = event.clientX - pointer.current.x;
          const dy = event.clientY - pointer.current.y;
          pointer.current = null;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            swiped.current = true;
            changePeriod(dx < 0 ? 1 : -1);
          }
        }}
        onClickCapture={event => {
          if (swiped.current) {
            event.preventDefault();
            event.stopPropagation();
            swiped.current = false;
          }
        }}
      >
        {mode === "month" && (
          <div className={styles.weekdays}>
            {weekdays.map(day => (
              <span key={day}>週{day}</span>
            ))}
          </div>
        )}
        <div className={`${styles.grid} ${mode === "week" ? styles.week : ""}`} data-testid="calendar-grid">
          {gridDates.map(date => dayCell(days.get(date)!))}
        </div>
      </div>
      <div className={styles.detail}>
        <div className={styles.detailHeading}>
          <h3>{shortDate(selectedDate)} 房型明細</h3>
          <span>
            {capacityConfirmed && selected.rate !== null
              ? `推估去化 ${number(selected.rate)}% · 餘 ${selected.remaining} / ${selected.total} 間`
              : selected.state}
          </span>
        </div>
        <div className={styles.roomList}>
          {selected.rooms.map(room => (
            <div key={room.id}>
              <strong>{room.name}</strong>
              <span>{room.remaining === null ? room.state : `餘 ${room.remaining} 間`}</span>
              <small>
                {room.amount !== undefined
                  ? `含稅 NT$${number(room.amount)}`
                  : room.displayedAmount !== undefined
                    ? `未稅 NT$${number(room.displayedAmount)}`
                    : room.state}
              </small>
            </div>
          ))}
        </div>
      </div>
      {selected.observedAt && (
        <p className={styles.note}>
          此入住日觀測時間：{new Date(selected.observedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}（台灣時間）
          {selected.priceReview ? " · 含稅價格待審" : ""}
        </p>
      )}
      {capacityConfirmed && provenanceTotal != null && (
        <p className={styles.note} data-testid="capacity-provenance">
          容量已確認 · 每日基準 {provenanceTotal} 間
          {capacityProvenance
            ? ` · ${capacityProvenance.confirmedBy} · ${new Date(capacityProvenance.confirmedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })} · ${capacityProvenance.source.method}`
            : inventorySource
              ? ` · 來源 ${inventorySource}`
              : ""}
          {capacityProvenance?.source.note ? ` · ${capacityProvenance.source.note}` : ""}
        </p>
      )}
      {!capacityConfirmed && (
        <p className={styles.note} data-testid="capacity-pending-note">
          容量待確認：不去化率、不著色熱力。已知剩餘與未知房型數仍可顯示
          {draftTotal != null ? `；草稿容量 ${draftTotal} 間僅供參考，不計入去化` : ""}。
        </p>
      )}
      <p className={styles.note}>
        平台房量推估，不等於已確認訂單。
        {assumeUnlisted ? "已核對頁面未列出的房型依設定計 0；失敗與未知不計。" : "未確認的房型與數量保留未知。"}
        未顯示房況的日期不代表售完。
      </p>
      {scan?.capturedAt && (
        <p className={styles.note}>
          資料批次時間：{new Date(scan.capturedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}（台灣時間）
        </p>
      )}
    </section>
  );
}
