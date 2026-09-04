"use client";

import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
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
  rooms: string[];
  order_count: number;
  booking_segment_count: number;
  total_amount: number;
  bookings: CalendarBooking[];
};

type PositionedBooking = CalendarBooking & {
  lane: number;
  startOffset: number;
  span: number;
};

const DEFAULT_ROOMS = ["101", "102", "201", "202", "301", "302"];
const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

const PLATFORM_LABELS: Record<string, string> = {
  direct: "LINE／直訂",
  agoda: "Agoda",
  booking: "Booking",
  airbnb: "Airbnb",
  ctrip: "CTrip",
  owljourney: "OwlJourney",
  other: "其他",
};

const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  paid: "已付清",
  deposit: "已付訂金",
  unpaid: "未付款",
};

const PAYMENT_STYLES: Record<PaymentStatus, string> = {
  paid: "border-emerald-300 bg-emerald-100 text-emerald-950 hover:bg-emerald-200",
  deposit: "border-amber-300 bg-amber-100 text-amber-950 hover:bg-amber-200",
  unpaid: "border-rose-300 bg-rose-100 text-rose-950 hover:bg-rose-200",
};

function monthBounds(year: number, month: number) {
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const monthEnd = `${next.year}-${String(next.month).padStart(2, "0")}-01`;
  return { monthStart, monthEnd };
}

function isoDayNumber(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function dayDifference(value: string, origin: string) {
  return isoDayNumber(value) - isoDayNumber(origin);
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  return `${year}/${Number(month)}/${Number(day)}`;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: "TWD",
    maximumFractionDigits: 0,
  }).format(value);
}

function assignLanes(
  bookings: CalendarBooking[],
  monthStart: string,
  monthEnd: string,
): { items: PositionedBooking[]; laneCount: number } {
  const laneEnds: number[] = [];
  const monthLength = dayDifference(monthEnd, monthStart);

  const items = [...bookings]
    .sort((a, b) => a.check_in.localeCompare(b.check_in))
    .map((booking) => {
      const startOffset = Math.max(0, dayDifference(booking.check_in, monthStart));
      const endOffset = Math.min(monthLength, dayDifference(booking.check_out, monthStart));
      const span = Math.max(1, endOffset - startOffset);
      let lane = laneEnds.findIndex((laneEnd) => laneEnd <= startOffset);

      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(endOffset);
      } else {
        laneEnds[lane] = endOffset;
      }

      return { ...booking, lane, startOffset, span };
    });

  return { items, laneCount: Math.max(1, laneEnds.length) };
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{value}</dd>
    </div>
  );
}

