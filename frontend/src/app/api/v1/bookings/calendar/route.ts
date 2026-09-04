import { type NextRequest, NextResponse } from "next/server";

type PaymentStatus = "paid" | "deposit" | "unpaid";
type RawBooking = [
  room: string,
  checkInDay: number,
  roomRate: number,
  platform: "a" | "b" | "c" | "d" | "i" | "o" | "x",
  payment: "d" | "p" | "u",
  orderNumber: number,
  bookedAt: string,
];

const ROOMS = ["101", "102", "201", "202", "301", "302"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const PLATFORM_MAP: Record<RawBooking[3], string> = {
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

const RAW_BOOKINGS: RawBooking[] = [["102",1,1395,"b","p",1,"2026-08-31"],["201",1,2099,"b","p",2,"2026-08-31"],["202",1,3078,"b","p",3,"2026-08-18"],["301",1,888,"b","u",4,"2026-09-01"],["302",1,1890,"b","p",5,"2026-08-14"],["101",2,2950,"d","d",6,"2026-08-25"],["102",2,1184,"c","u",7,"2026-07-03"],["201",2,3100,"d","u",8,"2026-08-17"],["202",2,1941,"b","p",9,"2026-08-29"],["301",2,3200,"d","u",8,"2026-08-17"],["302",2,1800,"d","u",8,"2026-08-17"],["101",3,2533,"a","p",10,"2026-08-25"],["102",3,1692,"c","u",11,"2026-08-12"],["201",3,2115,"a","p",12,"2026-08-30"],["202",3,1458,"c","u",13,"2026-08-30"],["301",3,1535,"c","u",14,"2026-08-30"],["302",3,1800,"d","d",15,"2026-08-23"],["102",4,1762,"b","p",16,"2026-07-13"],["201",4,3613,"a","p",17,"2026-08-25"],["302",4,1640,"c","u",18,"2026-07-13"],["101",5,5185,"a","p",19,"2026-07-07"],["102",5,1944,"b","p",20,"2026-08-30"],["201",5,3612,"a","p",17,"2026-08-25"],["202",5,3888,"b","p",21,"2026-08-21"],["302",5,1640,"c","u",18,"2026-07-13"],["101",6,3800,"d","d",22,"2026-08-20"],["102",6,1594,"b","p",23,"2026-08-04"],["201",6,2975,"a","p",24,"2026-08-17"],["202",6,2604,"o","u",25,"2026-08-27"],["301",6,3060,"a","p",26,"2026-07-31"],["302",6,1770,"b","p",27,"2026-08-25"],["102",7,1594,"b","u",28,"2026-08-07"],["201",7,3150,"b","u",29,"2026-08-12"],["301",7,2330,"a","p",30,"2026-09-04"],["102",8,1742,"b","u",31,"2026-08-08"],["201",8,3150,"b","u",29,"2026-08-12"],["301",8,3600,"o","u",32,"2026-08-08"],["302",8,1742,"b","u",31,"2026-08-08"],["101",9,2069,"c","u",33,"2026-08-30"],["102",9,1594,"b","u",34,"2026-08-13"],["301",9,3200,"d","d",35,"2026-09-02"],["302",9,1785,"a","p",36,"2026-08-12"],["101",10,2069,"c","u",33,"2026-08-30"],["201",10,2975,"a","p",37,"2026-08-10"],["301",10,3240,"b","u",38,"2026-08-15"],["101",11,2975,"c","u",39,"2026-07-13"],["102",11,2225,"b","u",40,"2026-07-05"],["201",11,3600,"b","u",41,"2026-07-28"],["301",11,0,"d","p",42,"2026-07-27"],["302",11,1368,"c","u",43,"2026-07-13"],["101",12,5040,"b","u",44,"2026-07-27"],["201",12,4500,"o","u",45,"2026-07-13"],["202",12,3802,"b","u",46,"2026-08-28"],["301",12,3910,"a","p",47,"2026-08-29"],["302",12,2125,"a","p",48,"2026-08-12"],["102",13,1739,"b","u",49,"2026-09-03"],["201",13,2082,"c","u",50,"2026-08-26"],["301",13,3200,"d","d",51,"2026-08-31"],["302",13,1737,"b","u",49,"2026-09-03"],["101",14,2737,"c","u",52,"2026-08-26"],["102",14,1737,"b","u",49,"2026-09-03"],["302",14,1737,"b","u",49,"2026-09-03"],["301",15,4131,"a","p",53,"2026-08-16"],["302",15,1890,"d","d",54,"2026-09-02"],["102",16,2179,"b","u",55,"2026-08-19"],["302",16,1850,"d","d",56,"2026-09-03"],["102",18,2431,"a","p",57,"2026-08-17"],["101",19,4443,"b","u",58,"2026-07-26"],["102",19,1920,"b","u",59,"2026-06-01"],["201",19,3200,"b","u",60,"2026-06-03"],["202",19,4442,"b","u",58,"2026-07-26"],["301",19,3690,"b","u",61,"2026-06-24"],["302",19,2500,"o","u",62,"2026-06-01"],["101",20,3481,"a","p",63,"2026-08-06"],["102",20,1594,"b","u",64,"2026-06-19"],["201",20,3200,"b","u",60,"2026-06-03"],["202",20,2873,"a","p",65,"2026-08-06"],["301",20,3690,"b","u",61,"2026-06-24"],["302",20,1890,"b","u",66,"2026-07-23"],["101",21,3481,"a","p",63,"2026-08-06"],["102",21,1594,"b","u",64,"2026-06-19"],["201",21,2975,"c","u",67,"2026-09-03"],["202",21,2873,"a","p",65,"2026-08-06"],["302",21,2414,"a","p",68,"2026-08-28"],["302",22,2414,"a","p",68,"2026-08-28"],["102",23,1101,"b","u",69,"2026-08-13"],["302",23,1250,"c","u",70,"2026-08-23"],["301",24,3600,"d","d",71,"2026-09-02"],["302",24,2200,"d","d",72,"2026-08-23"],["101",25,3570,"c","u",73,"2026-07-11"],["102",25,2244,"c","u",74,"2026-08-17"],["201",25,4080,"a","p",75,"2026-08-08"],["202",25,3157,"b","u",76,"2026-05-30"],["301",25,3876,"a","p",77,"2026-08-22"],["302",25,1642,"c","u",78,"2026-07-11"],["101",26,5040,"b","u",79,"2026-09-03"],["102",26,2307,"b","u",80,"2026-08-10"],["201",26,4860,"b","u",81,"2026-08-26"],["202",26,4614,"b","u",82,"2026-08-22"],["301",26,4692,"a","p",83,"2026-08-28"],["302",26,2550,"a","p",84,"2026-08-16"],["101",27,5900,"d","d",85,"2026-08-29"],["102",27,2551,"b","u",86,"2026-08-08"],["201",27,4284,"a","p",87,"2026-08-19"],["202",27,4432,"b","u",88,"2026-07-20"],["301",27,4406,"a","p",89,"2026-08-13"],["302",27,2570,"a","p",90,"2026-08-10"],["302",28,2142,"a","p",91,"2026-07-23"],["101",29,4500,"d","d",92,"2026-08-13"],["102",29,1692,"a","p",93,"2026-08-10"],["201",29,2082,"c","u",94,"2026-08-26"],["301",29,3240,"b","u",95,"2026-08-11"],["301",30,4300,"d","d",96,"2026-09-01"]];

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

const DEMO_BOOKINGS = RAW_BOOKINGS.map(
  ([room, checkInDay, roomRate, platform, payment, orderNumber, bookedAt], index) => {
    const checkIn = `2026-09-${String(checkInDay).padStart(2, "0")}`;
    const orderId = `DEMO-${String(orderNumber).padStart(4, "0")}`;

    return {
      id: `demo-${String(index + 1).padStart(4, "0")}`,
      sheet_row_id: `DEMO-ROW-${String(index + 1).padStart(4, "0")}`,
      order_id: orderId,
      external_order_no: null,
      room_number: room,
      guest_name: `旅客 ${String(orderNumber).padStart(3, "0")}`,
      platform: PLATFORM_MAP[platform],
      check_in: checkIn,
      check_out: addDays(checkIn, 1),
      booked_at: bookedAt,
      room_rate: roomRate,
      payment_status: PAYMENT_MAP[payment],
      notes: null,
    };
  },
);

export function GET(request: NextRequest) {
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

  if (!Number.isFinite(duration) || duration <= 0 || duration > 62) {
    return NextResponse.json(
      { detail: "查詢區間必須介於 1 到 62 天" },
      { status: 400 },
    );
  }

  const bookings = DEMO_BOOKINGS.filter(
    (booking) => booking.check_in < end && booking.check_out > start,
  );
  const date = parseIso(start);
  const uniqueOrders = new Set(
    bookings.map((booking) => booking.order_id ?? booking.sheet_row_id),
  );

  return NextResponse.json({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    month_start: monthStart(start),
    month_end: monthEnd(start),
    period_start: start,
    period_end: end,
    rooms: ROOMS,
    order_count: uniqueOrders.size,
    booking_segment_count: bookings.length,
    total_amount: bookings.reduce((sum, booking) => sum + booking.room_rate, 0),
    bookings,
    data_mode: "anonymized_september_2026_demo",
  });
}
