import type { NightGrid, OrderRow, PulseData, PulseAction } from "./pulse-types.ts";

/** Canonical bookings, already restricted to one property and TWD by the reader. */
export interface BusinessBooking {
  id: string;
  status: string;
  bookedAt: string | null;
  /** Verified immutable first new-order notification time; never an import or update time. */
  firstNotificationAt?: string | null;
  platform: string;
  totalCents: number | null;
  paid: boolean;
  guestName?: string;
  stays: BusinessStay[];
}

export interface BusinessStay {
  room: string;
  checkIn: string;
  checkOut: string;
  /** Optional allocation to this room stay; never the total for every room. */
  amountCents?: number;
}

export interface BusinessMetricsOptions {
  now?: Date;
  source?: string;
  sourceUpdatedAt?: string | null;
  rooms?: readonly string[];
  propertyName?: string;
  /** Trusted start of complete notification capture, never inferred from observed orders. */
  notificationCoverageFrom?: string | null;
}

type DailyPoint = { date: string; orders: number; amount: number };

export type BusinessPulseData = Omit<PulseData, "last7" | "meta"> & {
  last7: PulseData["last7"] & { daily30: DailyPoint[] };
  meta: PulseData["meta"] & {
    source: string;
    sourceUpdatedAt: string | null;
    currency: "TWD";
    orderCountBasis: "canonical-booking";
    dailyOrderDateBasis: "new-order-notification";
    notificationDateOrders: number;
    bookingDateFallbackOrders: number;
    unknownDailyDateOrders: number;
    dailyComparisonComparable: boolean;
    notificationCoverageFrom: string | null;
    unknownBookingDateOrders: number;
    unknownBookingDateAmount: number;
    unpricedBookings: number;
    excludedUnconfirmedOrders: number;
    duplicateBookingRecords: number;
    estimatedNightRevenueOrders: number;
    warnings: string[];
  };
};

const DAY_MS = 86_400_000;
const DEFAULT_ROOMS = ["101", "102", "201", "202", "301", "302"];
const NEUTRAL_GUEST_LABEL = "旅客";

type NightAllocation = { room: string; date: string; cents: number };
type NormalizedStay = {
  room: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  cents: number;
};
type NormalizedBooking = {
  id: string;
  bookedOn: string | null;
  countedOn: string | null;
  dateBasis: "notification" | "booking-date" | "unknown";
  platform: string;
  cents: number;
  amountKnown: boolean;
  paid: boolean;
  guestName: string;
  nights: NightAllocation[];
  stays: NormalizedStay[];
  checkIn: string;
  checkOut: string;
  estimatedNightRevenue: boolean;
};

/** Reject invalid amounts/dates rather than presenting malformed input as zero sales. */
function invalidInput(): never {
  throw new Error("Business metrics source data is invalid");
}

