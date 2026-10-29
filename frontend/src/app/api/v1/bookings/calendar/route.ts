import { configuredPrivateCalendarCache } from "@/lib/booking-sources/private-calendar-snapshot";
import { overlayPayments } from "@/lib/os-payments";
import { ssotFinanceContext } from "@/lib/finance-ssot-context";
import { ssotFinanceEnabled } from "@/lib/booking-sources/iron-gate-ssot-finance.server";
import { overlaySsotCalendarPayments } from "@/lib/finance-ssot-calendar";
import { canUseFinance } from "@/lib/finance-store";
import { principalFor, sessionMember } from "@/lib/workspace-auth/session";
import { allowedProperty, projectBookings } from "@/lib/workspace-auth/projection";
import { ownerAccessConfigured } from "@/lib/calendar-owner-session";
import { readOperationalSheet } from "@/lib/sheet-monitor/google";
import { recordCalendarHealth } from "@/lib/booking-sources/calendar-diagnostics";
import { randomUUID } from "node:crypto";
import { readCalendarSources, calendarReadError, unconfirmedPayment, type CalendarReadEvent } from "@/lib/booking-sources/calendar-reader";
import { readBookingSnapshot } from "@/lib/booking-sources/snapshot";
import type { CalendarResponse } from "@/components/calendar/calendar-types";
import { activeSources } from "@/lib/booking-sources/config";
import { ironGateCalendarConfig, offlandIronGateCalendarConfig,
  readSweetfunIronGateCalendar, readSweetfunIronGateCalendarSnapshot,
  type IronGateCalendarConfig } from "@/lib/booking-sources/iron-gate-calendar.server";
import { ironGateManualConfig } from "@/lib/booking-sources/iron-gate-manual.server";
import { offlandRetainedConfig, canWriteRetained } from "@/lib/booking-sources/iron-gate-retained.server";
import { ironGateFinanceConfig } from "@/lib/booking-sources/iron-gate-finance.server";
import { ironGateManualPaymentConfig } from "@/lib/booking-sources/iron-gate-manual-payment.server";
import { type NextRequest, NextResponse } from "next/server";
import { calendarServerTiming, type CalendarServerTiming } from "@/lib/calendar-server-timing";

