"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { BedDouble, ChevronUp, LogIn, LogOut, Moon, Users } from "lucide-react";

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
  WEEKDAY_LABELS,
  addDays,
  dateRange,
  formatMonthLabel,
  formatShortDate,
  formatWeekday,
  isOccupiedOn,
  isSameMonth,
  localTodayIso,
  monthCalendarPeriod,
  parseIso,
  roomKey,
  startOfMonth,
  startOfWeek,
} from "./calendar-utils";

export type CalendarViewProps = {
  bookings: CalendarBooking[];
  rooms: CalendarRoom[];
  properties: CalendarProperty[];
  onSelectBooking: (booking: CalendarBooking) => void;
  onSelectDay: (date: string) => void;
};

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function propertyById(properties: CalendarProperty[]) {
  return new Map(properties.map((property) => [property.id, property]));
}

function PaymentDot({ booking }: { booking: CalendarBooking }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", PAYMENT_DOT_STYLES[booking.payment_status])}
    />
  );
}

function BookingChip({
  booking,
  property,
  onSelect,
  compact = false,
}: {
  booking: CalendarBooking;
  property?: CalendarProperty;
  onSelect: (booking: CalendarBooking) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(booking)}
      className={cn(
        "group flex w-full min-w-0 items-center gap-1.5 rounded-md border text-left shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact ? "h-7 px-1.5 text-[10px] sm:text-[11px]" : "min-h-9 px-2.5 py-1.5 text-xs",
        PLATFORM_STYLES[booking.platform] ?? PLATFORM_STYLES.other,
      )}
      title={`${booking.property_name}｜${booking.room_number}｜${booking.guest_name}`}
    >
      {property ? (
        <span className={cn("size-2 shrink-0 rounded-sm", PROPERTY_DOT_STYLES[property.color])} />
      ) : (
        <PaymentDot booking={booking} />
      )}
      <span className="shrink-0 font-semibold">{booking.room_number}</span>
      <span className="hidden min-w-0 flex-1 truncate font-medium min-[430px]:block">
        {booking.guest_name}
      </span>
      <span className="ml-auto hidden sm:inline-block">
        <PaymentDot booking={booking} />
      </span>
    </button>
  );
}

function chunkWeeks(days: string[]) {
  const weeks: string[][] = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(days.slice(index, index + 7));
  }
  return weeks;
}

