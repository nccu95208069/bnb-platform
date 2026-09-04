"use client";

import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BedDouble,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  DoorOpen,
  LoaderCircle,
  LogIn,
  LogOut,
  RefreshCw,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { apiClient } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type CalendarView = "month" | "week" | "day";
type PaymentStatus = "paid" | "deposit" | "unpaid";

type CalendarBooking = {
  id: string;
  sheet_row_id: string;
  order_id: string | null;
  external_order_no: string | null;
  room_number: string;
  guest_name: string;
  platform: string;
  check_in: string;
  check_out: string;
  booked_at: string | null;
  room_rate: number;
  payment_status: PaymentStatus;
  notes: string | null;
};

type CalendarResponse = {
  year: number;
  month: number;
  month_start: string;
  month_end: string;
  period_start?: string;
  period_end?: string;
  rooms: string[];
  order_count: number;
  booking_segment_count: number;
  total_amount: number;
  bookings: CalendarBooking[];
};

type CalendarPeriod = {
  start: string;
  end: string;
  label: string;
};

type CalendarViewProps = {
  bookings: CalendarBooking[];
  rooms: string[];
  anchorDate: string;
  period: CalendarPeriod;
  onSelectBooking: (booking: CalendarBooking) => void;
  onSelectDay: (date: string) => void;
};

const DEFAULT_ROOMS = ["101", "102", "201", "202", "301", "302"];
const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const VIEW_LABELS: Record<CalendarView, string> = {
  month: "月",
  week: "週",
  day: "日",
};

const PLATFORM_LABELS: Record<string, string> = {
  direct: "LINE／直訂",
  agoda: "Agoda",
  booking: "Booking",
  airbnb: "Airbnb",
  ctrip: "CTrip",
  owljourney: "OwlJourney",
  other: "其他",
};

const PLATFORM_STYLES: Record<string, string> = {
  direct: "border-emerald-200 bg-emerald-50 text-emerald-950 hover:bg-emerald-100",
  agoda: "border-violet-200 bg-violet-50 text-violet-950 hover:bg-violet-100",
  booking: "border-sky-200 bg-sky-50 text-sky-950 hover:bg-sky-100",
  airbnb: "border-rose-200 bg-rose-50 text-rose-950 hover:bg-rose-100",
  ctrip: "border-amber-200 bg-amber-50 text-amber-950 hover:bg-amber-100",
  owljourney: "border-indigo-200 bg-indigo-50 text-indigo-950 hover:bg-indigo-100",
  other: "border-slate-200 bg-slate-50 text-slate-950 hover:bg-slate-100",
};

const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  paid: "已付清",
  deposit: "已付訂金",
  unpaid: "未付款",
};

const PAYMENT_DOT_STYLES: Record<PaymentStatus, string> = {
  paid: "bg-emerald-500",
  deposit: "bg-amber-500",
  unpaid: "bg-rose-500",
};

const DAY_MS = 86_400_000;

