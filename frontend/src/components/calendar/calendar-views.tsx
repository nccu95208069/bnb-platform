"use client";
import {GuestNotificationButton} from "./guest-notification";
import {useIntlLocale} from "@/components/i18n/language-provider";
import {useT} from "@/components/i18n/language-provider";

import { PaymentBadge } from "./payment-badge";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useMonthPosition } from "./use-month-position";
import { BedDouble, ChevronUp, LogIn, LogOut, Moon } from "lucide-react";

import { GuestRemarks, remarksFor, BookingIdentity, bookingIdentityText, realGuestName } from "./booking-identity";
import { layoutMonthWeek, monthBookingFontSize, monthWeekPresentation } from "./month-layout";
import { useCalendarPreferences } from "./calendar-preferences";
import { cn } from "@/lib/utils";

import type {
  CalendarBooking,
  CalendarProperty,
  CalendarRoom,
} from "./calendar-types";
import {
  PLATFORM_LABELS,
  PLATFORM_STYLES,
  paymentStateForReview,
  PROPERTY_DOT_STYLES,
  WEEKDAY_LABELS,
  addDays,
  dateRange,
  formatMonthLabel,
  formatShortDate,
  isOccupiedOn,
  isSameMonth,
  localTodayIso,
  monthCalendarPeriod,
  parseIso,
  roomKey,
  startOfMonth,
  stayNightCount,
  stayProgressLabel,
} from "./calendar-utils";

export { WeekCarousel } from "./week-carousel";

export type CalendarViewProps = {
  bookings: CalendarBooking[];
  rooms: CalendarRoom[];
  properties: CalendarProperty[];
  onSelectBooking: (booking: CalendarBooking) => void;
  onSelectDay: (date: string) => void;
};

function propertyById(properties: CalendarProperty[]) {
  return new Map(properties.map((property) => [property.id, property]));
}

function PaymentDot({ booking }: { booking: CalendarBooking }) { return <PaymentBadge booking={booking} />; }

function BookingChip({
  booking,
  property,
  onSelect,
  date,
  compact = false,
}: {
  booking: CalendarBooking;
  property?: CalendarProperty;
  onSelect: (booking: CalendarBooking) => void;
  date?: string;
  compact?: boolean;
}) {
  const uiText = useT();

  const nights = stayNightCount(booking);
  const progress = date ? stayProgressLabel(booking, date) : null;
  const continuesBefore = Boolean(date && booking.check_in < date);
  const continuesAfter = Boolean(date && booking.check_out > addDays(date, 1));
  const compactSuffix =
    nights > 1
      ? progress?.startsWith("入住")
        ? `${nights}晚`
        : (progress?.replace("續住 ", "續") ?? `${nights}晚`)
      : "";

  return (
    <div className="flex min-w-0 items-center gap-1"><button
      type="button"
      data-payment-state={paymentStateForReview(booking)}
      onClick={() => onSelect(booking)}
      className={cn(
        "group flex w-full min-w-0 items-center gap-1.5 border text-left shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact
          ? "min-h-7 py-1 px-1.5 text-[0.625rem] sm:text-[0.6875rem]"
          : "min-h-9 rounded-md px-2.5 py-1.5 text-xs",
        compact && !continuesBefore && "rounded-l-md",
        compact && continuesBefore && "rounded-l-none border-l-4",
        compact && !continuesAfter && "rounded-r-md",
        compact && continuesAfter && "rounded-r-none border-r-4",
        PLATFORM_STYLES[booking.platform] ?? PLATFORM_STYLES.other,
      )}
      title={uiText("{0}｜{1}｜{2}–{3}{4}", [bookingIdentityText(booking),booking.property_name,booking.check_in,booking.check_out,nights > 1 ? `｜連住 ${nights} 晚` : ""])}
    >
      {property ? (
        <span
          className={cn(
            "size-2 shrink-0 rounded-sm",
            PROPERTY_DOT_STYLES[property.color],
          )}
        />
      ) : (
        <PaymentDot booking={booking} />
      )}
      <BookingIdentity booking={booking} />
      {compact && compactSuffix && (
        <span className="min-w-0 truncate font-semibold opacity-75">
          {uiText(compactSuffix)}
        </span>
      )}
      {!compact && (
        <>
          {nights > 1 && (
            <span className="shrink-0 rounded-full bg-white/20 text-inherit px-1.5 py-0.5 text-[0.625rem] font-semibold">
              {uiText(progress ?? `連住 ${nights} 晚`)}
            </span>
          )}
        </>
      )}
      <span className="ml-auto hidden sm:inline-block">
        <PaymentDot booking={booking} />
      </span>
    </button><GuestNotificationButton booking={booking} /></div>
  );
}