export function BookingCalendar() {
  const [cursor, setCursor] = useState({ year: 2026, month: 9 });
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CalendarBooking | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;

    async function loadCalendar() {
      setLoading(true);
      setError(null);
      try {
        const response = await apiClient.get<CalendarResponse>(
          `/bookings/calendar?year=${cursor.year}&month=${cursor.month}`,
        );
        if (active) setData(response);
      } catch (requestError) {
        if (active) {
          setData(null);
          setError(
            requestError instanceof Error ? requestError.message : "無法讀取訂單月曆",
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
  }, [cursor, reloadKey]);

  const { monthStart, monthEnd } = monthBounds(cursor.year, cursor.month);
  const dayCount = dayDifference(monthEnd, monthStart);
  const days = useMemo(
    () =>
      Array.from({ length: dayCount }, (_, index) => {
        const date = new Date(Date.UTC(cursor.year, cursor.month - 1, index + 1));
        return {
          day: index + 1,
          weekday: date.getUTCDay(),
        };
      }),
    [cursor, dayCount],
  );

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

  const bookingsByRoom = useMemo(() => {
    const grouped = new Map<string, CalendarBooking[]>();
    for (const booking of filteredBookings) {
      const current = grouped.get(booking.room_number) ?? [];
      current.push(booking);
      grouped.set(booking.room_number, current);
    }
    return grouped;
  }, [filteredBookings]);

  const rooms = data?.rooms.length ? data.rooms : DEFAULT_ROOMS;
  const gridTemplateColumns = `104px repeat(${dayCount}, minmax(42px, 1fr))`;

  function changeMonth(offset: number) {
    const target = new Date(Date.UTC(cursor.year, cursor.month - 1 + offset, 1));
    setCursor({ year: target.getUTCFullYear(), month: target.getUTCMonth() + 1 });
  }

  function goToToday() {
    const today = new Date();
    setCursor({ year: today.getFullYear(), month: today.getMonth() + 1 });
  }

  const today = new Date();
  const isCurrentMonth =
    today.getFullYear() === cursor.year && today.getMonth() + 1 === cursor.month;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <CalendarDays className="size-4" />
            <span className="text-sm font-medium">Sweetfun</span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">訂單月曆</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            依房間查看入住區間；點擊訂單可查看完整資料。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => changeMonth(-1)}>
            <ChevronLeft />
            <span className="sr-only">上個月</span>
          </Button>
          <div className="min-w-36 text-center text-lg font-semibold">
            {cursor.year} 年 {cursor.month} 月
          </div>
          <Button variant="outline" size="icon" onClick={() => changeMonth(1)}>
            <ChevronRight />
            <span className="sr-only">下個月</span>
          </Button>
          <Button variant="outline" onClick={goToToday}>
            今天
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">訂單數</p>
          <p className="mt-1 text-2xl font-semibold">{data?.order_count ?? "—"}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">住宿明細</p>
          <p className="mt-1 text-2xl font-semibold">
            {data?.booking_segment_count ?? "—"}
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">房費合計</p>
          <p className="mt-1 text-2xl font-semibold">
            {data ? formatMoney(data.total_amount) : "—"}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
            placeholder="搜尋客人、房號或訂單編號"
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {(Object.keys(PAYMENT_LABELS) as PaymentStatus[]).map((status) => (
            <span key={status} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "size-2.5 rounded-full border",
                  status === "paid" && "border-emerald-400 bg-emerald-200",
                  status === "deposit" && "border-amber-400 bg-amber-200",
                  status === "unpaid" && "border-rose-400 bg-rose-200",
                )}
              />
              {PAYMENT_LABELS[status]}
            </span>
          ))}
        </div>
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

      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <div className="min-w-[1420px]">
          <div className="grid border-b bg-muted/50" style={{ gridTemplateColumns }}>
            <div className="sticky left-0 z-30 flex h-14 items-center border-r bg-muted px-4 text-sm font-semibold">
              房間
            </div>
            {days.map(({ day, weekday }) => {
              const isToday = isCurrentMonth && today.getDate() === day;
              const isWeekend = weekday === 0 || weekday === 6;
              return (
                <div
                  key={day}
                  className={cn(
                    "flex h-14 flex-col items-center justify-center border-r text-xs last:border-r-0",
                    isWeekend && "bg-muted/70",
                    isToday && "bg-primary/10 text-primary",
                  )}
                >
                  <span className="font-semibold">{day}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {WEEKDAY_LABELS[weekday]}
                  </span>
                </div>
              );
            })}
          </div>

          {loading ? (
            <div className="flex h-72 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              讀取訂單中
            </div>
          ) : (
            rooms.map((room) => {
              const positioned = assignLanes(
                bookingsByRoom.get(room) ?? [],
                monthStart,
                monthEnd,
              );
              const rowHeight = Math.max(64, positioned.laneCount * 38 + 10);

              return (
                <div
                  key={room}
                  className="grid border-b last:border-b-0"
                  style={{ gridTemplateColumns, minHeight: rowHeight }}
                >
                  <div
                    className="sticky left-0 z-20 flex items-center border-r bg-card px-4 text-sm font-semibold"
                    style={{ gridColumn: 1, gridRow: 1, height: rowHeight }}
                  >
                    {room}
                  </div>
                  {days.map(({ day, weekday }) => {
                    const isToday = isCurrentMonth && today.getDate() === day;
                    const isWeekend = weekday === 0 || weekday === 6;
                    return (
                      <div
                        key={day}
                        className={cn(
                          "border-r last:border-r-0",
                          isWeekend && "bg-muted/25",
                          isToday && "bg-primary/[0.04]",
                        )}
                        style={{ gridColumn: day + 1, gridRow: 1, height: rowHeight }}
                      />
                    );
                  })}

                  {positioned.items.map((booking) => (
                    <button
                      key={booking.id}
                      type="button"
                      onClick={() => setSelected(booking)}
                      className={cn(
                        "z-10 mx-1 overflow-hidden rounded-md border px-2 text-left text-xs shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        PAYMENT_STYLES[booking.payment_status],
                      )}
                      style={{
                        gridColumn: `${booking.startOffset + 2} / span ${booking.span}`,
                        gridRow: 1,
                        alignSelf: "start",
                        height: 32,
                        marginTop: booking.lane * 38 + 5,
                      }}
                      title={`${booking.guest_name}｜${formatDate(booking.check_in)}–${formatDate(booking.check_out)}`}
                    >
                      <span className="block truncate font-semibold">{booking.guest_name}</span>
                      <span className="block truncate text-[10px] opacity-75">
                        {PLATFORM_LABELS[booking.platform] ?? booking.platform}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>

      {!loading && !error && filteredBookings.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">
          這個月份沒有符合條件的訂單。
        </p>
      )}

      <Sheet
        open={selected !== null}
        onOpenChange={(open: boolean) => !open && setSelected(null)}
      >
        <SheetContent className="sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>{selected?.guest_name ?? "訂單資料"}</SheetTitle>
            <SheetDescription>
              {selected
                ? `${selected.room_number} 房｜${formatDate(selected.check_in)}–${formatDate(selected.check_out)}`
                : ""}
            </SheetDescription>
          </SheetHeader>

          {selected && (
            <div className="overflow-y-auto px-4 pb-6">
              <dl className="divide-y">
                <DetailRow
                  label="平台"
                  value={PLATFORM_LABELS[selected.platform] ?? selected.platform}
                />
                <DetailRow label="付款" value={PAYMENT_LABELS[selected.payment_status]} />
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
