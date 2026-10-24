// 晨報 payload 型別 — 抄自 sweetfun-web src/lib/dashboard-pulse-utils.ts（PR #16 版）。
// 上游 interface 變動時要同步這裡（來源是唯一權威）。

export interface PulseOrder {
  orderId: string;
  room: string;
  guestName: string;
  platform: string;
  checkIn: Date;
  checkOut: Date;
  bookingDate: Date | null;
  amount: number;
  paymentStatus: string; // "done" = 已付全額
}

export interface OrderRow {
  /** Verified original booking date; never replaced by a notification timestamp. */
  bookingDate: string | null;
  /** Day used for daily reporting; optional only for the legacy upstream. */
  countedDate?: string | null;
  dateBasis?: "notification" | "booking-date" | "unknown";
  platform: string;
  room: string;
  guestName: string;
  checkIn: string;
  nights: number;
  leadDays: number | null;
  amount: number;
}

export interface PlatformShare {
  name: string;
  orders: number;
  nights: number;
  amount: number;
  sharePct: number;
  prevSharePct: number | null;
  deltaPp: number | null;
}

export interface NightGrid {
  dates: string[];
  rooms: { room: string; nights: boolean[] }[];
  totals: number[];
  capacity: number;
}

export interface PulseAction {
  level: "act" | "watch" | "ok";
  title: string;
  evidence: string;
}

export interface PulseData {
  generatedAt: string;
  timezone: "Asia/Taipei";
  yesterday: {
    date: string;
    orders: number;
    nights: number;
    amount: number;
    platforms: { name: string; orders: number }[];
    soldRooms: string[];
    lastNight: { occupied: string[]; count: number; revenue: number };
    detail: OrderRow[];
  };
  today: {
    date: string;
    asOf: string;
    orders: number;
    nights: number;
    amount: number;
    platforms: { name: string; orders: number }[];
    checkIns: {
      room: string;
      guestName: string;
      platform: string;
      checkOut: string;
      nights: number;
      paid: boolean;
      amount: number;
    }[];
    checkOuts: {
      orderId: string;
      rooms: string[];
      guestName: string;
      platform: string;
      checkIn: string;
      checkOut: string;
    }[];
    checkOutsCount: number;
    tonight: { occupied: string[]; count: number; available: string[] };
  };
  last7: {
    from: string;
    to: string;
    orders: number;
    nights: number;
    amount: number;
    vsPrev7: { ordersDelta: number; amountDelta: number; amountDeltaPct: number | null };
    platforms: PlatformShare[];
    roomsSold: { room: string; nights: number; amount: number }[];
    daily14: { date: string; orders: number; amount: number }[];
    leadTimeMedianDays: number | null;
    detail: OrderRow[];
  };
  /** 尚未入住（check-in 在今天之後）的訂單總量 */
  upcoming: { orders: number; nights: number; amount: number };
  grids: { recent7Nights: NightGrid; next7Nights: NightGrid };
  verdict: { level: "up" | "flat" | "down" | "quiet"; headline: string; basis: string };
  actions: PulseAction[];
  summaryText: string;
  meta: {
    orderCount: number;
    generatedAt: string;
    source?: string;
    inventoryVersion?: number;
    authorityEpoch?: number;
    unknownBookingDateOrders?: number;
    dailyOrderDateBasis?: "new-order-notification";
    notificationDateOrders?: number;
    bookingDateFallbackOrders?: number;
    unknownDailyDateOrders?: number;
    dailyComparisonComparable?: boolean;
    notificationCoverageFrom?: string | null;
    unpricedBookings?: number;
    warnings?: string[];
  };
}