// Full channel names remain in accessible labels and booking details.
const MONTH_PLATFORM_LABELS: Record<string, string> = {
  direct: "直訂", booking: "Bkg", agoda: "Ago", airbnb: "Air", ctrip: "Trip", owljourney: "Owl", other: "其他",
};
const MONTH_COMPACT_PLATFORM_LABELS: Record<string, string> = {
  direct: "直", booking: "Bk", agoda: "Ag", airbnb: "Air", ctrip: "Tr", owljourney: "Owl", other: "其",
};

function chunkWeeks(days: string[]) {
  const weeks: string[][] = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(days.slice(index, index + 7));
  }
  return weeks;
}

function MonthPanel({
  monthStart,
  covered = true,
  bookings,
  onSelectBooking,
  onSelectDay,
  viewportHeight,
  fontScale,
  desktop,
}: CalendarViewProps & {
  monthStart: string;
  covered?: boolean;
  viewportHeight: number;
  fontScale: number;
  desktop: boolean;
}) {
const uiLocale = useIntlLocale();

  const uiText = useT();

  const today = localTodayIso();
  const period = monthCalendarPeriod(monthStart);
  const weeks = chunkWeeks(dateRange(period.start, period.end));
  const expandedWeeks = useCalendarPreferences((s) => s.expandedWeeks);
  const setExpandedWeeks = useCalendarPreferences((s) => s.setExpandedWeeks);
  const monthWeekAuto = useCalendarPreferences((s) => s.monthWeekAuto);
  const monthWeekDensity = useCalendarPreferences((s) => s.monthWeekDensity);
  const baseWeekHeight = Math.max(60 * fontScale, Math.floor((viewportHeight - 58 * fontScale) / weeks.length));
  const monthBookings = bookings.filter(
    (booking) =>
      booking.check_in < period.end && booking.check_out >= period.start,
  );
  const activeRoomNights = monthBookings.reduce((sum, booking) => {
    const visibleStart =
      booking.check_in > monthStart ? booking.check_in : monthStart;
    const monthEnd = startOfMonth(addDays(monthStart, 32));
    const visibleEnd =
      booking.check_out < monthEnd ? booking.check_out : monthEnd;
    return (
      sum +
      Math.max(
        0,
        Math.round(
          (parseIso(visibleEnd).getTime() - parseIso(visibleStart).getTime()) /
            86_400_000,
        ),
      )
    );
  }, 0);

  if (!covered) return (
    <section data-month={monthStart}
      className="scroll-mt-2 bg-card" style={{ minHeight: viewportHeight }}>
      <div className="sticky top-0 z-20 flex h-8 items-center justify-between border-y bg-background/95 px-3 backdrop-blur md:px-4">
        <h2 className="text-base font-semibold">{formatMonthLabel(monthStart, uiLocale)}</h2>
        <span className="text-xs text-muted-foreground">{uiText("訂單尚未載入")}</span>
      </div>
    </section>
  );

  return (
    <section
      data-month={monthStart}
      className="scroll-mt-2 bg-card"
    >
      <div className="sticky top-0 z-20 flex items-center justify-between h-8 border-y bg-background/95 px-3 backdrop-blur md:px-4">
        <h2 className="text-base font-semibold">
          {formatMonthLabel(monthStart, uiLocale)}
        </h2>
        <span className="text-xs text-muted-foreground">
          {activeRoomNights} {uiText("房晚")}</span>
      </div>

      <div className="grid grid-cols-7 border-b bg-muted/35">
        {uiText(WEEKDAY_LABELS.map((weekday, index) => (
          <div
            key={weekday}
            className={cn(
              "flex h-6 items-center justify-center border-r px-1 text-center text-[0.625rem] font-semibold text-muted-foreground last:border-r-0 md:text-xs",
              index >= 5 && "bg-muted/45",
            )}
          >
            {uiText(`週${weekday}`)}
          </div>
        )))}
      </div>

      {weeks.map((week) => {
        const weekKey = week[0];
        const expanded = expandedWeeks.includes(weekKey);
        const segments = layoutMonthWeek(monthBookings, week, addDays(week[6], 1));
        const laneCount = Math.max(0, ...segments.map(s => s.lane + 1));
        const { height: weekHeight, visibleLanes: defaultLimit, twoLine } = monthWeekPresentation({ baseWeekHeight, viewportHeight, laneCount, fontScale, desktop, automatic: monthWeekAuto, density: monthWeekDensity });
        const limit = expanded ? Number.POSITIVE_INFINITY : defaultLimit;
        const weekHasOverflow = laneCount > defaultLimit;
        const visibleLanes = Math.min(laneCount, limit);
        const hidden = week.map((_, index) => segments.filter(s => s.lane >= limit && s.start <= index && s.end > index).length);
        const bookingRows = Array.from({ length: visibleLanes }, (_, lane) => {
          const hasRemarks = expanded && segments.some(s => s.lane === lane && remarksFor(s.booking).length);
          return `${(expanded ? (hasRemarks ? 48 : 32) : twoLine ? 32 : 18) * fontScale}px`;
        });
        const gridTemplateRows = [
          `${20 * fontScale}px`,
          ...bookingRows,
          ...(hidden.some(Boolean) ? [`${14 * fontScale}px`] : []),
        ].join(" ");

        return (
          <div key={weekKey} className="border-b last:border-b-0" data-week={weekKey}>
            <div className="relative grid grid-cols-7 py-0.5"
              style={{ minHeight: expanded ? undefined : weekHeight, gridTemplateRows, rowGap: 2 * fontScale }}>
              <div className="pointer-events-none absolute inset-0 grid grid-cols-7" aria-hidden="true">
                {week.map(date => <div key={date} className={cn("border-r last:border-r-0",
                  [0, 6].includes(parseIso(date).getUTCDay()) && "bg-muted/15",
                  !isSameMonth(date, monthStart) && "bg-muted/35",
                  date === today && "bg-primary/[0.035]")} />)}
              </div>
              {week.map((date, index) => {
                const arrivals = monthBookings.filter(b => b.check_in === date).length;
                const departures = monthBookings.filter(b => b.check_out === date).length;
                return <div key={date} className="relative flex items-start justify-between px-1 md:px-2" style={{gridColumn: index + 1, gridRow: 1}}>
                  <button data-calendar-date={date} data-position-date={date} type="button" onClick={() => onSelectDay(date)}
                    className={cn("flex size-5 items-center justify-center rounded-full text-[0.6875rem] font-semibold hover:bg-accent md:text-xs",
                      !isSameMonth(date, monthStart) && "text-muted-foreground",
                      date === today && "bg-primary text-primary-foreground hover:bg-primary/90")}>
                    {parseIso(date).getUTCDate()}
                  </button>
                  <div className="hidden gap-1 text-[0.5625rem] text-muted-foreground sm:flex md:text-[0.625rem]">
                    {arrivals > 0 && <span>{uiText("入")}{arrivals}</span>}
                    {departures > 0 && <span>{uiText("退")}{departures}</span>}
                  </div>
                </div>;
              })}
              {segments.filter(s => s.lane < limit).map(segment => {
                const { booking } = segment;
                const nights = stayNightCount(booking);
                const guestName = realGuestName(booking);
                const label = `${PLATFORM_LABELS[booking.platform] ?? "其他"}｜${guestName || "姓名尚未開放"}｜${booking.property_name}｜${booking.room_number}｜${booking.check_in}–${booking.check_out}${nights > 1 ? `｜連住 ${nights} 晚` : ""}`;
                return <button key={booking.id} type="button" title={uiText(label)} aria-label={uiText(label)}
                  data-stay-id={booking.id} data-stay-start={segment.start} data-stay-end={segment.end}
                  data-payment-state={paymentStateForReview(booking)}
                  onClick={() => onSelectBooking(booking)}
                  style={{ gridColumn: `${segment.start + 1} / ${segment.end + 1}`, gridRow: segment.lane + 2, fontSize: monthBookingFontSize(fontScale, desktop), WebkitTextSizeAdjust: "none", textSizeAdjust: "none" }}
                  className={cn("relative z-10 mx-0.5 flex min-w-0 items-center gap-0.5 overflow-hidden rounded-[3px] px-0.5 text-left leading-none font-medium focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:mx-1 md:px-1",
                    booking.source_conflict ? "bg-slate-200 text-slate-800 hover:bg-slate-300" : PLATFORM_STYLES[booking.platform] ?? PLATFORM_STYLES.other,
                    segment.continuesBefore && "ml-0 rounded-l-none border-l-0 sm:ml-0 md:ml-0",
                    segment.continuesAfter && "mr-0 rounded-r-none border-r-0 sm:mr-0 md:mr-0")}>
                  {segment.continuesBefore && <span aria-hidden="true">‹</span>}
                  <span className={cn("min-w-0 flex-1", !expanded && !twoLine && "truncate")}>
                    <span className={cn("truncate", expanded || twoLine ? "block" : "inline")} style={{ lineHeight: `${12 * fontScale}px` }}>
                      <span className="font-semibold">{booking.source_conflict ? uiText("待核對") : twoLine && !desktop ? MONTH_COMPACT_PLATFORM_LABELS[booking.platform] ?? "其" : MONTH_PLATFORM_LABELS[booking.platform] ?? "其他"}</span>
                      <span className={cn(twoLine ? "ml-0.5" : "ml-1", "opacity-85")}>{booking.room_number}</span>
                      {nights > 1 && !twoLine && <span className="ml-1">{nights}{uiText("晚")}</span>}
                    </span>
                    {(guestName || twoLine) && <span className={cn("month-booking-guest truncate", expanded || twoLine ? "block" : "ml-1 inline")} style={{ lineHeight: `${12 * fontScale}px` }}>
                      {twoLine && nights > 1 && segment.end - segment.start > 1 && <span className="mr-1">{nights}{uiText("晚")}</span>}
                      {guestName || (twoLine ? booking.property_name : null)}
                    </span>}
                    {expanded && <GuestRemarks booking={booking} compact limit={segment.end-segment.start>1?2:1} />}
                  </span>
                  <span className="absolute bottom-0.5 right-0.5"><PaymentBadge booking={booking} compact /></span>
                  {segment.continuesAfter && <span aria-hidden="true">›</span>}
                </button>;
              })}
              {hidden.map((count, index) => count > 0 && <button key={week[index]} type="button"
                style={{gridColumn: index + 1, gridRow: visibleLanes + 2}}
                aria-expanded={false} aria-label={uiText("{0} 展開其餘訂單", [week[index]])}
                onClick={() => setExpandedWeeks(current => current.includes(weekKey) ? current : [...current, weekKey])}
                className="relative mx-0.5 min-w-0 truncate rounded px-0.5 text-left text-[0.5625rem] font-semibold text-muted-foreground hover:bg-accent sm:mx-1 md:text-[0.6875rem]">
                {uiText("還有")}{count} {uiText("筆")}</button>)}
            </div>

            {expanded && weekHasOverflow && (
              <button
                type="button"
                onClick={() =>
                  setExpandedWeeks((current) =>
                    current.filter((value) => value !== weekKey),
                  )
                }
                className="flex w-full items-center justify-center gap-1 border-t bg-muted/20 py-1.5 text-[0.6875rem] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              >
                <ChevronUp className="size-3" />
                {uiText("收合這一列")}</button>
            )}
          </div>
        );
      })}
    </section>
  );
}

