import { normalizeBusinessBooking, type BusinessBooking } from "./business-metrics.ts";

/** Read-only monthly projection. No booking IDs or private source evidence leave this module. */
export interface MonthlyBusinessMonth {
  year: number;
  month: number;
  confirmedRoomNights: number;
  paidRoomNights: number;
  zeroPriceRoomNights: number;
  unknownPriceRoomNights: number;
  bookingsWithStay: number;
  roomFeeCents: number;
  averagePaidNightFee: number | null;
  estimatedNetProfit: number;
  occupancyPct: number;
  capacityRoomNights: number;
  lyByToday: number | null;
  lyTotal: number | null;
  lyUnknownDateOrders: number;
  comparisonMode: "prior-month-total-estimate" | "prior-year-cutoff-estimate" | "history-unavailable";
  estimatedAllocationOrders: number;
  unpricedOrders: number;
}

export interface MonthlyBusinessReport {
  schemaVersion: 1;
  generatedAt: string;
  timezone: "Asia/Taipei";
  date: string;
  firstObservedStayDate: string | null;
  comparisonCutoff: string;
  countBasis: "confirmed-room-nights";
  moneyBasis: "existing-room-fee-approximation";
  netProfitRatio: number;
  months: MonthlyBusinessMonth[];
  warnings: string[];
}

const ymd = (value: Date) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
}).format(value);
const monthIndex = (year: number, month: number) => year * 12 + month - 1;
const parts = (index: number) => ({ year: Math.floor(index / 12), month: index % 12 + 1 });
const dayOf = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const monthDays = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const invalid = (): never => { throw new Error("Monthly business metrics source data is invalid"); };

/** Gregorian calendar anniversary, clamped for February 29 rather than rolling into March. */
export function priorYearDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) invalid();
  return dayOf(year - 1, month, Math.min(date, monthDays(year - 1, month)));
}

type Normalized = ReturnType<typeof normalizeBusinessBooking>;
type Bucket = {
  ids: Set<string>;
  orders: Map<string, Normalized>;
  nights: { order: Normalized; room: string; date: string; cents: number }[];
};
const newBucket = (): Bucket => ({ ids: new Set(), orders: new Map(), nights: [] });

/**
 * Owner-approved approximation (2026-10-24): use present confirmed records;
 * do not reconstruct historical cancellation/amendment states. Original booking
 * date is preferred for last-year pace, with verified first notification as a
 * labeled fallback. Missing dates exclude only those orders from the cutoff.
 * Existing fee amounts are used as room fees; no extra-fee/payment ledger is added.
 */
