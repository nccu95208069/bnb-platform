import seedRows from "@/data/september-calendar-seed.json";

type CalendarBooking = {
  id: string;
  sheet_row_id: string;
  order_id: string;
  external_order_no: null;
  room_number: string;
  guest_name: string;
  platform: string;
  check_in: string;
  check_out: string;
  booked_at: string | null;
  room_rate: number;
  payment_status: "paid" | "deposit" | "unpaid";
  notes: null;
};

const ROOMS = ["101", "102", "201", "202", "301", "302"];
const PLATFORM_CODES: Record<string, string> = {
  b: "booking",
  a: "agoda",
  r: "airbnb",
  d: "direct",
  c: "ctrip",
  o: "owljourney",
  x: "other",
};
const PAYMENT_CODES: Record<string, CalendarBooking["payment_status"]> = {
  p: "paid",
  d: "deposit",
  u: "unpaid",
};

type SeedRow = [string, number, string, string, string, string | null, number, string];

function isoFromMonthDay(value: string | null): string | null {
  if (!value) return null;
  if (value.length === 10) return value;
  return `2026-${value}`;
}

const BOOKINGS: CalendarBooking[] = (seedRows as SeedRow[]).map((row, index) => {
  const [room, orderNumber, platformCode, checkIn, checkOut, bookedAt, rate, paymentCode] =
    row;
  const paddedOrder = String(orderNumber).padStart(2, "0");

  return {
    id: `demo_${index + 1}`,
    sheet_row_id: `seed_${index + 1}`,
    order_id: `ord_demo_${paddedOrder}`,
    external_order_no: null,
    room_number: room,
    guest_name: `房客 ${paddedOrder}`,
    platform: PLATFORM_CODES[platformCode] ?? "other",
    check_in: isoFromMonthDay(checkIn) ?? "2026-09-01",
    check_out: isoFromMonthDay(checkOut) ?? "2026-09-02",
    booked_at: isoFromMonthDay(bookedAt),
    room_rate: rate,
    payment_status: PAYMENT_CODES[paymentCode] ?? "unpaid",
    notes: null,
  };
});

function addMonths(value: string, amount: number): string {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return date.toISOString().slice(0, 10);
}

function resolveRange(path: string): { start: string; end: string } {
  const url = new URL(path, "https://preview.local");
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (start && end) return { start, end };

  const year = Number(url.searchParams.get("year") || 2026);
  const month = Number(url.searchParams.get("month") || 9);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  return { start: monthStart, end: addMonths(monthStart, 1) };
}

export function isCalendarPath(path: string): boolean {
  return path.startsWith("/bookings/calendar");
}

export function getDemoCalendarResponse(path: string): unknown {
  const { start, end } = resolveRange(path);
  const bookings = BOOKINGS.filter(
    (booking) => booking.check_in < end && booking.check_out > start,
  );
  const rooms = Array.from(
    new Set([...ROOMS, ...bookings.map((booking) => booking.room_number)]),
  );

  return {
    year: Number(start.slice(0, 4)),
    month: Number(start.slice(5, 7)),
    month_start: start,
    month_end: end,
    period_start: start,
    period_end: end,
    rooms,
    order_count: new Set(bookings.map((booking) => booking.order_id)).size,
    booking_segment_count: bookings.length,
    total_amount: bookings.reduce((sum, booking) => sum + booking.room_rate, 0),
    bookings,
    preview_mode: true,
  };
}