// Keep the scroll track and its measured heights stable while only building
// the expensive booking grid around the viewport. Native momentum can cross
// month boundaries without React replacing the scroll container's children.
const LazyMonthPanel = memo(function LazyMonthPanel({ monthStart, covered,
  viewportHeight, fontScale, desktop, bookings, rooms, properties,
  onSelectBooking, onSelectDay, root, initialActive }: CalendarViewProps & {
  monthStart: string; covered: boolean; viewportHeight: number;
  fontScale: number; desktop: boolean; initialActive: boolean;
  root: RefObject<HTMLDivElement | null>;
}) {
  const uiLocale = useIntlLocale();
  const uiText = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(initialActive);
  const [height, setHeight] = useState(viewportHeight);

  useEffect(() => {
    const node = ref.current;
    const container = root.current;
    if (!node || !container) return;
    const observer = new IntersectionObserver(entries => {
      setNear(entries.some(entry => entry.isIntersecting));
    }, { root: container, rootMargin: '900px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !near || !covered) return;
    const measure = () => {
      const next = Math.ceil(node.getBoundingClientRect().height);
      setHeight(current => Math.abs(current - next) > 1 ? next : current);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [near, covered]);

  return <div ref={ref} data-position-month={monthStart}
    style={near && covered ? { minHeight: viewportHeight } : { height: Math.max(height, viewportHeight) }}
    className="bg-card">
    {near && covered ? <MonthPanel monthStart={monthStart} covered
      viewportHeight={viewportHeight} fontScale={fontScale} desktop={desktop}
      bookings={bookings} rooms={rooms} properties={properties}
      onSelectBooking={onSelectBooking} onSelectDay={onSelectDay} /> :
      <div className="sticky top-0 flex h-8 items-center justify-between border-y bg-background px-3">
        <span className="font-semibold">{formatMonthLabel(monthStart, uiLocale)}</span>
        {near && !covered && <span className="text-xs text-muted-foreground">{uiText('訂單尚未載入')}</span>}
      </div>}
  </div>;
});

export function MonthScroller({
  months,
  coveredMonths,
  targetMonth,
  targetRevision,
  bookings,
  rooms,
  properties,
  onVisibleMonthChange,
  onSelectBooking,
  onSelectDay,
}: CalendarViewProps & {
  months: string[];
  coveredMonths?: string[];
  targetMonth: string;
  targetDate?: string;
  targetRevision?: number;
  onVisibleMonthChange: (month: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(520);
  const [fontScale, setFontScale] = useState(1);
  const [desktop, setDesktop] = useState(false);
  const callbacks = useRef({ onSelectBooking, onSelectDay });
  useLayoutEffect(() => { callbacks.current = { onSelectBooking, onSelectDay }; }, [onSelectBooking, onSelectDay]);
  const selectBooking = useCallback((booking: CalendarBooking) => callbacks.current.onSelectBooking(booking), []);
  const selectDay = useCallback((day: string) => callbacks.current.onSelectDay(day), []);
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const measure = () => {
      setViewportHeight(Math.max(320, Math.floor(window.innerHeight - container.getBoundingClientRect().top - (window.innerWidth >= 768 ? 24 : 12))));
      setFontScale(parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1);
      setDesktop(window.innerWidth >= 768);
    };
    measure();
    const observer = new ResizeObserver(measure);
    const fontObserver = new MutationObserver(measure);
    if (container.parentElement?.parentElement) observer.observe(container.parentElement.parentElement);
    fontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", measure);
    window.addEventListener("storage", measure);
    return () => { observer.disconnect(); fontObserver.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("storage", measure); };
  }, []);
  // Month mode starts at the month header so no week is hidden above today.
  useMonthPosition(scrollRef, targetMonth, targetRevision ?? 0, onVisibleMonthChange, months[0]);

  return (
    <div
      ref={scrollRef}
      style={{ overflowAnchor: "none", height: viewportHeight }}
      className="overflow-y-auto overscroll-contain rounded-xl border bg-card shadow-sm"
    >
      {months.map((monthStart) => (
        <LazyMonthPanel
          key={monthStart}
          monthStart={monthStart}
          covered={!coveredMonths || coveredMonths.includes(monthStart)}
          initialActive={monthStart === targetMonth}
          root={scrollRef}
          viewportHeight={viewportHeight}
          fontScale={fontScale}
          desktop={desktop}
          bookings={bookings}
          rooms={rooms}
          properties={properties}
          onSelectBooking={selectBooking}
          onSelectDay={selectDay}
        />
      ))}
    </div>
  );
}

function DayColumn({
  title,
  icon: Icon,
  bookings,
  emptyText,
  properties,
  date,
  onSelectBooking,
}: {
  title: string;
  icon: typeof LogIn;
  bookings: CalendarBooking[];
  emptyText: string;
  properties: CalendarProperty[];
  date: string;
  onSelectBooking: (booking: CalendarBooking) => void;
}) {
  const uiText = useT();

  const propertyMap = useMemo(() => propertyById(properties), [properties]);

  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4" />
          {uiText(title)}
        </h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">
          {bookings.length}
        </span>
      </div>
      <div className="min-h-40 space-y-2 p-3">
        {bookings.map((booking) => (
          <BookingChip
            key={booking.id}
            booking={booking}
            property={propertyMap.get(booking.property_id)}
            onSelect={onSelectBooking}
            date={date}
          />
        ))}
        {bookings.length === 0 && (
          <div className="flex min-h-32 items-center justify-center text-center text-sm text-muted-foreground">
            {uiText(emptyText)}
          </div>
        )}
      </div>
    </section>
  );
}

export function DayView({
  date,
  bookings,
  rooms,
  properties,
  onSelectBooking,
}: CalendarViewProps & { date: string }) {
  const uiText = useT();

  const arrivals = bookings.filter((booking) => booking.check_in === date);
  const departures = bookings.filter((booking) => booking.check_out === date);
  const staying = bookings.filter(
    (booking) => booking.check_in < date && booking.check_out > date,
  );
  const propertyMap = useMemo(() => propertyById(properties), [properties]);
  const bookingByRoom = new Map(
    bookings
      .filter((booking) => isOccupiedOn(booking, date))
      .map((booking) => [
        roomKey(booking.property_id, booking.room_number),
        booking,
      ]),
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-3">
        <DayColumn
          title={uiText("今日入住")}
          icon={LogIn}
          bookings={arrivals}
          emptyText="今天沒有入住"
          properties={properties}
          date={date}
          onSelectBooking={onSelectBooking}
        />
        <DayColumn
          title={uiText("住宿中")}
          icon={Moon}
          bookings={staying}
          emptyText="沒有續住中的客人"
          properties={properties}
          date={date}
          onSelectBooking={onSelectBooking}
        />
        <DayColumn
          title={uiText("今日退房")}
          icon={LogOut}
          bookings={departures}
          emptyText="今天沒有退房"
          properties={properties}
          date={date}
          onSelectBooking={onSelectBooking}
        />
      </div>

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">{uiText("房間狀態")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatShortDate(date)} {uiText("的入住與續住狀態")}</p>
          </div>
          <BedDouble className="size-4 text-muted-foreground" />
        </div>
        <div className="grid sm:grid-cols-2 xl:grid-cols-3">
          {rooms.map((room) => {
            const property = propertyMap.get(room.property_id);
            const current = bookingByRoom.get(
              roomKey(room.property_id, room.room_number),
            );
            const arriving = current?.check_in === date;
            const progress = current ? stayProgressLabel(current, date) : null;
            return (
              <button
                key={room.id}
                type="button"
                disabled={!current}
                onClick={() => current && onSelectBooking(current)}
                className="min-h-28 border-b border-r p-4 text-left transition-colors hover:bg-accent/40 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      {property && (
                        <span
                          className={cn(
                            "size-2 rounded-sm",
                            PROPERTY_DOT_STYLES[property.color],
                          )}
                        />
                      )}
                      {property?.short_name}
                    </p>
                    <p className="mt-1 text-lg font-semibold">{room.label}</p>
                  </div>
                  <span className="rounded-full bg-muted px-2 py-1 text-[0.625rem] font-semibold">
                    {current
                      ? arriving
                        ? uiText("今日入住")
                        : uiText(progress ?? "住宿中")
                      : uiText("空房")}
                  </span>
                </div>
                <p className="mt-3 truncate text-sm text-muted-foreground">
                  {current ? bookingIdentityText(current) : uiText("尚無入住安排")}
                </p>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