type PaymentStatus = "paid" | "deposit" | "unpaid";
type PlatformCode = "a" | "b" | "c" | "d" | "i" | "o" | "x";
type RawBooking = [
  room: string,
  checkInDay: number,
  roomRate: number,
  platform: PlatformCode,
  payment: "d" | "p" | "u",
  orderNumber: number,
  bookedAt: string,
];
type RawOfflandBooking = [
  checkInDay: number,
  nights: number,
  roomRate: number,
  platform: PlatformCode,
  payment: "d" | "p" | "u",
  orderNumber: number,
  bookedAt: string,
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const PROPERTIES = [
  {
    id: "sweetfun",
    name: "水芳 Sweetfun",
    short_name: "水芳 Sweetfun",
    location: "瑞芳",
    room_count: 6,
    color: "emerald",
  },
  {
    id: "offland",
    name: "遺忘無際 Offland",
    short_name: "遺忘無際",
    location: "宜蘭五結",
    room_count: 1,
    color: "violet",
  },
] as const;

const ROOMS = [
  ...["101", "102", "201", "202", "301", "302"].map((room) => ({
    id: `sweetfun-${room}`,
    property_id: "sweetfun",
    room_number: room,
    label: `${room} 房`,
  })),
  {
    id: "offland-villa",
    property_id: "offland",
    room_number: "包棟",
    label: "包棟",
  },
];

const PLATFORM_MAP: Record<PlatformCode, string> = {
  a: "agoda",
  b: "booking",
  c: "ctrip",
  d: "direct",
  i: "airbnb",
  o: "owljourney",
  x: "other",
};

const PAYMENT_MAP: Record<RawBooking[4], PaymentStatus> = {
  d: "deposit",
  p: "paid",
  u: "unpaid",
};

function readConfiguredIronGate(start: string, end: string,
  principal: NonNullable<Awaited<ReturnType<typeof principalFor>>>,
  config: IronGateCalendarConfig) {
  return config.mode === 'snapshot_preview'
    ? readSweetfunIronGateCalendar(start, end, principal, config)
    : readSweetfunIronGateCalendarSnapshot(start, end, principal, config);
}

const RAW_BOOKINGS: RawBooking[] = [["102",1,1395,"b","p",1,"2026-08-31"],["201",1,2099,"b","p",2,"2026-08-31"],["202",1,3078,"b","p",3,"2026-08-18"],["301",1,888,"b","u",4,"2026-09-01"],["302",1,1890,"b","p",5,"2026-08-14"],["101",2,2950,"d","d",6,"2026-08-25"],["102",2,1184,"c","u",7,"2026-07-03"],["201",2,3100,"d","u",8,"2026-08-17"],["202",2,1941,"b","p",9,"2026-08-29"],["301",2,3200,"d","u",8,"2026-08-17"],["302",2,1800,"d","u",8,"2026-08-17"],["101",3,2533,"a","p",10,"2026-08-25"],["102",3,1692,"c","u",11,"2026-08-12"],["201",3,2115,"a","p",12,"2026-08-30"],["202",3,1458,"c","u",13,"2026-08-30"],["301",3,1535,"c","u",14,"2026-08-30"],["302",3,1800,"d","d",15,"2026-08-23"],["102",4,1762,"b","p",16,"2026-07-13"],["201",4,3613,"a","p",17,"2026-08-25"],["302",4,1640,"c","u",18,"2026-07-13"],["101",5,5185,"a","p",19,"2026-07-07"],["102",5,1944,"b","p",20,"2026-08-30"],["201",5,3612,"a","p",17,"2026-08-25"],["202",5,3888,"b","p",21,"2026-08-21"],["302",5,1640,"c","u",18,"2026-07-13"],["101",6,3800,"d","d",22,"2026-08-20"],["102",6,1594,"b","p",23,"2026-08-04"],["201",6,2975,"a","p",24,"2026-08-17"],["202",6,2604,"o","u",25,"2026-08-27"],["301",6,3060,"a","p",26,"2026-07-31"],["302",6,1770,"b","p",27,"2026-08-25"],["102",7,1594,"b","u",28,"2026-08-07"],["201",7,3150,"b","u",29,"2026-08-12"],["301",7,2330,"a","p",30,"2026-09-04"],["102",8,1742,"b","u",31,"2026-08-08"],["201",8,3150,"b","u",29,"2026-08-12"],["301",8,3600,"o","u",32,"2026-08-08"],["302",8,1742,"b","u",31,"2026-08-08"],["101",9,2069,"c","u",33,"2026-08-30"],["102",9,1594,"b","u",34,"2026-08-13"],["301",9,3200,"d","d",35,"2026-09-02"],["302",9,1785,"a","p",36,"2026-08-12"],["101",10,2069,"c","u",33,"2026-08-30"],["201",10,2975,"a","p",37,"2026-08-10"],["301",10,3240,"b","u",38,"2026-08-15"],["101",11,2975,"c","u",39,"2026-07-13"],["102",11,2225,"b","u",40,"2026-07-05"],["201",11,3600,"b","u",41,"2026-07-28"],["301",11,0,"d","p",42,"2026-07-27"],["302",11,1368,"c","u",43,"2026-07-13"],["101",12,5040,"b","u",44,"2026-07-27"],["201",12,4500,"o","u",45,"2026-07-13"],["202",12,3802,"b","u",46,"2026-08-28"],["301",12,3910,"a","p",47,"2026-08-29"],["302",12,2125,"a","p",48,"2026-08-12"],["102",13,1739,"b","u",49,"2026-09-03"],["201",13,2082,"c","u",50,"2026-08-26"],["301",13,3200,"d","d",51,"2026-08-31"],["302",13,1737,"b","u",49,"2026-09-03"],["101",14,2737,"c","u",52,"2026-08-26"],["102",14,1737,"b","u",49,"2026-09-03"],["302",14,1737,"b","u",49,"2026-09-03"],["301",15,4131,"a","p",53,"2026-08-16"],["302",15,1890,"d","d",54,"2026-09-02"],["102",16,2179,"b","u",55,"2026-08-19"],["302",16,1850,"d","d",56,"2026-09-03"],["102",18,2431,"a","p",57,"2026-08-17"],["101",19,4443,"b","u",58,"2026-07-26"],["102",19,1920,"b","u",59,"2026-06-01"],["201",19,3200,"b","u",60,"2026-06-03"],["202",19,4442,"b","u",58,"2026-07-26"],["301",19,3690,"b","u",61,"2026-06-24"],["302",19,2500,"o","u",62,"2026-06-01"],["101",20,3481,"a","p",63,"2026-08-06"],["102",20,1594,"b","u",64,"2026-06-19"],["201",20,3200,"b","u",60,"2026-06-03"],["202",20,2873,"a","p",65,"2026-08-06"],["301",20,3690,"b","u",61,"2026-06-24"],["302",20,1890,"b","u",66,"2026-07-23"],["101",21,3481,"a","p",63,"2026-08-06"],["102",21,1594,"b","u",64,"2026-06-19"],["201",21,2975,"c","u",67,"2026-09-03"],["202",21,2873,"a","p",65,"2026-08-06"],["302",21,2414,"a","p",68,"2026-08-28"],["302",22,2414,"a","p",68,"2026-08-28"],["102",23,1101,"b","u",69,"2026-08-13"],["302",23,1250,"c","u",70,"2026-08-23"],["301",24,3600,"d","d",71,"2026-09-02"],["302",24,2200,"d","d",72,"2026-08-23"],["101",25,3570,"c","u",73,"2026-07-11"],["102",25,2244,"c","u",74,"2026-08-17"],["201",25,4080,"a","p",75,"2026-08-08"],["202",25,3157,"b","u",76,"2026-05-30"],["301",25,3876,"a","p",77,"2026-08-22"],["302",25,1642,"c","u",78,"2026-07-11"],["101",26,5040,"b","u",79,"2026-09-03"],["102",26,2307,"b","u",80,"2026-08-10"],["201",26,4860,"b","u",81,"2026-08-26"],["202",26,4614,"b","u",82,"2026-08-22"],["301",26,4692,"a","p",83,"2026-08-28"],["302",26,2550,"a","p",84,"2026-08-16"],["101",27,5900,"d","d",85,"2026-08-29"],["102",27,2551,"b","u",86,"2026-08-08"],["201",27,4284,"a","p",87,"2026-08-19"],["202",27,4432,"b","u",88,"2026-07-20"],["301",27,4406,"a","p",89,"2026-08-13"],["302",27,2570,"a","p",90,"2026-08-10"],["302",28,2142,"a","p",91,"2026-07-23"],["101",29,4500,"d","d",92,"2026-08-13"],["102",29,1692,"a","p",93,"2026-08-10"],["201",29,2082,"c","u",94,"2026-08-26"],["301",29,3240,"b","u",95,"2026-08-11"],["301",30,4300,"d","d",96,"2026-09-01"]];

const RAW_OFFLAND_BOOKINGS: RawOfflandBooking[] = [
  [2, 2, 8000, "d", "d", 201, "2026-08-20"],
  [6, 2, 9000, "i", "p", 202, "2026-08-11"],
  [12, 2, 12000, "b", "u", 203, "2026-07-25"],
  [18, 2, 10000, "d", "d", 204, "2026-08-30"],
  [25, 2, 12000, "i", "p", 205, "2026-08-18"],
  [29, 2, 8000, "d", "u", 206, "2026-09-01"],
];

function parseIso(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function toIso(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, days: number) {
  const date = parseIso(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

function monthStart(value: string) {
  const date = parseIso(value);
  return toIso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
}

function monthEnd(value: string) {
  const date = parseIso(value);
  return toIso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)));
}

const SWEETFUN_BOOKINGS = RAW_BOOKINGS.map(
  ([room, checkInDay, roomRate, platform, payment, orderNumber, bookedAt], index) => {
    const checkIn = `2026-09-${String(checkInDay).padStart(2, "0")}`;
    const orderId = `DEMO-${String(orderNumber).padStart(4, "0")}`;

    return {
      id: `sweetfun-demo-${String(index + 1).padStart(4, "0")}`,
      sheet_row_id: `SWEETFUN-ROW-${String(index + 1).padStart(4, "0")}`,
      order_id: orderId,
      external_order_no: null,
      property_id: "sweetfun",
      property_name: "水芳 Sweetfun",
      room_id: `sweetfun-${room}`,
      room_number: room,
      guest_name: `旅客 ${String(orderNumber).padStart(3, "0")}`,
      platform: PLATFORM_MAP[platform],
      check_in: checkIn,
      check_out: addDays(checkIn, 1),
      booked_at: bookedAt,
      room_rate: roomRate,
      payment_status: PAYMENT_MAP[payment],
      reservation_status: "confirmed" as const,
      notes: null,
      payments: [],
      audit_log: [],
    };
  },
);

const OFFLAND_BOOKINGS = RAW_OFFLAND_BOOKINGS.map(
  ([checkInDay, nights, roomRate, platform, payment, orderNumber, bookedAt], index) => {
    const checkIn = `2026-09-${String(checkInDay).padStart(2, "0")}`;
    return {
      id: `offland-demo-${String(index + 1).padStart(3, "0")}`,
      sheet_row_id: `OFFLAND-ROW-${String(index + 1).padStart(3, "0")}`,
      order_id: `OFFLAND-${String(orderNumber).padStart(4, "0")}`,
      external_order_no: null,
      property_id: "offland",
      property_name: "遺忘無際 Offland",
      room_id: "offland-villa",
      room_number: "包棟",
      guest_name: `旅客 ${String(orderNumber).padStart(3, "0")}`,
      platform: PLATFORM_MAP[platform],
      check_in: checkIn,
      check_out: addDays(checkIn, nights),
      booked_at: bookedAt,
      room_rate: roomRate,
      payment_status: PAYMENT_MAP[payment],
      reservation_status: "confirmed" as const,
      notes: null,
      payments: [],
      audit_log: [],
    };
  },
);

const DEMO_BOOKINGS = [...SWEETFUN_BOOKINGS, ...OFFLAND_BOOKINGS];

export async function GET(request: NextRequest) {
  const timing = calendarServerTiming();
  const response = await readCalendarRequest(request, timing);
  timing.apply(response.headers);
  return response;
}

async function readCalendarRequest(request: NextRequest, timing: CalendarServerTiming) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const events: CalendarReadEvent[] = [];
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Request-ID": requestId };
  let authenticatedPrincipal: Awaited<ReturnType<typeof principalFor>> = null;
  // Authenticate before reading snapshots or returning any calendar metadata.
  if (process.env.NODE_ENV === "production" || process.env.CALENDAR_SOURCE === "sheet_snapshot") {
    try {
      const auth = await timing.measure('auth', async () => {
        const member = await sessionMember(request);
        return { requiresPasswordReset: member?.mustResetPassword === true,
          principal: member?.mustResetPassword ? null : await principalFor(request) };
      });
      if (auth.requiresPasswordReset) return NextResponse.json({detail:"請先重設密碼。",requires_password_reset:true},{status:403,headers:{"Cache-Control":"private, no-store"}});
      authenticatedPrincipal = auth.principal;
      if (!authenticatedPrincipal) return NextResponse.json({detail:"請先登入。"},{status:401,headers:{"Cache-Control":"private, no-store",Vary:"Cookie"}});
    } catch {
      return NextResponse.json({detail:"暫時無法確認登入，請稍後再試。"},{status:503,headers:{"Cache-Control":"private, no-store"}});
    }
  }

  const start = request.nextUrl.searchParams.get("start") ?? "2026-09-01";
  const end = request.nextUrl.searchParams.get("end") ?? "2026-10-01";

  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) {
    return NextResponse.json(
      { detail: "start 與 end 必須使用 YYYY-MM-DD 格式" },
      { status: 400 },
    );
  }

  const startDate = parseIso(start);
  const endDate = parseIso(end);
  const duration = Math.round((endDate.getTime() - startDate.getTime()) / DAY_MS);

  if (!Number.isFinite(duration) || duration <= 0 || duration > 1500) {
    return NextResponse.json(
      { detail: "查詢區間必須介於 1 到 1500 天" },
      { status: 400 },
    );
  }

  if (process.env.CALENDAR_SOURCE === "sheet_snapshot") {
    try {
      const principal = authenticatedPrincipal;
      if (!principal) return NextResponse.json({detail:"請先登入。"},{status:401,headers});
      const authorized = activeSources().filter(d => allowedProperty(principal, d.property.id));
      const requested = request.nextUrl.searchParams.get('properties');
      const selected = requested === null ? null : requested.split(',');
      if (selected && (selected.length < 1 || selected.length > 2 ||
          new Set(selected).size !== selected.length ||
          selected.some(id => id !== 'sweetfun' && id !== 'offland')))
        return NextResponse.json({ detail: '館別篩選無效。' }, { status: 400, headers });
      const chosen = selected ? authorized.filter(d => selected.includes(d.property.id)) : authorized;
      // A saved filter may name a property whose membership was removed.
      // Hydrate the remaining authorized properties so the client can recover.
      const definitions = chosen.length ? chosen : authorized;
      if (!definitions.length) return NextResponse.json({ detail: '無法讀取此館別。' }, { status: 403, headers });
      const sweetfunIgEnabled = process.env.IRON_GATE_SWEETFUN_CALENDAR_ENABLED === 'true' ||
        process.env.IRON_GATE_SWEETFUN_CALENDAR_PREVIEW_ENABLED === 'true';
      const offlandIgEnabled = process.env.IRON_GATE_OFFLAND_CALENDAR_ENABLED === 'true' ||
        process.env.IRON_GATE_OFFLAND_CALENDAR_PREVIEW_ENABLED === 'true';
      const sweetfunIgRequested = sweetfunIgEnabled && definitions.some(d => d.key === 'sweetfun');
      const offlandIgRequested = offlandIgEnabled && definitions.some(d => d.key === 'offland');
      if (sweetfunIgRequested || offlandIgRequested) {
        const sheetSources = definitions.filter(d =>
          !(sweetfunIgRequested && d.key === 'sweetfun') &&
          !(offlandIgRequested && d.key === 'offland'));
        const [ig, other, offlandIg] = await timing.measure('source', () => Promise.all([
          sweetfunIgRequested ? readConfiguredIronGate(
            start, end, principal, ironGateCalendarConfig()) : Promise.resolve(null),
          sheetSources.length ? readCalendarSources(sheetSources, start, end, principal.viewPrices, {
            cache: configuredPrivateCalendarCache(), startedAt,
            snapshot: readBookingSnapshot, details: readOperationalSheet,
            payments: overlayPayments,
            report: event => { timing.recordReadEvent(event); events.push(event); },
          }) : Promise.resolve(null),
          offlandIgRequested ? readConfiguredIronGate(start, end, principal,
            offlandIronGateCalendarConfig()) : Promise.resolve(null),
        ]));
        let igPayments = ig?.bookings ?? [];
        let paymentWarning: CalendarResponse['source_warnings'] = [];
        const imported = igPayments.filter(booking => booking.iron_gate_source !== 'os');
        if (principal.viewPrices && imported.length) {
          try {
            const ssot=ssotFinanceEnabled('sweetfun');
            if(ssot&&!canUseFinance(principal))throw Error('FORBIDDEN');
            const overlaid=await timing.measure('payment', async () => ssot?overlaySsotCalendarPayments(imported,
              (await ssotFinanceContext(definitions.find(d=>d.key==='sweetfun')!,
                Number(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',
                  year:'numeric'}).format(new Date())),principal)).orders):
              await overlayPayments(imported));
            const byId = new Map(overlaid.map(booking => [booking.id, booking]));
            igPayments = igPayments.map(booking => byId.get(booking.id) ?? booking);
          }
          catch { igPayments = igPayments.map(booking =>
            booking.iron_gate_source === 'os' ? booking : unconfirmedPayment(booking));
            paymentWarning = [{ property_id: 'sweetfun', label: 'Iron Gate 訂房紀錄', phase: 'payments' }]; }
        }
        let offlandPayments=offlandIg?.bookings??[];
        if(principal.viewPrices&&offlandPayments.length&&ssotFinanceEnabled('offland')){
          try{
            if(!canUseFinance(principal))throw Error('FORBIDDEN');
            offlandPayments=await timing.measure('payment',async()=>overlaySsotCalendarPayments(
              offlandPayments,(await ssotFinanceContext(definitions.find(d=>d.key==='offland')!,
                Number(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric'})
                  .format(new Date())),principal)).orders,'offland'));
          }catch{
            offlandPayments=offlandPayments.map(unconfirmedPayment);
            paymentWarning.push({property_id:'offland',label:'OFFLAND Iron Gate 訂房紀錄',phase:'payments'});
          }
        }
        const bookings = projectBookings([...igPayments,
          ...offlandPayments, ...(other?.bookings ?? [])], principal);
        let manualEnabled = false;
        let manualPaymentEnabled = false;
        let retainedEnabled = false;
        if (offlandIg && (principal.allProperties || principal.propertyIds.includes('offland'))) {
          try { offlandRetainedConfig(); retainedEnabled = true; } catch { /* separate grant, closed by default */ }
        }
        if (ig && principal.viewPrices && ["owner", "admin", "god"].includes(principal.role) &&
          (principal.allProperties || principal.propertyIds.includes("sweetfun"))) {
          try { ironGateManualConfig(); manualEnabled = true; } catch { /* closed by default */ }
          try { ironGateManualPaymentConfig(); ironGateFinanceConfig(); manualPaymentEnabled = true; }
          catch { /* separate money grant stays closed by default */ }
        }
        // A successful booking read does not verify external channel stock.
        // Keep that boundary separate from source-read health.
        const source = ig ? { kind: "iron_gate" as const, label: "Iron Gate 訂房紀錄", observed_at: ig.observedAt,
          read_only: true, automatic_sync: true, availability_authoritative: false,
          private_snapshot_version: String(ig.inventoryVersion),
          sync: { status: "healthy" as const, last_checked_at: ig.observedAt,
            last_successful_check_at: ig.observedAt, last_published_at: ig.observedAt,
            cutoff: ig.observedAt, interval_seconds: 0,
            error_code: null } } : null;
        const missingPaymentNights = igPayments.filter(booking =>
          !booking.source_conflict && booking.payment_status === 'unknown').reduce((sum, booking) => {
          const from = Math.max(Date.parse(`${booking.check_in}T00:00:00Z`), startDate.getTime());
          const to = Math.min(Date.parse(`${booking.check_out}T00:00:00Z`), endDate.getTime());
          return sum + Math.max(0, Math.round((to - from) / DAY_MS));
        }, 0);
        const sourceSummary = ig ? { rows: ig.soldRoomNights,
          accepted_rows: ig.soldRoomNights,
          quarantined_rows: 0, blocked_room_nights: ig.blockedRoomNights,
          missing_order_id: 0,
          missing_payment_status: missingPaymentNights } : null;
        const offlandSource = offlandIg ? { kind: 'iron_gate' as const, label: 'OFFLAND Iron Gate 訂房紀錄',
          observed_at: offlandIg.observedAt, read_only: true,
          automatic_sync: true, availability_authoritative: false,
          private_snapshot_version: String(offlandIg.inventoryVersion),
          sync: { status: 'healthy' as const,
            last_checked_at: offlandIg.observedAt,
            last_successful_check_at: offlandIg.observedAt,
            last_published_at: offlandIg.observedAt,
            cutoff: offlandIg.observedAt, interval_seconds: 0,
            error_code: null } } : null;
        const offlandSummary = offlandIg ? { rows: offlandIg.soldRoomNights,
          accepted_rows: offlandIg.soldRoomNights,
          quarantined_rows: 0,
          blocked_room_nights: offlandIg.blockedRoomNights,
          missing_order_id: 0,
          missing_payment_status: offlandPayments.filter(b=>!b.source_conflict&&b.payment_status==='unknown')
            .reduce((sum,b)=>sum+Math.max(0,Math.round((Math.min(Date.parse(`${b.check_out}T00:00:00Z`),endDate.getTime())-
              Math.max(Date.parse(`${b.check_in}T00:00:00Z`),startDate.getTime()))/DAY_MS)),0) } : null;
        const primarySource = source ?? offlandSource;
        const primarySummary = sourceSummary ?? offlandSummary;
        if (!primarySource || !primarySummary) throw Error('IRON_GATE_CALENDAR_UNAVAILABLE');
        return NextResponse.json({
          price_hidden: !principal.viewPrices,
          year: startDate.getUTCFullYear(), month: startDate.getUTCMonth() + 1,
          month_start: monthStart(start), month_end: monthEnd(start),
          period_start: start, period_end: end,
          properties: PROPERTIES.filter(p => authorized.some(d => d.property.id === p.id)),
          rooms: ROOMS.filter(r => definitions.some(d => d.property.id === r.property_id)),
          order_count: new Set(bookings.filter(b => !b.source_conflict).map(b => b.order_id)).size,
          booking_segment_count: bookings.filter(b => !b.source_conflict).length,
          total_amount: bookings.filter(b => !b.source_conflict && !b.price_hidden)
            .reduce((sum, b) => sum + b.room_rate, 0),
          bookings, source: primarySource, source_summary: primarySummary,
          sources: [...(source && sourceSummary ? [{ property_id: 'sweetfun',
            source, summary: sourceSummary }] : []),
            ...(offlandSource && offlandSummary ? [{ property_id: 'offland',
              source: offlandSource, summary: offlandSummary }] : []),
            ...(other?.snapshots.map(({ definition, snapshot }) => ({
              property_id: definition.property.id, source: snapshot.source,
              summary: snapshot.summary })) ?? [])],
          request_id: requestId,
          source_errors: other?.errors ?? [], source_warnings: [...paymentWarning, ...(other?.warnings ?? [])],
          guest_access: { available: ownerAccessConfigured(), authenticated: true },
          data_mode: "iron_gate_booking_only",
          iron_gate_manual_enabled: manualEnabled,
          iron_gate_manual_payment_enabled: manualPaymentEnabled,
          retained_orders_enabled: retainedEnabled,
          retained_orders_can_write: retainedEnabled && canWriteRetained(principal),
          finance_ssot_enabled: ssotFinanceEnabled('sweetfun'),
          finance_ssot_properties: definitions.filter(d=>ssotFinanceEnabled(d.property.id)).map(d=>d.property.id),
        }, { headers });
      }
      const result = await timing.measure('source', () => readCalendarSources(definitions, start, end, principal.viewPrices, {
        cache: configuredPrivateCalendarCache(), startedAt,
        snapshot: readBookingSnapshot, details: readOperationalSheet,
        payments: overlayPayments,
        report: event => { timing.recordReadEvent(event); events.push(event); console.info(JSON.stringify({ event: "calendar_read", request_id: requestId, release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "local", ...event })); },
      }));
      const { snapshots, errors, warnings } = result;
      let bookings = result.bookings;
      const loadedProperties = new Set(snapshots.map(s => s.definition.property.id));
      const authenticated = true;
      bookings = projectBookings(bookings, principal);
      return NextResponse.json({
        price_hidden: !principal?.viewPrices,
        year: startDate.getUTCFullYear(), month: startDate.getUTCMonth() + 1,
        month_start: monthStart(start), month_end: monthEnd(start), period_start: start, period_end: end,
        properties: PROPERTIES.filter(p => authorized.some(d => d.property.id === p.id)), rooms: ROOMS.filter(r => loadedProperties.has(r.property_id)),
        order_count: new Set(bookings.filter(b => !b.source_conflict).map(b => b.order_id)).size,
        booking_segment_count: bookings.filter(b => !b.source_conflict).length,
        total_amount: bookings.filter(b => !b.source_conflict).reduce((sum, b) => sum + b.room_rate, 0),
        bookings,
        source: { ...snapshots[0].snapshot.source, anonymized: !authenticated, automatic_sync: snapshots.some(s => s.snapshot.source.automatic_sync) },
        source_summary: snapshots[0].snapshot.summary,
        sources: snapshots.map(({ definition, snapshot }) => ({ property_id: definition.property.id, source: { ...snapshot.source, anonymized: !authenticated }, summary: snapshot.summary })),
        request_id: requestId,
        source_errors: errors,
        source_warnings: warnings,
        guest_access: { available: ownerAccessConfigured(), authenticated },
        data_mode: authenticated ? "private_google_sheet_calendar" : "anonymized_google_sheet_snapshot",
      }, { headers });
    } catch (error) {
      console.error(JSON.stringify({ event: "calendar_unavailable", request_id: requestId, code: calendarReadError(error) }));
      // Never fall back to fictional bookings when an operational source is configured.
      return NextResponse.json({ detail: process.env.IRON_GATE_SWEETFUN_CALENDAR_ENABLED === "true"
        ? "訂單日曆暫時無法讀取，請稍後重試。"
        : "訂房表快照暫時無法讀取，請稍後重試。", request_id: requestId }, { status: 503, headers });
    } finally {
      await recordCalendarHealth(events, requestId, startedAt);
    }
  }

  // Include bookings that check out exactly on `start`, so the day view can show
  // today's departures even though the checkout day is not an occupied room night.
  const bookings = DEMO_BOOKINGS.filter(
    (booking) => booking.check_in < end && booking.check_out >= start,
  );
  const date = parseIso(start);
  const uniqueOrders = new Set(bookings.map((booking) => booking.order_id));

  return NextResponse.json({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    month_start: monthStart(start),
    month_end: monthEnd(start),
    period_start: start,
    period_end: end,
    properties: PROPERTIES,
    rooms: ROOMS,
    order_count: uniqueOrders.size,
    booking_segment_count: bookings.length,
    total_amount: bookings.reduce((sum, booking) => sum + booking.room_rate, 0),
    bookings,
    data_mode: "anonymized_multi_property_demo",
  });
}
