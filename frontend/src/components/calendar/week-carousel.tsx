"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { cn } from "@/lib/utils";

import type {
  CalendarBooking,
  CalendarProperty,
  CalendarRoom,
} from "./calendar-types";
import {
  PAYMENT_DOT_STYLES,
  PLATFORM_STYLES,
  PROPERTY_DOT_STYLES,
  addDays,
  dateRange,
  formatShortDate,
  formatWeekday,
  isOccupiedOn,
  localTodayIso,
  startOfWeek,
} from "./calendar-utils";

type WeekCarouselProps = {
  anchorDate: string;
  bookings: CalendarBooking[];
  rooms: CalendarRoom[];
  properties: CalendarProperty[];
  onNavigateWeek: (offset: -1 | 1) => void;
  onSelectBooking: (booking: CalendarBooking) => void;
  onSelectDay: (date: string) => void;
};

function propertyById(properties: CalendarProperty[]) {
  return new Map(properties.map((property) => [property.id, property]));
}

function PaymentDot({ booking }: { booking: CalendarBooking }) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        PAYMENT_DOT_STYLES[booking.payment_status],
      )}
    />
  );
}

function BookingChip({
  booking,
  property,
  onSelect,
}: {
  booking: CalendarBooking;
  property?: CalendarProperty;
  onSelect: (booking: CalendarBooking) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(booking)}
      className={cn(
        "flex min-h-9 w-full min-w-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        PLATFORM_STYLES[booking.platform] ?? PLATFORM_STYLES.other,
      )}
      title={`${booking.property_name}｜${booking.room_number}｜${booking.guest_name}`}
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
      <span className="shrink-0 font-semibold">{booking.room_number}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{booking.guest_name}</span>
      <PaymentDot booking={booking} />
    </button>
  );
}

function WeekPanel({
  weekStart,
  bookings,
  rooms,
  properties,
  onSelectBooking,
  onSelectDay,
}: Omit<WeekCarouselProps, "anchorDate" | "onNavigateWeek"> & {
  weekStart: string;
}) {
  const days = dateRange(weekStart, addDays(weekStart, 7));
  const today = localTodayIso();
  const propertyMap = useMemo(() => propertyById(properties), [properties]);

  return (
    <div className="w-full flex-none snap-center snap-always">
      <div className="hidden md:block">
        <div className="grid grid-cols-[132px_repeat(7,minmax(0,1fr))] border-b bg-muted/40">
          <div className="flex items-center border-r px-3 py-3 text-xs font-semibold text-muted-foreground">
            旅宿／房間
          </div>
          {days.map((date) => (
            <button
              key={date}
              type="button"
              onClick={() => onSelectDay(date)}
              className={cn(
                "min-w-0 border-r px-2 py-2 text-left last:border-r-0 hover:bg-accent",
                date === today && "bg-primary/[0.06]",
              )}
            >
              <p className="truncate text-[11px] text-muted-foreground">
                {formatWeekday(date, true)}
              </p>
              <p className="mt-1 truncate text-sm font-semibold">{formatShortDate(date)}</p>
            </button>
          ))}
        </div>

        {rooms.map((room) => {
          const property = propertyMap.get(room.property_id);
          return (
            <div
              key={room.id}
              className="grid min-h-24 grid-cols-[132px_repeat(7,minmax(0,1fr))] border-b last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-2 border-r bg-card px-3 py-3">
                {property && (
                  <span
                    className={cn(
                      "size-2.5 shrink-0 rounded-sm",
                      PROPERTY_DOT_STYLES[property.color],
                    )}
                  />
                )}
                <div className="min-w-0">
                  <p className="truncate text-[11px] text-muted-foreground">
                    {property?.short_name}
                  </p>
                  <p className="truncate text-sm font-semibold">{room.label}</p>
                </div>
              </div>
              {days.map((date) => {
                const cellBookings = bookings.filter(
                  (booking) =>
                    booking.property_id === room.property_id &&
                    booking.room_id === room.id &&
                    isOccupiedOn(booking, date),
                );
                return (
                  <div
                    key={date}
                    className={cn(
                      "min-w-0 space-y-1 border-r p-1.5 last:border-r-0",
                      date === today && "bg-primary/[0.025]",
                    )}
                  >
                    {cellBookings.map((booking) => (
                      <BookingChip
                        key={booking.id}
                        booking={booking}
                        property={property}
                        onSelect={onSelectBooking}
                      />
                    ))}
                    {cellBookings.length === 0 && (
                      <span className="text-[10px] text-muted-foreground/60">空房</span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="space-y-2 p-2 md:hidden">
        {days.map((date) => {
          const arrivals = bookings.filter((booking) => booking.check_in === date);
          const departures = bookings.filter((booking) => booking.check_out === date);
          const staying = bookings.filter(
            (booking) => booking.check_in < date && booking.check_out > date,
          );
          const visible = [...arrivals, ...staying].filter(
            (booking, index, list) =>
              list.findIndex((item) => item.id === booking.id) === index,
          );

          return (
            <section
              key={date}
              className={cn(
                "rounded-xl border bg-card p-3",
                date === today && "border-primary/40 bg-primary/[0.025]",
              )}
            >
              <button
                type="button"
                onClick={() => onSelectDay(date)}
                className="flex w-full items-center justify-between text-left"
              >
                <span>
                  <span className="text-xs text-muted-foreground">
                    {formatWeekday(date, true)}
                  </span>
                  <span className="ml-2 text-sm font-semibold">{formatShortDate(date)}</span>
                </span>
                <span className="text-[11px] text-muted-foreground">
                  入 {arrivals.length} · 退 {departures.length}
                </span>
              </button>
              <div className="mt-2 space-y-1.5">
                {visible.map((booking) => (
                  <BookingChip
                    key={booking.id}
                    booking={booking}
                    property={propertyMap.get(booking.property_id)}
                    onSelect={onSelectBooking}
                  />
                ))}
                {visible.length === 0 && (
                  <p className="py-2 text-center text-xs text-muted-foreground">
                    沒有住宿中的訂單
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function jumpToCenter(container: HTMLDivElement | null) {
  if (!container) return;
  const previousBehavior = container.style.scrollBehavior;
  container.style.scrollBehavior = "auto";
  container.scrollLeft = container.clientWidth;
  container.style.scrollBehavior = previousBehavior;
}

export function WeekCarousel({
  anchorDate,
  bookings,
  rooms,
  properties,
  onNavigateWeek,
  onSelectBooking,
  onSelectDay,
}: WeekCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationLocked = useRef(true);
  const currentWeek = startOfWeek(anchorDate);
  const weeks = [addDays(currentWeek, -7), currentWeek, addDays(currentWeek, 7)];

  useLayoutEffect(() => {
    navigationLocked.current = true;
    jumpToCenter(scrollRef.current);
    const frame = requestAnimationFrame(() => {
      navigationLocked.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [currentWeek]);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  function handleScroll() {
    if (navigationLocked.current || !scrollRef.current) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);

    settleTimer.current = setTimeout(() => {
      const container = scrollRef.current;
      if (!container || container.clientWidth === 0) return;
      const page = Math.round(container.scrollLeft / container.clientWidth);
      if (page === 1) return;

      navigationLocked.current = true;
      onNavigateWeek(page < 1 ? -1 : 1);
    }, 140);
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {weeks.map((weekStart) => (
          <WeekPanel
            key={weekStart}
            weekStart={weekStart}
            bookings={bookings}
            rooms={rooms}
            properties={properties}
            onSelectBooking={onSelectBooking}
            onSelectDay={onSelectDay}
          />
        ))}
      </div>
    </div>
  );
}