function MonthPanel({
  monthStart,
  bookings,
  properties,
  onSelectBooking,
  onSelectDay,
  sectionRef,
}: CalendarViewProps & {
  monthStart: string;
  sectionRef: (node: HTMLElement | null) => void;
}) {
  const today = localTodayIso();
  const mobile = useMediaQuery("(max-width: 767px)");
  const period = monthCalendarPeriod(monthStart);
  const weeks = chunkWeeks(dateRange(period.start, period.end));
  const [expandedWeeks, setExpandedWeeks] = useState<string[]>([]);
  const propertyMap = useMemo(() => propertyById(properties), [properties]);
  const monthBookings = bookings.filter(
    (booking) => booking.check_in < period.end && booking.check_out >= period.start,
  );
  const activeRoomNights = monthBookings.reduce((sum, booking) => {
    const visibleStart = booking.check_in > monthStart ? booking.check_in : monthStart;
    const monthEnd = addDays(startOfMonth(addDays(monthStart, 32)), 0);
    const visibleEnd = booking.check_out < monthEnd ? booking.check_out : monthEnd;
    const nights = Math.max(
      0,
      Math.round(
        (parseIso(visibleEnd).getTime() - parseIso(visibleStart).getTime()) / 86_400_000,
      ),
    );
    return sum + nights;
  }, 0);

  return (
    <section ref={sectionRef} data-month={monthStart} className="scroll-mt-2 bg-card">
      <div className="sticky top-0 z-20 flex items-center justify-between border-y bg-background/95 px-3 py-2.5 backdrop-blur md:px-4">
        <h2 className="text-base font-semibold">{formatMonthLabel(monthStart)}</h2>
        <span className="text-xs text-muted-foreground">{activeRoomNights} 房晚</span>
      </div>

      <div className="grid grid-cols-7 border-b bg-muted/35">
        {WEEKDAY_LABELS.map((weekday, index) => (
          <div
            key={weekday}
            className={cn(
              "border-r px-1 py-2 text-center text-[10px] font-semibold text-muted-foreground last:border-r-0 md:text-xs",
              (index === 0 || index === 6) && "bg-muted/45",
            )}
          >
            週{weekday}
          </div>
        ))}
      </div>

      {weeks.map((week) => {
        const weekKey = week[0];
        const expanded = expandedWeeks.includes(weekKey);
        const limit = expanded ? Number.POSITIVE_INFINITY : mobile ? 2 : 4;
        const weekHasOverflow = week.some(
          (date) => monthBookings.filter((booking) => isOccupiedOn(booking, date)).length > limit,
        );

        return (
          <div key={weekKey} className="border-b last:border-b-0">
            <div className="grid grid-cols-7">
              {week.map((date) => {
                const dayBookings = monthBookings
                  .filter((booking) => isOccupiedOn(booking, date))
                  .sort(
                    (a, b) =>
                      a.property_name.localeCompare(b.property_name) ||
                      a.room_number.localeCompare(b.room_number),
                  );
                const arrivals = monthBookings.filter((booking) => booking.check_in === date).length;
                const departures = monthBookings.filter((booking) => booking.check_out === date).length;
                const sameMonth = isSameMonth(date, monthStart);
                const weekday = parseIso(date).getUTCDay();
                const isToday = date === today;
                const visibleBookings = dayBookings.slice(0, limit);
                const remaining = dayBookings.length - visibleBookings.length;

                return (
                  <div
                    key={date}
                    className={cn(
                      "min-h-24 border-r p-1 last:border-r-0 sm:min-h-28 sm:p-1.5 md:min-h-36 md:p-2",
                      (weekday === 0 || weekday === 6) && "bg-muted/15",
                      !sameMonth && "bg-muted/35 text-muted-foreground",
                      isToday && "bg-primary/[0.035]",
                    )}
                  >
                    <div className="mb-1 flex min-h-7 items-start justify-between gap-1 md:mb-2">
                      <button
                        type="button"
                        onClick={() => onSelectDay(date)}
                        className={cn(
                          "flex size-6 items-center justify-center rounded-full text-[11px] font-semibold hover:bg-accent md:size-7 md:text-xs",
                          isToday && "bg-primary text-primary-foreground hover:bg-primary/90",
                        )}
                      >
                        {parseIso(date).getUTCDate()}
                      </button>
                      {(arrivals > 0 || departures > 0) && (
                        <div className="hidden gap-1 text-[9px] text-muted-foreground sm:flex md:text-[10px]">
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
                          property={propertyMap.get(booking.property_id)}
                          onSelect={onSelectBooking}
                          compact
                        />
                      ))}
                      {remaining > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedWeeks((current) =>
                              current.includes(weekKey) ? current : [...current, weekKey],
                            )
                          }
                          className="w-full rounded-md px-1 py-1 text-left text-[10px] font-semibold text-muted-foreground hover:bg-accent hover:text-foreground md:px-2 md:text-[11px]"
                        >
                          還有 {remaining} 筆
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {expanded && weekHasOverflow && (
              <button
                type="button"
                onClick={() =>
                  setExpandedWeeks((current) => current.filter((value) => value !== weekKey))
                }
                className="flex w-full items-center justify-center gap-1 border-t bg-muted/20 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              >
                <ChevronUp className="size-3" />
                收合這一列
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function MonthScroller({
  months,
  targetMonth,
  bookings,
  rooms,
  properties,
  onVisibleMonthChange,
  onSelectBooking,
  onSelectDay,
}: CalendarViewProps & {
  months: string[];
  targetMonth: string;
  onVisibleMonthChange: (month: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const monthRefs = useRef(new Map<string, HTMLElement>());
  const firstScroll = useRef(true);

  useEffect(() => {
    const node = monthRefs.current.get(targetMonth);
    const container = scrollRef.current;
    if (!node || !container) return;
    container.scrollTo({
      top: node.offsetTop - container.offsetTop,
      behavior: firstScroll.current ? "auto" : "smooth",
    });
    firstScroll.current = false;
  }, [targetMonth]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        const month = visible?.target.getAttribute("data-month");
        if (month) onVisibleMonthChange(month);
      },
      { root, threshold: [0.15, 0.35, 0.6], rootMargin: "-5% 0px -70% 0px" },
    );

    monthRefs.current.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [months, onVisibleMonthChange]);

  return (
    <div
      ref={scrollRef}
      className="h-[calc(100dvh-224px)] min-h-[520px] overflow-y-auto overscroll-contain rounded-xl border bg-card shadow-sm md:h-[calc(100dvh-250px)]"
    >
      {months.map((monthStart) => (
        <MonthPanel
          key={monthStart}
          monthStart={monthStart}
          bookings={bookings}
          rooms={rooms}
          properties={properties}
          onSelectBooking={onSelectBooking}
          onSelectDay={onSelectDay}
          sectionRef={(node) => {
            if (node) monthRefs.current.set(monthStart, node);
            else monthRefs.current.delete(monthStart);
          }}
        />
      ))}
    </div>
  );
}

function WeekPanel({
  weekStart,
  bookings,
  rooms,
  properties,
  onSelectBooking,
  onSelectDay,
}: CalendarViewProps & { weekStart: string }) {
  const days = dateRange(weekStart, addDays(weekStart, 7));
  const today = localTodayIso();
  const propertyMap = useMemo(() => propertyById(properties), [properties]);

  return (
    <div className="min-w-full snap-center">
      <div className="hidden min-w-[1100px] md:block">
        <div className="grid grid-cols-[150px_repeat(7,minmax(132px,1fr))] border-b bg-muted/40">
          <div className="flex items-center border-r px-3 py-3 text-xs font-semibold text-muted-foreground">
            旅宿／房間
          </div>
          {days.map((date) => (
            <button
              key={date}
              type="button"
              onClick={() => onSelectDay(date)}
              className={cn(
                "border-r px-3 py-2 text-left last:border-r-0 hover:bg-accent",
                date === today && "bg-primary/[0.06]",
              )}
            >
              <p className="text-xs text-muted-foreground">{formatWeekday(date, true)}</p>
              <p className="mt-1 font-semibold">{formatShortDate(date)}</p>
            </button>
          ))}
        </div>

        {rooms.map((room) => {
          const property = propertyMap.get(room.property_id);
          return (
            <div
              key={room.id}
              className="grid min-h-24 grid-cols-[150px_repeat(7,minmax(132px,1fr))] border-b last:border-b-0"
            >
              <div className="flex items-center gap-2 border-r bg-card px-3 py-3">
                {property && (
                  <span className={cn("size-2.5 rounded-sm", PROPERTY_DOT_STYLES[property.color])} />
                )}
                <div className="min-w-0">
                  <p className="truncate text-xs text-muted-foreground">{property?.short_name}</p>
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
                      "space-y-1 border-r p-2 last:border-r-0",
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
                      <span className="text-[11px] text-muted-foreground/60">空房</span>
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
            (booking, index, list) => list.findIndex((item) => item.id === booking.id) === index,
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
                  <span className="text-xs text-muted-foreground">{formatWeekday(date, true)}</span>
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
                  <p className="py-2 text-center text-xs text-muted-foreground">沒有住宿中的訂單</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function centerScroll(container: HTMLDivElement | null) {
  if (!container) return;
  container.scrollLeft = container.clientWidth;
}

export function WeekCarousel({
  anchorDate,
  bookings,
  rooms,
  properties,
  onNavigateWeek,
  onSelectBooking,
  onSelectDay,
}: CalendarViewProps & {
  anchorDate: string;
  onNavigateWeek: (offset: -1 | 1) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigating = useRef(false);
  const currentWeek = startOfWeek(anchorDate);
  const weeks = [addDays(currentWeek, -7), currentWeek, addDays(currentWeek, 7)];

  useLayoutEffect(() => {
    navigating.current = true;
    requestAnimationFrame(() => {
      centerScroll(scrollRef.current);
      requestAnimationFrame(() => {
        navigating.current = false;
      });
    });
  }, [currentWeek]);

  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    },
    [],
  );

  function handleScroll() {
    if (navigating.current || !scrollRef.current) return;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      const container = scrollRef.current;
      if (!container || container.clientWidth === 0) return;
      const page = Math.round(container.scrollLeft / container.clientWidth);
      if (page === 0) onNavigateWeek(-1);
      if (page === 2) onNavigateWeek(1);
    }, 120);
  }

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="border-b px-3 py-2 text-center text-[11px] text-muted-foreground md:hidden">
        左右滑動切換前後週
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain scroll-smooth"
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

function DayColumn({
  title,
  icon: Icon,
  bookings,
  emptyText,
  properties,
  onSelectBooking,
}: {
  title: string;
  icon: typeof LogIn;
  bookings: CalendarBooking[];
  emptyText: string;
  properties: CalendarProperty[];
  onSelectBooking: (booking: CalendarBooking) => void;
}) {
  const propertyMap = useMemo(() => propertyById(properties), [properties]);

  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4" />
          {title}
        </h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">{bookings.length}</span>
      </div>
      <div className="min-h-40 space-y-2 p-3">
        {bookings.map((booking) => (
          <BookingChip
            key={booking.id}
            booking={booking}
            property={propertyMap.get(booking.property_id)}
            onSelect={onSelectBooking}
          />
        ))}
        {bookings.length === 0 && (
          <div className="flex min-h-32 items-center justify-center text-center text-sm text-muted-foreground">
            {emptyText}
          </div>
        )}
      </div>
    </section>
  );
}

export function DayView({
  date,
  bookings,
  rooms,
  properties,
  onSelectBooking,
}: CalendarViewProps & { date: string }) {
  const arrivals = bookings.filter((booking) => booking.check_in === date);
  const departures = bookings.filter((booking) => booking.check_out === date);
  const staying = bookings.filter(
    (booking) => booking.check_in < date && booking.check_out > date,
  );
  const propertyMap = useMemo(() => propertyById(properties), [properties]);
  const bookingByRoom = new Map(
    bookings
      .filter((booking) => isOccupiedOn(booking, date))
      .map((booking) => [roomKey(booking.property_id, booking.room_number), booking]),
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-3">
        <DayColumn
          title="今日入住"
          icon={LogIn}
          bookings={arrivals}
          emptyText="今天沒有入住"
          properties={properties}
          onSelectBooking={onSelectBooking}
        />
        <DayColumn
          title="住宿中"
          icon={Moon}
          bookings={staying}
          emptyText="沒有續住中的客人"
          properties={properties}
          onSelectBooking={onSelectBooking}
        />
        <DayColumn
          title="今日退房"
          icon={LogOut}
          bookings={departures}
          emptyText="今天沒有退房"
          properties={properties}
          onSelectBooking={onSelectBooking}
        />
      </div>

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">房間狀態</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{formatShortDate(date)} 的入住與續住狀態</p>
          </div>
          <BedDouble className="size-4 text-muted-foreground" />
        </div>
        <div className="grid sm:grid-cols-2 xl:grid-cols-3">
          {rooms.map((room) => {
            const property = propertyMap.get(room.property_id);
            const current = bookingByRoom.get(roomKey(room.property_id, room.room_number));
            const arriving = current?.check_in === date;
            return (
              <button
                key={room.id}
                type="button"
                disabled={!current}
                onClick={() => current && onSelectBooking(current)}
                className="min-h-28 border-b border-r p-4 text-left transition-colors hover:bg-accent/40 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      {property && (
                        <span className={cn("size-2 rounded-sm", PROPERTY_DOT_STYLES[property.color])} />
                      )}
                      {property?.short_name}
                    </p>
                    <p className="mt-1 text-lg font-semibold">{room.label}</p>
                  </div>
                  <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-semibold">
                    {current ? (arriving ? "今日入住" : "住宿中") : "空房"}
                  </span>
                </div>
                <p className="mt-3 truncate text-sm text-muted-foreground">
                  {current ? current.guest_name : "尚無入住安排"}
                </p>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
