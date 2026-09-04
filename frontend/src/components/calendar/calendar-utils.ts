import type {
  CalendarBooking,
  CalendarPeriod,
  CalendarProperty,
  CalendarView,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from "./calendar-types";

export const DAY_MS = 86_400_000;
export const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
export const VIEW_LABELS: Record<CalendarView, string> = {
  month: "月",
  week: "週",
  day: "日",
};

export const PLATFORM_LABELS: Record<string, string> = {
  direct: "LINE／直訂",
  agoda: "Agoda",
  booking: "Booking",
  airbnb: "Airbnb",
  ctrip: "CTrip",
  owljourney: "OwlJourney",
  other: "其他",
};

export const PLATFORM_STYLES: Record<string, string> = {
  direct: "border-emerald-200 bg-emerald-50 text-emerald-950 hover:bg-emerald-100",
  agoda: "border-violet-200 bg-violet-50 text-violet-950 hover:bg-violet-100",
  booking: "border-sky-200 bg-sky-50 text-sky-950 hover:bg-sky-100",
  airbnb: "border-rose-200 bg-rose-50 text-rose-950 hover:bg-rose-100",
  ctrip: "border-amber-200 bg-amber-50 text-amber-950 hover:bg-amber-100",
  owljourney: "border-indigo-200 bg-indigo-50 text-indigo-950 hover:bg-indigo-100",
  other: "border-slate-200 bg-slate-50 text-slate-950 hover:bg-slate-100",
};

export const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  paid: "已付清",
  deposit: "已付訂金",
  unpaid: "未付款",
};

export const PAYMENT_DOT_STYLES: Record<PaymentStatus, string> = {
  paid: "bg-emerald-500",
  deposit: "bg-amber-500",
  unpaid: "bg-rose-500",
};

export const PROPERTY_DOT_STYLES: Record<CalendarProperty["color"], string> = {
  emerald: "bg-emerald-500",
  violet: "bg-violet-500",
  amber: "bg-amber-500",
  sky: "bg-sky-500",
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "現金",
  bank_transfer: "匯款",
  credit_card: "信用卡",
};

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  deposit: "訂金",
  balance: "尾款",
  other: "其他款項",
};

export function parseIso(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function toIso(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function localTodayIso() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
    today.getDate(),
  ).padStart(2, "0")}`;
}

export function addDays(value: string, amount: number) {
  const date = parseIso(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return toIso(date);
}

export function addMonths(value: string, amount: number) {
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

export function startOfWeek(value: string) {
  const date = parseIso(value);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayOffset);
  return toIso(date);
}

export function startOfMonth(value: string) {
  const date = parseIso(value);
  date.setUTCDate(1);
  return toIso(date);
}

export function dayDifference(value: string, origin: string) {
  return Math.round((parseIso(value).getTime() - parseIso(origin).getTime()) / DAY_MS);
}

export function dateRange(start: string, end: string) {
  return Array.from({ length: Math.max(0, dayDifference(end, start)) }, (_, index) =>
    addDays(start, index),
  );
}

export function monthStarts(start: string, count: number) {
  return Array.from({ length: count }, (_, index) => addMonths(startOfMonth(start), index));
}

export function monthCalendarPeriod(monthStart: string): CalendarPeriod {
  const nextMonth = addMonths(monthStart, 1);
  const calendarStart = startOfWeek(monthStart);
  const lastWeekStart = startOfWeek(addDays(nextMonth, -1));
  const calendarEnd = addDays(lastWeekStart, 7);
  return {
    start: calendarStart,
    end: calendarEnd,
    label: formatMonthLabel(monthStart),
  };
}

export function currentPeriod(anchorDate: string, view: CalendarView): CalendarPeriod {
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

  return monthCalendarPeriod(startOfMonth(anchorDate));
}

export function fetchPeriod(anchorDate: string, view: CalendarView): CalendarPeriod {
  if (view === "month") {
    return {
      start: "2025-01-01",
      end: "2028-01-01",
      label: "2025–2027",
    };
  }

  if (view === "week") {
    const start = addDays(startOfWeek(anchorDate), -7);
    return { start, end: addDays(start, 21), label: "three-week-window" };
  }

  return {
    start: anchorDate,
    end: addDays(anchorDate, 1),
    label: "single-day-window",
  };
}

export function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(parseIso(value));
}

export function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(parseIso(value));
}

export function formatWeekday(value: string, long = false) {
  return new Intl.DateTimeFormat("zh-TW", {
    weekday: long ? "long" : "short",
    timeZone: "UTC",
  }).format(parseIso(value));
}

export function formatMonthLabel(value: string) {
  const date = parseIso(value);
  return `${date.getUTCFullYear()} 年 ${date.getUTCMonth() + 1} 月`;
}

export function formatMoney(value: number) {
  return new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: "TWD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function isSameMonth(value: string, anchorDate: string) {
  const date = parseIso(value);
  const anchor = parseIso(anchorDate);
  return (
    date.getUTCFullYear() === anchor.getUTCFullYear() &&
    date.getUTCMonth() === anchor.getUTCMonth()
  );
}

export function isOccupiedOn(booking: CalendarBooking, date: string) {
  return booking.check_in <= date && booking.check_out > date;
}

export function overlapNights(booking: CalendarBooking, period: CalendarPeriod) {
  const start = booking.check_in > period.start ? booking.check_in : period.start;
  const end = booking.check_out < period.end ? booking.check_out : period.end;
  return Math.max(0, dayDifference(end, start));
}

export function roomKey(propertyId: string, roomNumber: string) {
  return `${propertyId}:${roomNumber}`;
}