export function computeMonthlyBusinessMetrics(
  input: readonly BusinessBooking[],
  options: { now?: Date; roomCount: number; netProfitRatio?: number; monthsAhead?: number },
): MonthlyBusinessReport {
  const now = options.now ?? new Date();
  const ratio = options.netProfitRatio ?? 0.68;
  const ahead = options.monthsAhead ?? 6;
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(options.roomCount) || options.roomCount < 1 ||
      !Number.isFinite(ratio) || ratio < 0 || ratio > 1 || !Number.isSafeInteger(ahead) || ahead < 0 || ahead > 24) invalid();
  const today = ymd(now);
  const [year, month] = today.split("-").map(Number);
  const current = monthIndex(year, month);
  const cutoff = priorYearDay(today);
  const canonical = new Map<string, BusinessBooking>();
  for (const booking of input) {
    if (!booking.id?.trim()) invalid();
    const key = booking.id.trim();
    const previous = canonical.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(booking)) invalid();
    canonical.set(key, booking);
  }

  const buckets = new Map<number, Bucket>();
  let firstDate: string | null = null;
  // Include cancelled/held records only in the observed history boundary. A later
  // cancellation must not make the beginning of imported history move forward.
  for (const booking of canonical.values()) {
    for (const stay of booking.stays) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(stay.checkIn) &&
          Number.isFinite(Date.parse(`${stay.checkIn}T00:00:00Z`)) &&
          (firstDate === null || stay.checkIn < firstDate)) firstDate = stay.checkIn;
    }
    if (booking.status !== "confirmed") continue;
    const order = normalizeBusinessBooking(booking);
    for (const night of order.nights) {
      const [y, m] = night.date.split("-").map(Number);
      const index = monthIndex(y, m);
      const bucket = buckets.get(index) ?? newBucket();
      bucket.ids.add(order.id);
      bucket.orders.set(order.id, order);
      bucket.nights.push({ order, ...night });
      buckets.set(index, bucket);
    }
  }
  const firstIndex = firstDate === null ? current : monthIndex(Number(firstDate.slice(0, 4)), Number(firstDate.slice(5, 7)));
  // Bound work even if malformed historical years somehow entered the source.
  const start = Math.min(firstIndex, current);
  if (start < monthIndex(2000, 1) || current + ahead - start > 1200) invalid();
  const months: MonthlyBusinessMonth[] = [];
  for (let index = start; index <= current + ahead; index++) {
    const { year: y, month: m } = parts(index);
    const bucket = buckets.get(index) ?? newBucket();
    const prior = buckets.get(index - 12) ?? newBucket();
    const past = index < current;
    const historyAvailable = firstDate !== null && index - 12 >= firstIndex && index - 12 <= current;
    const priced = bucket.nights.filter((night) => night.order.amountKnown);
    const paid = priced.filter((night) => night.cents > 0);
    const cents = priced.reduce((sum, night) => sum + night.cents, 0);
    if (!Number.isSafeInteger(cents)) invalid();
    // Count room-nights, not overlapping rows. True active collisions remain
    // visible as an invalid report rather than producing occupancy above 100%.
    const cells = new Set(bucket.nights.map((night) => `${night.room}|${night.date}`));
    if (cells.size !== bucket.nights.length) invalid();
    const capacity = monthDays(y, m) * options.roomCount;
    if (cells.size > capacity) invalid();
    const priorByCutoff = prior.nights.filter(({ order }) => {
      const day = order.bookedOn ?? order.countedOn;
      return past || (day !== null && day <= cutoff);
    }).length;
    months.push({
      year: y, month: m,
      confirmedRoomNights: cells.size,
      paidRoomNights: paid.length,
      zeroPriceRoomNights: priced.length - paid.length,
      unknownPriceRoomNights: bucket.nights.length - priced.length,
      bookingsWithStay: bucket.ids.size,
      roomFeeCents: cents,
      averagePaidNightFee: paid.length > 0 ? Math.round(cents / paid.length / 100) : null,
      estimatedNetProfit: Math.round(cents / 100 * ratio),
      occupancyPct: Math.round(cells.size / capacity * 1000) / 10,
      capacityRoomNights: capacity,
      lyByToday: historyAvailable ? priorByCutoff : null,
      lyTotal: historyAvailable ? prior.nights.length : null,
      lyUnknownDateOrders: !past && historyAvailable ? [...prior.orders.values()]
        .filter((order) => (order.bookedOn ?? order.countedOn) === null).length : 0,
      comparisonMode: !historyAvailable ? "history-unavailable" : past ? "prior-month-total-estimate" : "prior-year-cutoff-estimate",
      estimatedAllocationOrders: [...bucket.orders.values()].filter((order) => order.estimatedNightRevenue).length,
      unpricedOrders: [...bucket.orders.values()].filter((order) => !order.amountKnown).length,
    });
  }
  return {
    schemaVersion: 1, generatedAt: now.toISOString(), timezone: "Asia/Taipei", date: today,
    firstObservedStayDate: firstDate, comparisonCutoff: cutoff,
    countBasis: "confirmed-room-nights", moneyBasis: "existing-room-fee-approximation",
    netProfitRatio: ratio, months,
    warnings: [
      "去年同期為現有訂單與下訂日期的估算，未還原當時取消或改期狀態；缺原下訂日者採已驗證首次通知日。",
      "房費沿用現有訂單金額估算，不另計寵物、加購或清潔費；未拆分的既有金額不另猜測扣除。估算淨利不等於實際利潤。",
      ...(firstDate ? [`Iron Gate 現有住宿歷史最早為 ${firstDate}；更早歷史尚未匯入，未當成零訂單。`] : ["尚無可用住宿歷史，去年同期不計算。"]),
    ],
  };
}