function parseIso(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toIso(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, amount: number) {
  const date = parseIso(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return toIso(date);
}

function addMonths(value: string, amount: number) {
  const source = parseIso(value);
  const originalDay = source.getUTCDate();
  const targetMonthStart = new Date(
    Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + amount, 1),
  );
  const targetMonthEnd = new Date(
    Date.UTC(targetMonthStart.getUTCFullYear(), targetMonthStart.getUTCMonth() + 1, 0),
  );
  targetMonthStart.setUTCDate(Math.min(originalDay, targetMonthEnd.getUTCDate()));
  return toIso(targetMonthStart);
}

function startOfWeek(value: string) {
  const date = parseIso(value);
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return toIso(date);
}

function startOfMonth(value: string) {
  const date = parseIso(value);
  date.setUTCDate(1);
  return toIso(date);
}

function dayDifference(value: string, origin: string) {
  return Math.round((parseIso(value).getTime() - parseIso(origin).getTime()) / DAY_MS);
}

function dateRange(start: string, end: string) {
  return Array.from({ length: Math.max(0, dayDifference(end, start)) }, (_, index) =>
    addDays(start, index),
  );
}

function localTodayIso() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
    today.getDate(),
  ).padStart(2, "0")}`;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(parseIso(value));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(parseIso(value));
}

function formatWeekday(value: string, long = false) {
  return new Intl.DateTimeFormat("zh-TW", {
    weekday: long ? "long" : "short",
    timeZone: "UTC",
  }).format(parseIso(value));
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: "TWD",
    maximumFractionDigits: 0,
  }).format(value);
}

function isSameMonth(value: string, anchorDate: string) {
  const date = parseIso(value);
  const anchor = parseIso(anchorDate);
  return (
    date.getUTCFullYear() === anchor.getUTCFullYear() &&
    date.getUTCMonth() === anchor.getUTCMonth()
  );
}

function isOccupiedOn(booking: CalendarBooking, date: string) {
  return booking.check_in <= date && booking.check_out > date;
}

function isLastNight(booking: CalendarBooking, date: string) {
  return addDays(date, 1) === booking.check_out;
}

function overlapNights(booking: CalendarBooking, period: CalendarPeriod) {
  const start = booking.check_in > period.start ? booking.check_in : period.start;
  const end = booking.check_out < period.end ? booking.check_out : period.end;
  return Math.max(0, dayDifference(end, start));
}

function getPeriod(anchorDate: string, view: CalendarView): CalendarPeriod {
  if (view === "day") {
    return {
      start: anchorDate,
      end: addDays(anchorDate, 1),
      label: `${formatDate(anchorDate)} ${formatWeekday(anchorDate, true)}`,
    };
  }

  if (view === "week") {
    const start = startOfWeek(anchorDate);
    const end = addDays(start, 7);
    return {
      start,
      end,
      label: `${formatShortDate(start)} – ${formatShortDate(addDays(end, -1))}`,
    };
  }

  const monthStart = startOfMonth(anchorDate);
  const nextMonth = addMonths(monthStart, 1);
  const start = startOfWeek(monthStart);
  const lastWeekStart = startOfWeek(addDays(nextMonth, -1));
  const end = addDays(lastWeekStart, 7);
  const monthDate = parseIso(monthStart);

  return {
    start,
    end,
    label: `${monthDate.getUTCFullYear()} 年 ${monthDate.getUTCMonth() + 1} 月`,
  };
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3 py-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-foreground">{value}</dd>
    </div>
  );
}

function PaymentDot({ status }: { status: PaymentStatus }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", PAYMENT_DOT_STYLES[status])}
      title={PAYMENT_LABELS[status]}
    />
  );
}

function BookingChip({
  booking,
  onSelect,
  compact = false,
  className,
}: {
  booking: CalendarBooking;
  onSelect: (booking: CalendarBooking) => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(booking)}
      className={cn(
        "group flex w-full min-w-0 items-center gap-1.5 rounded-md border text-left shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact ? "h-7 px-1.5 text-[11px]" : "min-h-9 px-2.5 py-1.5 text-xs",
        PLATFORM_STYLES[booking.platform] ?? PLATFORM_STYLES.other,
        className,
      )}
      title={`${booking.room_number}｜${booking.guest_name}｜${formatDate(booking.check_in)}–${formatDate(booking.check_out)}`}
    >
      <PaymentDot status={booking.payment_status} />
      <span className="shrink-0 font-semibold">{booking.room_number}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{booking.guest_name}</span>
    </button>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CalendarDays;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-xs">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className="mt-1 text-xl font-semibold tracking-tight text-foreground">{value}</p>
    </div>
  );
}

function MonthView({
  bookings,
  anchorDate,
  period,
  onSelectBooking,
  onSelectDay,
}: CalendarViewProps) {
  const today = localTodayIso();
  const days = dateRange(period.start, period.end);

  return (
    <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
      <div className="min-w-[980px]">
        <div className="grid grid-cols-7 border-b bg-muted/40">
          {WEEKDAY_LABELS.map((weekday, index) => (
            <div
              key={weekday}
              className={cn(
                "border-r px-3 py-2 text-center text-xs font-semibold text-muted-foreground last:border-r-0",
                (index === 0 || index === 6) && "bg-muted/45",
              )}
            >
              週{weekday}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {days.map((date) => {
            const dayBookings = bookings
              .filter((booking) => isOccupiedOn(booking, date))
              .sort((a, b) => a.room_number.localeCompare(b.room_number));
            const arrivals = bookings.filter((booking) => booking.check_in === date).length;
            const departures = bookings.filter((booking) => booking.check_out === date).length;
            const sameMonth = isSameMonth(date, anchorDate);
            const weekday = parseIso(date).getUTCDay();
            const isWeekend = weekday === 0 || weekday === 6;
            const isToday = date === today;
            const visibleBookings = dayBookings.slice(0, 4);

            return (
              <div
                key={date}
                className={cn(
                  "min-h-36 border-b border-r p-2 last:border-r-0",
                  isWeekend && "bg-muted/20",
                  !sameMonth && "bg-muted/35 text-muted-foreground",
                  isToday && "bg-primary/[0.035]",
                )}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectDay(date)}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full text-xs font-semibold hover:bg-accent",
                      isToday && "bg-primary text-primary-foreground hover:bg-primary/90",
                    )}
                  >
                    {parseIso(date).getUTCDate()}
                  </button>
                  {(arrivals > 0 || departures > 0) && (
                    <div className="flex gap-1 text-[10px] text-muted-foreground">
                      {arrivals > 0 && <span>入 {arrivals}</span>}
                      {departures > 0 && <span>退 {departures}</span>}
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  {visibleBookings.map((booking) => (
                    <BookingChip
                      key={`${date}-${booking.id}`}
                      booking={booking}
                      onSelect={onSelectBooking}
                      compact
                    />
                  ))}
                  {dayBookings.length > visibleBookings.length && (
                    <button
                      type="button"
                      onClick={() => onSelectDay(date)}
                      className="w-full rounded-md px-2 py-1 text-left text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      還有 {dayBookings.length - visibleBookings.length} 筆
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function WeekView({
  bookings,
  rooms,
  period,
  onSelectBooking,
  onSelectDay,
}: CalendarViewProps) {
  const days = dateRange(period.start, period.end);
  const today = localTodayIso();

  return (
    <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
      <div className="min-w-[1080px]">
        <div className="grid grid-cols-[88px_repeat(7,minmax(132px,1fr))] border-b bg-muted/40">
          <div className="flex items-center border-r px-3 py-3 text-xs font-semibold text-muted-foreground">
            房間
          </div>
          {days.map((date) => {
            const arrivals = bookings.filter((booking) => booking.check_in === date).length;
            const departures = bookings.filter((booking) => booking.check_out === date).length;
            const isToday = date === today;
            return (
              <button
                key={date}
                type="button"
                onClick={() => onSelectDay(date)}
                className={cn(
                  "border-r px-3 py-2 text-left last:border-r-0 hover:bg-accent/50",
                  isToday && "bg-primary/[0.06]",
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cn("text-sm font-semibold", isToday && "text-primary")}>
                    {formatShortDate(date)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {formatWeekday(date)}
                  </span>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  入 {arrivals} · 退 {departures}
                </div>
              </button>
            );
          })}
        </div>

        {rooms.map((room) => (
          <div
            key={room}
            className="grid min-h-20 grid-cols-[88px_repeat(7,minmax(132px,1fr))] border-b last:border-b-0"
          >
            <div className="sticky left-0 z-10 flex items-center border-r bg-card px-3 text-sm font-semibold">
              {room}
            </div>
            {days.map((date) => {
              const roomBookings = bookings.filter(
                (booking) => booking.room_number === room && isOccupiedOn(booking, date),
              );
              const isToday = date === today;

              return (
                <div
                  key={date}
                  className={cn(
                    "min-w-0 space-y-1 border-r p-1.5 last:border-r-0",
                    isToday && "bg-primary/[0.035]",
                  )}
                >
                  {roomBookings.map((booking) => (
                    <BookingChip
                      key={`${date}-${booking.id}`}
                      booking={booking}
                      onSelect={onSelectBooking}
                      className={cn(
                        booking.check_in === date && "rounded-l-lg border-l-4",
                        isLastNight(booking, date) && "rounded-r-lg",
                      )}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function OperationList({
  title,
  icon: Icon,
  bookings,
  emptyLabel,
  onSelectBooking,
}: {
  title: string;
  icon: typeof CalendarDays;
  bookings: CalendarBooking[];
  emptyLabel: string;
  onSelectBooking: (booking: CalendarBooking) => void;
}) {
  return (
    <section className="rounded-xl border bg-card shadow-xs">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">
          {bookings.length}
        </span>
      </div>
      <div className="space-y-2 p-3">
        {bookings.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          bookings.map((booking) => (
            <BookingChip
              key={`${title}-${booking.id}`}
              booking={booking}
              onSelect={onSelectBooking}
            />
          ))
        )}
      </div>
    </section>
  );
}

function DayView({
  bookings,
  rooms,
  anchorDate,
  onSelectBooking,
}: CalendarViewProps) {
  const arrivals = bookings
    .filter((booking) => booking.check_in === anchorDate)
    .sort((a, b) => a.room_number.localeCompare(b.room_number));
  const departures = bookings
    .filter((booking) => booking.check_out === anchorDate)
    .sort((a, b) => a.room_number.localeCompare(b.room_number));
  const staying = bookings
    .filter((booking) => isOccupiedOn(booking, anchorDate) && booking.check_in !== anchorDate)
    .sort((a, b) => a.room_number.localeCompare(b.room_number));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-3">
        <OperationList
          title="今日入住"
          icon={LogIn}
          bookings={arrivals}
          emptyLabel="今天沒有新入住"
          onSelectBooking={onSelectBooking}
        />
        <OperationList
          title="住宿中"
          icon={BedDouble}
          bookings={staying}
          emptyLabel="沒有續住中的客人"
          onSelectBooking={onSelectBooking}
        />
        <OperationList
          title="今日退房"
          icon={LogOut}
          bookings={departures}
          emptyLabel="今天沒有退房"
          onSelectBooking={onSelectBooking}
        />
      </div>

      <section className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">房間狀態</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              一眼查看每間房今天的入住、續住與翻房狀態。
            </p>
          </div>
          <span className="text-xs text-muted-foreground">{formatDate(anchorDate)}</span>
        </div>

        <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
          {rooms.map((room) => {
            const arriving = arrivals.filter((booking) => booking.room_number === room);
            const departing = departures.filter((booking) => booking.room_number === room);
            const active = bookings.filter(
              (booking) => booking.room_number === room && isOccupiedOn(booking, anchorDate),
            );
            const status =
              arriving.length > 0 && departing.length > 0
                ? "翻房"
                : arriving.length > 0
                  ? "今日入住"
                  : active.length > 0
                    ? "住宿中"
                    : departing.length > 0
                      ? "今日退房"
                      : "空房";
            const statusStyle =
              status === "空房"
                ? "bg-emerald-50 text-emerald-700"
                : status === "翻房"
                  ? "bg-amber-50 text-amber-800"
                  : "bg-slate-100 text-slate-700";
            const primaryBooking = active[0] ?? arriving[0] ?? departing[0];

            return (
              <div key={room} className="min-h-32 bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xl font-semibold tracking-tight">{room}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {primaryBooking ? primaryBooking.guest_name : "可接受新訂單"}
                    </p>
                  </div>
                  <span className={cn("rounded-full px-2 py-1 text-[11px] font-semibold", statusStyle)}>
                    {status}
                  </span>
                </div>

                <div className="mt-4 space-y-1 text-[11px] text-muted-foreground">
                  {departing.map((booking) => (
                    <button
                      key={`departure-${booking.id}`}
                      type="button"
                      onClick={() => onSelectBooking(booking)}
                      className="block max-w-full truncate text-left hover:text-foreground"
                    >
                      退房 · {booking.guest_name}
                    </button>
                  ))}
                  {arriving.map((booking) => (
                    <button
                      key={`arrival-${booking.id}`}
                      type="button"
                      onClick={() => onSelectBooking(booking)}
                      className="block max-w-full truncate text-left hover:text-foreground"
                    >
                      入住 · {booking.guest_name}
                    </button>
                  ))}
                  {departing.length === 0 && arriving.length === 0 && active.length > 0 && (
                    <button
                      type="button"
                      onClick={() => onSelectBooking(active[0])}
                      className="block max-w-full truncate text-left hover:text-foreground"
                    >
                      續住 · {active[0].guest_name}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function BookingCalendar() {
  const [view, setView] = useState<CalendarView>("month");
  const [anchorDate, setAnchorDate] = useState("2026-09-04");
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CalendarBooking | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);

  const period = useMemo(() => getPeriod(anchorDate, view), [anchorDate, view]);
  const metricPeriod = useMemo(() => {
    if (view !== "month") return period;
    const start = startOfMonth(anchorDate);
    return { start, end: addMonths(start, 1), label: period.label };
  }, [anchorDate, period, view]);

  useEffect(() => {
    let active = true;

    async function loadCalendar() {
      setLoading(true);
      setError(null);
      try {
        const response = await apiClient.get<CalendarResponse>(
          `/bookings/calendar?start=${period.start}&end=${period.end}`,
        );
        if (active) {
          setData(response);
          setLastLoadedAt(new Date());
        }
      } catch (requestError) {
        if (active) {
          setData(null);
          setError(
            requestError instanceof Error ? requestError.message : "無法讀取訂單日曆",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadCalendar();
    return () => {
      active = false;
    };
  }, [period.end, period.start, reloadKey]);

  const filteredBookings = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return data?.bookings ?? [];

    return (data?.bookings ?? []).filter((booking) =>
      [
        booking.guest_name,
        booking.room_number,
        booking.order_id,
        booking.external_order_no,
        PLATFORM_LABELS[booking.platform] ?? booking.platform,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized)),
    );
  }, [data, query]);

  const rooms = data?.rooms.length ? data.rooms : DEFAULT_ROOMS;
  const metrics = useMemo(() => {
    const metricBookings = filteredBookings.filter(
      (booking) => overlapNights(booking, metricPeriod) > 0,
    );
    const orderCount = new Set(
      metricBookings.map((booking) => booking.order_id ?? booking.sheet_row_id),
    ).size;
    const arrivals = metricBookings.filter(
      (booking) => booking.check_in >= metricPeriod.start && booking.check_in < metricPeriod.end,
    ).length;
    const departures = metricBookings.filter(
      (booking) => booking.check_out >= metricPeriod.start && booking.check_out < metricPeriod.end,
    ).length;
    const roomNights = metricBookings.reduce(
      (sum, booking) => sum + overlapNights(booking, metricPeriod),
      0,
    );
    const amount = metricBookings.reduce((sum, booking) => {
      const totalNights = Math.max(1, dayDifference(booking.check_out, booking.check_in));
      const visibleNights = overlapNights(booking, metricPeriod);
      return sum + Math.round((booking.room_rate * visibleNights) / totalNights);
    }, 0);

    return { orderCount, arrivals, departures, roomNights, amount };
  }, [filteredBookings, metricPeriod]);

  function navigate(direction: -1 | 1) {
    if (view === "month") {
      setAnchorDate((value) => addMonths(value, direction));
      return;
    }
    if (view === "week") {
      setAnchorDate((value) => addDays(value, direction * 7));
      return;
    }
    setAnchorDate((value) => addDays(value, direction));
  }

  function selectDay(date: string) {
    setAnchorDate(date);
    setView("day");
  }

  const viewProps: CalendarViewProps = {
    bookings: filteredBookings,
    rooms,
    anchorDate,
    period,
    onSelectBooking: setSelected,
    onSelectDay: selectDay,
  };

  return (
    <div className="space-y-4 pb-8">
      <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="flex flex-col gap-4 border-b px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-5">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                SF
              </span>
              Sweetfun Operations
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">訂單與房況日曆</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border bg-muted/40 p-1">
              {(Object.keys(VIEW_LABELS) as CalendarView[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setView(option)}
                  className={cn(
                    "min-w-14 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    view === option
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {VIEW_LABELS[option]}
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setReloadKey((value) => value + 1)}
              disabled={loading}
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
              <span className="sr-only">重新整理</span>
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-5">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => navigate(-1)}>
              <ChevronLeft />
              <span className="sr-only">上一個區間</span>
            </Button>
            <Button variant="outline" onClick={() => setAnchorDate(localTodayIso())}>
              今天
            </Button>
            <Button variant="outline" size="icon" onClick={() => navigate(1)}>
              <ChevronRight />
              <span className="sr-only">下一個區間</span>
            </Button>
            <div className="ml-1 min-w-44 text-base font-semibold">{period.label}</div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
                placeholder="搜尋客人、房號或訂單編號"
                className="bg-background pl-9"
              />
            </div>
            <span className="text-[11px] text-muted-foreground">
              {lastLoadedAt
                ? `${lastLoadedAt.toLocaleTimeString("zh-TW", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })} 更新`
                : "等待同步"}
            </span>
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard icon={CalendarDays} label="訂單" value={metrics.orderCount} />
        <MetricCard icon={LogIn} label="入住" value={metrics.arrivals} />
        <MetricCard icon={LogOut} label="退房" value={metrics.departures} />
        <MetricCard icon={DoorOpen} label="房晚" value={metrics.roomNights} />
        <MetricCard icon={CircleDollarSign} label="房費" value={formatMoney(metrics.amount)} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-2.5 text-xs text-muted-foreground shadow-xs">
        <span className="font-semibold text-foreground">圖例</span>
        {Object.entries(PLATFORM_LABELS).map(([platform, label]) => (
          <span key={platform} className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-2.5 rounded-sm border",
                PLATFORM_STYLES[platform] ?? PLATFORM_STYLES.other,
              )}
            />
            {label}
          </span>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-3">
          {(Object.keys(PAYMENT_LABELS) as PaymentStatus[]).map((status) => (
            <span key={status} className="flex items-center gap-1.5">
              <PaymentDot status={status} />
              {PAYMENT_LABELS[status]}
            </span>
          ))}
        </span>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 shrink-0" />
            <span>{error}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            <RefreshCw />
            重試
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-96 items-center justify-center gap-2 rounded-xl border bg-card text-sm text-muted-foreground shadow-sm">
          <LoaderCircle className="size-4 animate-spin" />
          讀取訂單與房況中
        </div>
      ) : (
        <>
          {view === "month" && <MonthView {...viewProps} />}
          {view === "week" && <WeekView {...viewProps} />}
          {view === "day" && <DayView {...viewProps} />}
        </>
      )}

      {!loading && !error && filteredBookings.length === 0 && (
        <div className="rounded-xl border border-dashed bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          這個區間沒有符合條件的訂單。
        </div>
      )}

      <Sheet
        open={selected !== null}
        onOpenChange={(open: boolean) => !open && setSelected(null)}
      >
        <SheetContent className="sm:max-w-md">
          <SheetHeader className="border-b">
            <div className="flex items-center gap-2">
              {selected && <PaymentDot status={selected.payment_status} />}
              <SheetTitle>{selected?.guest_name ?? "訂單資料"}</SheetTitle>
            </div>
            <SheetDescription>
              {selected
                ? `${selected.room_number} 房｜${formatDate(selected.check_in)}–${formatDate(selected.check_out)}`
                : ""}
            </SheetDescription>
          </SheetHeader>

          {selected && (
            <div className="overflow-y-auto px-4 pb-6">
              <div
                className={cn(
                  "mb-4 mt-4 rounded-lg border px-3 py-2 text-xs font-semibold",
                  PLATFORM_STYLES[selected.platform] ?? PLATFORM_STYLES.other,
                )}
              >
                {PLATFORM_LABELS[selected.platform] ?? selected.platform} · {PAYMENT_LABELS[selected.payment_status]}
              </div>
              <dl className="divide-y">
                <DetailRow label="入住" value={formatDate(selected.check_in)} />
                <DetailRow label="退房" value={formatDate(selected.check_out)} />
                <DetailRow
                  label="住宿晚數"
                  value={`${dayDifference(selected.check_out, selected.check_in)} 晚`}
                />
                <DetailRow label="房費" value={formatMoney(selected.room_rate)} />
                <DetailRow label="預訂日" value={formatDate(selected.booked_at)} />
                <DetailRow label="訂單編號" value={selected.order_id ?? "—"} />
                <DetailRow label="外部編號" value={selected.external_order_no ?? "—"} />
                <DetailRow label="備註" value={selected.notes || "—"} />
              </dl>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