function validDay(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dayTime(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function addDays(day: string, days: number): string {
  return new Date(dayTime(day) + days * DAY_MS).toISOString().slice(0, 10);
}

function taipeiDay(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((value) => value.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Missing/unverified dates stay unknown. Import/creation timestamps are not substitutes. */
function bookedDay(value: string | null): string | null {
  if (validDay(value)) return value;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  if (!validDay(value.slice(0, 10))) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? taipeiDay(date) : null;
}

function validCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sumCents(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!validCents(total)) invalidInput();
  return total;
}

function platformName(value: string): string {
  const name = value?.trim() || "其他";
  const names: Record<string, string> = {
    booking: "Booking", "booking.com": "Booking", agoda: "Agoda", airbnb: "Airbnb",
    ctrip: "Ctrip", "trip.com": "Ctrip", line: "LINE", owljourney: "奧丁丁", owlnest: "奧丁丁",
  };
  return names[name.toLowerCase()] ?? name;
}

/** Stable cent remainders keep allocated totals equal to the full booking amount. */
function allocate(cents: number, count: number, index: number): number {
  return Math.floor(cents / count) + (index < cents % count ? 1 : 0);
}

export function normalizeBusinessBooking(input: BusinessBooking): NormalizedBooking {
  if (!input.id?.trim() || (input.totalCents !== null && !validCents(input.totalCents)) || !Array.isArray(input.stays) || input.stays.length === 0) invalidInput();
  const amountKnown = input.totalCents !== null;
  const totalCents = input.totalCents ?? 0;
  const unique = new Map<string, BusinessStay>();
  for (const stay of input.stays) {
    const room = stay.room?.trim();
    if (!room || !validDay(stay.checkIn) || !validDay(stay.checkOut) || stay.checkOut <= stay.checkIn) invalidInput();
    const nights = (dayTime(stay.checkOut) - dayTime(stay.checkIn)) / DAY_MS;
    if (!Number.isSafeInteger(nights) || nights > 3660) invalidInput();
    if (stay.amountCents !== undefined && !validCents(stay.amountCents)) invalidInput();
    const key = `${room}|${stay.checkIn}|${stay.checkOut}`;
    const existing = unique.get(key);
    const amountCents = amountKnown ? stay.amountCents : undefined;
    if (existing && existing.amountCents !== amountCents) invalidInput();
    unique.set(key, { ...stay, room, amountCents });
  }
  const stays = [...unique.values()].sort((a, b) => a.room.localeCompare(b.room) || a.checkIn.localeCompare(b.checkIn));
  const allocated = sumCents(stays.map((stay) => stay.amountCents ?? 0));
  const missingNights = stays.reduce((sum, stay) => sum + (stay.amountCents === undefined ? (dayTime(stay.checkOut) - dayTime(stay.checkIn)) / DAY_MS : 0), 0);
  if (allocated > totalCents || (missingNights === 0 && allocated !== totalCents)) invalidInput();
  const remainder = totalCents - allocated;
  const seenNights = new Set<string>();
  const nights: NightAllocation[] = [];
  let missingIndex = 0;
  for (const stay of stays) {
    const count = (dayTime(stay.checkOut) - dayTime(stay.checkIn)) / DAY_MS;
    for (let index = 0; index < count; index++) {
      const date = addDays(stay.checkIn, index);
      const key = `${stay.room}|${date}`;
      // Overlapping segments of one booking are ambiguous, never silently double-count.
      if (seenNights.has(key)) invalidInput();
      seenNights.add(key);
      const cents = stay.amountCents === undefined
        ? allocate(remainder, missingNights, missingIndex++)
        : allocate(stay.amountCents, count, index);
      nights.push({ room: stay.room, date, cents });
    }
  }

  // Adjacent room segments form one stay: continuation nights are not new arrivals.
  const merged: NormalizedStay[] = [];
  for (const night of nights.sort((a, b) => a.room.localeCompare(b.room) || a.date.localeCompare(b.date))) {
    const last = merged.at(-1);
    if (last?.room === night.room && last.checkOut === night.date) {
      last.checkOut = addDays(night.date, 1);
      last.nights++;
      last.cents += night.cents;
    } else {
      merged.push({ room: night.room, checkIn: night.date, checkOut: addDays(night.date, 1), nights: 1, cents: night.cents });
    }
  }
  const bookedOn = bookedDay(input.bookedAt);
  const notificationOn = input.firstNotificationAt == null ? null : bookedDay(input.firstNotificationAt);
  if (input.firstNotificationAt != null && (!input.firstNotificationAt.includes("T") || notificationOn === null)) invalidInput();
  return {
    id: input.id.trim(), bookedOn, countedOn: notificationOn ?? bookedOn,
    dateBasis: notificationOn ? "notification" : bookedOn ? "booking-date" : "unknown",
    platform: platformName(input.platform),
    cents: totalCents, amountKnown, paid: input.paid === true,
    guestName: input.guestName?.trim() || NEUTRAL_GUEST_LABEL,
    nights, stays: merged,
    checkIn: merged.reduce((first, stay) => stay.checkIn < first ? stay.checkIn : first, merged[0].checkIn),
    checkOut: merged.reduce((last, stay) => stay.checkOut > last ? stay.checkOut : last, merged[0].checkOut),
    estimatedNightRevenue: amountKnown && stays.some((stay) => stay.amountCents === undefined || addDays(stay.checkIn, 1) !== stay.checkOut),
  };
}

function stats(orders: readonly NormalizedBooking[]) {
  return {
    orders: orders.length,
    nights: orders.reduce((sum, order) => sum + order.nights.length, 0),
    amount: sumCents(orders.map((order) => order.cents)) / 100,
  };
}

function platformCounts(orders: readonly NormalizedBooking[]) {
  const counts = new Map<string, number>();
  for (const order of orders) counts.set(order.platform, (counts.get(order.platform) ?? 0) + 1);
  return [...counts].map(([name, orders]) => ({ name, orders })).sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name));
}

function leadDays(order: NormalizedBooking): number | null {
  return order.bookedOn ? (dayTime(order.checkIn) - dayTime(order.bookedOn)) / DAY_MS : null;
}

function detail(order: NormalizedBooking): OrderRow {
  return {
    bookingDate: order.bookedOn, countedDate: order.countedOn, dateBasis: order.dateBasis, platform: order.platform,
    room: [...new Set(order.nights.map((night) => night.room))].join("、"),
    guestName: order.guestName, checkIn: order.checkIn, nights: order.nights.length,
    leadDays: leadDays(order), amount: order.cents / 100,
  };
}

/**
 * All statistics derive from canonical bookings, not spreadsheet rows.
 * The reader must fetch all confirmed bookings (including far-future stays), not
 * a stay-date-only calendar window. This function makes no network calls.
 */
export function computeBusinessMetrics(
  input: readonly BusinessBooking[], options: BusinessMetricsOptions = {},
): BusinessPulseData {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) invalidInput();
  const today = taipeiDay(now);
  const yesterday = addDays(today, -1);
  const last7From = addDays(today, -7);
  const prev7From = addDays(today, -14);
  const prev7To = addDays(today, -8);
  const notificationCoverageFrom = options.notificationCoverageFrom ?? null;
  if (notificationCoverageFrom !== null && !validDay(notificationCoverageFrom)) invalidInput();
  const notificationHistoryComplete = notificationCoverageFrom !== null && notificationCoverageFrom <= prev7From;
  const generatedAt = now.toISOString();
  const asOf = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const canonical = new Map<string, BusinessBooking>();
  let duplicateBookingRecords = 0;
  for (const booking of input) {
    if (!booking.id?.trim()) invalidInput();
    const key = booking.id.trim();
    const previous = canonical.get(key);
    if (previous) {
      // An inconsistent duplicate may represent a cancellation/change mid-pagination.
      // Fail closed instead of choosing an arbitrary older version of the booking.
      if (JSON.stringify(previous) !== JSON.stringify(booking)) invalidInput();
      duplicateBookingRecords++;
    } else canonical.set(key, booking);
  }
  const confirmed = [...canonical.values()].filter((booking) => booking.status === "confirmed");
  const orders = confirmed.map(normalizeBusinessBooking);
  const unknown = orders.filter((order) => order.bookedOn === null);
  const unknownDaily = orders.filter((order) => order.countedOn === null);
  const notificationDateOrders = orders.filter((order) => order.dateBasis === "notification").length;
  const bookingDateFallbackOrders = orders.filter((order) => order.dateBasis === "booking-date").length;
  const unpriced = orders.filter((order) => !order.amountKnown);
  const between = (from: string, to: string) => orders.filter((order) => order.countedOn !== null && order.countedOn >= from && order.countedOn <= to);
  const bookedYesterday = between(yesterday, yesterday);
  const bookedToday = between(today, today);
  const bookedLast7 = between(last7From, yesterday);
  const bookedPrev7 = between(prev7From, prev7To);
  const mixedDateBases = new Set([...bookedLast7, ...bookedPrev7].map((order) => order.dateBasis)).size > 1;
  const dailyComparisonComparable = notificationHistoryComplete && unknownDaily.length === 0 && unpriced.length === 0 && !mixedDateBases;
  const yesterdayStats = stats(bookedYesterday);
  const todayStats = stats(bookedToday);
  const last7Stats = stats(bookedLast7);
  const prev7Stats = stats(bookedPrev7);
  const rooms = [...new Set([...(options.rooms ?? DEFAULT_ROOMS), ...orders.flatMap((order) => order.nights.map((night) => night.room))])];
  const allNights = orders.flatMap((order) => order.nights);
  const occupiedKeys = new Set(allNights.map((night) => `${night.room}|${night.date}`));
  const occupied = (date: string) => rooms.filter((room) => occupiedKeys.has(`${room}|${date}`));
  const grid = (start: string): NightGrid => {
    const dates = Array.from({ length: 7 }, (_, index) => addDays(start, index));
    const roomRows = rooms.map((room) => ({ room, nights: dates.map((date) => occupiedKeys.has(`${room}|${date}`)) }));
    return { dates, rooms: roomRows, totals: dates.map((_, index) => roomRows.filter((row) => row.nights[index]).length), capacity: rooms.length };
  };
  const recent7Nights = grid(addDays(today, -6));
  const next7Nights = grid(addDays(today, 1));
  const occupiedTonight = occupied(today);
  const available = rooms.filter((room) => !occupiedTonight.includes(room));
  const lastNightRooms = occupied(yesterday);
  const lastNightRevenue = sumCents(allNights.filter((night) => night.date === yesterday).map((night) => night.cents)) / 100;
  const daily30 = Array.from({ length: 30 }, (_, index) => {
    const date = addDays(today, index - 30);
    const summary = stats(between(date, date));
    return { date, orders: summary.orders, amount: summary.amount };
  });
  const platforms = platformCounts(bookedLast7).map(({ name }) => {
    const current = stats(bookedLast7.filter((order) => order.platform === name));
    const prior = stats(bookedPrev7.filter((order) => order.platform === name));
    const sharePct = last7Stats.amount > 0 ? current.amount / last7Stats.amount * 100 : 0;
    const prevSharePct = prev7Stats.amount > 0 ? prior.amount / prev7Stats.amount * 100 : null;
    return { name, ...current, sharePct, prevSharePct, deltaPp: !dailyComparisonComparable || prevSharePct === null ? null : sharePct - prevSharePct };
  }).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const soldNights = bookedLast7.flatMap((order) => order.nights);
  const roomsSold = rooms.map((room) => {
    const nights = soldNights.filter((night) => night.room === room);
    return { room, nights: nights.length, amount: sumCents(nights.map((night) => night.cents)) / 100 };
  }).sort((a, b) => b.nights - a.nights || b.amount - a.amount || a.room.localeCompare(b.room));
  const leads = bookedLast7.map(leadDays).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const middle = Math.floor(leads.length / 2);
  const leadTimeMedianDays = leads.length === 0 ? null : leads.length % 2 ? leads[middle] : Math.floor((leads[middle - 1] + leads[middle]) / 2);
  const checkIns = orders.flatMap((order) => order.stays.filter((stay) => stay.checkIn === today).map((stay) => ({
    room: stay.room, guestName: order.guestName, platform: order.platform, checkOut: stay.checkOut,
    nights: stay.nights, paid: order.paid, amount: stay.cents / 100,
  }))).sort((a, b) => a.room.localeCompare(b.room));
  const checkOutsCount = orders.reduce((sum, order) => sum + order.stays.filter((stay) => stay.checkOut === today).length, 0);
  const amountDelta = (sumCents(bookedLast7.map((order) => order.cents)) - sumCents(bookedPrev7.map((order) => order.cents))) / 100;
  const amountDeltaPct = dailyComparisonComparable && prev7Stats.amount > 0 ? amountDelta / prev7Stats.amount * 100 : null;
  const money = (amount: number) => `NT$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const basis = `近 7 天有效訂單 ${last7Stats.orders} 筆、${money(last7Stats.amount)}；前 7 天 ${prev7Stats.orders} 筆、${money(prev7Stats.amount)}。新來源依首次新單通知日，歷史及其他來源依原下訂日。`;
  let verdict: PulseData["verdict"];
  if (unknownDaily.length > 0 || unpriced.length > 0) {
    const missing = [unknownDaily.length > 0 ? `${unknownDaily.length} 筆缺統計日期` : "", unpriced.length > 0 ? `${unpriced.length} 筆缺訂房金額` : ""].filter(Boolean).join("、");
    verdict = { level: "flat", headline: `${missing}，接單統計尚未完整`, basis: `${basis}接單依已知統計日期計算，金額僅加總已知部分；房況仍包含全部有效訂單。` };
  } else if (mixedDateBases) {
    verdict = { level: "flat", headline: "新單通知日與原下訂日混合，暫不判斷增減", basis };
  } else if (!notificationHistoryComplete) {
    verdict = { level: "flat", headline: "通知日資料尚未涵蓋兩個完整 7 天區間，暫不判斷增減", basis };
  } else if (last7Stats.orders === 0 && prev7Stats.orders === 0) {
    verdict = { level: "quiet", headline: "最近 14 天沒有新訂單", basis };
  } else if (prev7Stats.amount === 0 && last7Stats.amount > 0) {
    verdict = { level: "up", headline: `近 7 天接單 ${last7Stats.orders} 筆、${money(last7Stats.amount)}`, basis };
  } else {
    const percent = Math.round(amountDeltaPct ?? 0);
    verdict = {
      level: percent >= 15 ? "up" : percent <= -15 ? "down" : "flat",
      headline: `近 7 天接單金額較前 7 天${percent > 0 ? "增加" : percent < 0 ? "減少" : "持平"}${percent === 0 ? "" : ` ${Math.abs(percent)}%`}`,
      basis,
    };
  }
  const warnings: string[] = [];
  const estimatedNightRevenueOrders = orders.filter((order) => order.estimatedNightRevenue).length;
  if (unknownDaily.length > 0) warnings.push(`${unknownDaily.length} 筆訂單缺少可驗證的新單通知日或原下訂日，未納入每日接單統計。`);
  if (unknown.length > 0) warnings.push(`${unknown.length} 筆訂單未提供原下訂日期，不納入下訂提前天數；已有新單通知日的訂單仍納入每日統計。`);
  if (bookingDateFallbackOrders > 0) warnings.push(`${bookingDateFallbackOrders} 筆歷史或其他來源訂單沿用原下訂日，未當作新單通知日。`);
  if (mixedDateBases) warnings.push("近兩個 7 天區間含不同日期依據，暫不比較訂單與金額增減。");
  if (!notificationHistoryComplete) warnings.push(notificationCoverageFrom
    ? `新單通知資料自 ${notificationCoverageFrom} 起涵蓋完整日；尚未累積兩個完整 7 天區間，暫不比較增減。`
    : "新單通知資料的完整涵蓋起日尚未確認，暫不比較增減；已知日期的訂單仍正常統計。");
  if (unpriced.length > 0) warnings.push(`${unpriced.length} 筆訂單缺訂房金額，仍計入訂單與房晚，金額僅加總已知部分。`);
  if (estimatedNightRevenueOrders > 0) warnings.push("部分訂單未提供逐房晚金額，房晚營收依住宿晚數分攤；訂單總額不變。");
  const actions: PulseAction[] = unknownDaily.length > 0 ? [{ level: "watch", title: "確認訂單統計日期", evidence: warnings[0] }] : [];
  if (unpriced.length > 0) actions.push({ level: "watch", title: "補齊訂房金額", evidence: `${unpriced.length} 筆有效訂單尚未有可驗證金額。` });
  if (available.length > 0) actions.push({ level: "watch", title: `今晚有 ${available.length} 間未有確認訂單`, evidence: `未有確認訂單的房間：${available.join("、")}；可售狀態仍以訂房系統為準。` });
  if (actions.length === 0) actions.push({ level: "ok", title: "今晚所有房間都有確認訂單", evidence: `${occupiedTonight.length} 間房皆已有確認訂單。` });
  const propertyName = options.propertyName ?? "水芳";

  return {
    generatedAt, timezone: "Asia/Taipei",
    yesterday: {
      date: yesterday, ...yesterdayStats, platforms: platformCounts(bookedYesterday),
      soldRooms: [...new Set(bookedYesterday.flatMap((order) => order.nights.map((night) => night.room)))].sort(),
      lastNight: { occupied: lastNightRooms, count: lastNightRooms.length, revenue: lastNightRevenue },
      detail: bookedYesterday.map(detail),
    },
    today: {
      date: today, asOf, ...todayStats, platforms: platformCounts(bookedToday), checkIns,
      // This analytics feed carries no legacy review identifiers. Never invent them.
      checkOuts: [], checkOutsCount,
      tonight: { occupied: occupiedTonight, count: occupiedTonight.length, available },
    },
    last7: {
      from: last7From, to: yesterday, ...last7Stats,
      vsPrev7: { ordersDelta: last7Stats.orders - prev7Stats.orders, amountDelta, amountDeltaPct },
      platforms, roomsSold, daily14: daily30.slice(-14), daily30, leadTimeMedianDays,
      detail: between(last7From, today).sort((a, b) => (b.countedOn ?? "").localeCompare(a.countedOn ?? "") || a.checkIn.localeCompare(b.checkIn)).map(detail),
    },
    upcoming: stats(orders.filter((order) => order.checkIn > today)),
    grids: { recent7Nights, next7Nights }, verdict, actions,
    summaryText: [
      `【${propertyName}晨報 ${today}】`,
      `昨天新進 ${yesterdayStats.orders} 筆訂單、${yesterdayStats.nights} 房晚、${money(yesterdayStats.amount)}。`,
      `今天已接單 ${todayStats.orders} 筆、${money(todayStats.amount)}（截至 ${asOf}）。`,
      `今晚已訂 ${occupiedTonight.length}/${rooms.length} 間，今日入住 ${checkIns.length} 間、退房 ${checkOutsCount} 間。`,
      basis, ...warnings,
    ].join("\n"),
    meta: {
      orderCount: orders.length, generatedAt, source: options.source ?? "iron-gate",
      sourceUpdatedAt: options.sourceUpdatedAt ?? null, currency: "TWD", orderCountBasis: "canonical-booking",
      dailyOrderDateBasis: "new-order-notification", notificationDateOrders, bookingDateFallbackOrders,
      unknownDailyDateOrders: unknownDaily.length, dailyComparisonComparable,
      notificationCoverageFrom,
      unknownBookingDateOrders: unknown.length, unknownBookingDateAmount: stats(unknown).amount,
      unpricedBookings: unpriced.length,
      excludedUnconfirmedOrders: canonical.size - confirmed.length, duplicateBookingRecords,
      estimatedNightRevenueOrders, warnings,
    },
  };
}
