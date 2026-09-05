"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  DoorOpen,
  LoaderCircle,
  LogIn,
  LogOut,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { PAYMENT_SANDBOX } from "@/lib/payment-workflow";
import { PaymentWorkspace } from "@/components/payments/payment-workspace";

import {
  BookingDetailsPanel,
  type RecordPaymentInput,
  type UpdateBookingInput,
} from "@/components/calendar/booking-editor";
import { useCalendarPreferences } from "@/components/calendar/calendar-preferences";
import type {
  BabySupplyKey,
  BookingAuditEvent,
  CalendarBooking,
  CalendarResponse,
  CalendarView,
  PaymentRecord,
  PaymentStatus,
} from "@/components/calendar/calendar-types";
import { DayView, MonthScroller } from "@/components/calendar/calendar-views";
import {
  PAYMENT_DOT_STYLES,
  PAYMENT_LABELS,
  PLATFORM_LABELS,
  PLATFORM_STYLES,
  VIEW_LABELS,
  addDays,
  addMonths,
  coalesceContiguousBookings,
  currentPeriod,
  dayDifference,
  fetchPeriod,
  formatMoney,
  formatMonthLabel,
  localTodayIso,
  monthStarts,
  overlapNights,
  startOfMonth,
} from "@/components/calendar/calendar-utils";
import { WeekCarousel } from "@/components/calendar/week-carousel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/api-client";
import {
  useAccessControl,
  useEffectivePermissions,
  useEffectiveRole,
} from "@/lib/access-control";
import { cn } from "@/lib/utils";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const EDIT_STORAGE_KEY = "sweetfun-os-demo-edits-v4";
const MONTHS = monthStarts("2025-01-01", 36);

type OrderPatch = {
  guest_name?: string;
  payment_status?: PaymentStatus;
  reservation_status?: "confirmed" | "cancelled";
  payments?: PaymentRecord[];
  audit_log?: BookingAuditEvent[];
};

type SegmentPatch = {
  room_id?: string;
  room_number?: string;
  check_in?: string;
  check_out?: string;
  room_rate?: number;
  extra_guest_count?: number;
  extra_bed_count?: number;
  pet_count?: number;
  baby_supplies?: BabySupplyKey[];
  service_note?: string | null;
  hidden?: boolean;
};

type DemoEditState = {
  orders: Record<string, OrderPatch>;
  segments: Record<string, SegmentPatch>;
};

const EMPTY_EDITS: DemoEditState = { orders: {}, segments: {} };

function uniqueId(prefix: string) {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

function MetricCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CalendarDays;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-xs">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className="mt-1 text-xl font-semibold tracking-tight text-foreground">
        {value}
      </p>
    </div>
  );
}

function overlayEdits(
  booking: CalendarBooking,
  edits: DemoEditState,
): CalendarBooking | null {
  const orderPatch = edits.orders[booking.order_id] ?? {};
  const segmentPatch = edits.segments[booking.id] ?? {};
  if (segmentPatch.hidden) return null;

  return {
    ...booking,
    ...segmentPatch,
    guest_name: orderPatch.guest_name ?? booking.guest_name,
    payment_status: orderPatch.payment_status ?? booking.payment_status,
    reservation_status:
      orderPatch.reservation_status ?? booking.reservation_status,
    payments: orderPatch.payments ?? booking.payments ?? [],
    audit_log: [...(booking.audit_log ?? []), ...(orderPatch.audit_log ?? [])],
    extra_guest_count:
      segmentPatch.extra_guest_count ?? booking.extra_guest_count ?? 0,
    extra_bed_count:
      segmentPatch.extra_bed_count ?? booking.extra_bed_count ?? 0,
    pet_count: segmentPatch.pet_count ?? booking.pet_count ?? 0,
    baby_supplies: segmentPatch.baby_supplies ?? booking.baby_supplies ?? [],
    service_note: segmentPatch.service_note ?? booking.service_note ?? null,
    source_segment_ids: booking.source_segment_ids ?? [booking.id],
  };
}

export function BookingCalendarResponsive() {
  const view = useCalendarPreferences((state) => state.view);
  const setView = useCalendarPreferences((state) => state.setView);
  const query = useCalendarPreferences((state) => state.searchQuery);
  const setQuery = useCalendarPreferences((state) => state.setSearchQuery);
  const mobileSearchOpen = useCalendarPreferences(
    (state) => state.mobileSearchOpen,
  );
  const setMobileSearchOpen = useCalendarPreferences(
    (state) => state.setMobileSearchOpen,
  );
  const setMobilePeriodLabel = useCalendarPreferences(
    (state) => state.setMobilePeriodLabel,
  );
  const navigationRequest = useCalendarPreferences(
    (state) => state.navigationRequest,
  );
  const selectedPropertyIds = useCalendarPreferences(
    (state) => state.selectedPropertyIds,
  );
  const setProperties = useCalendarPreferences((state) => state.setProperties);

  const initializeAccess = useAccessControl((state) => state.initialize);
  const membership = useAccessControl((state) => state.membership);
  const permissions = useEffectivePermissions();
  const effectiveRole = useEffectiveRole();

  const [anchorDate, setAnchorDate] = useState("2026-09-04");
  const [visibleMonth, setVisibleMonth] = useState("2026-09-01");
  const [monthTarget, setMonthTarget] = useState("2026-09-01");
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [edits, setEdits] = useState<DemoEditState>(EMPTY_EDITS);
  const [editsHydrated, setEditsHydrated] = useState(false);
  const hasLoadedData = useRef(false);
  const previousView = useRef<CalendarView>(view);
  const handledNavigationRequest = useRef(0);
  const openedOrderLink = useRef<string | null>(null);

  const requestPeriod = useMemo(
    () => fetchPeriod(anchorDate, view),
    [anchorDate, view],
  );
  const displayPeriod = useMemo(() => {
    if (view === "month") {
      return {
        start: visibleMonth,
        end: addMonths(visibleMonth, 1),
        label: formatMonthLabel(visibleMonth),
      };
    }
    return currentPeriod(anchorDate, view);
  }, [anchorDate, view, visibleMonth]);

  useEffect(() => {
    void initializeAccess();
    if (
      PAYMENT_SANDBOX &&
      new URLSearchParams(window.location.search).has("order")
    )
      useCalendarPreferences.getState().setView("month");
  }, [initializeAccess]);

  useEffect(() => {
    setMobilePeriodLabel(displayPeriod.label);
  }, [displayPeriod.label, setMobilePeriodLabel]);

  useEffect(() => {
    if (!navigationRequest) return;
    if (navigationRequest.id <= handledNavigationRequest.current) return;
    handledNavigationRequest.current = navigationRequest.id;

    if (navigationRequest.action === "today") {
      const today = localTodayIso();
      setAnchorDate(today);
      if (view === "month") {
        const month = startOfMonth(today);
        setVisibleMonth(month);
        setMonthTarget(month);
      }
      return;
    }

    const direction = navigationRequest.action === "previous" ? -1 : 1;
    if (view === "month") {
      const target = addMonths(visibleMonth, direction);
      setVisibleMonth(target);
      setMonthTarget(target);
      setAnchorDate(target);
      return;
    }
    if (view === "week") {
      setAnchorDate((value) => addDays(value, direction * 7));
      return;
    }
    setAnchorDate((value) => addDays(value, direction));
  }, [navigationRequest, view, visibleMonth]);

  useEffect(() => {
    const oldView = previousView.current;
    previousView.current = view;
    if (oldView === view || view !== "month") return;

    const month = startOfMonth(anchorDate);
    const frame = requestAnimationFrame(() => {
      setVisibleMonth(month);
      setMonthTarget(month);
    });
    return () => cancelAnimationFrame(frame);
  }, [anchorDate, view]);

  useEffect(() => {
    if (!DEMO_MODE || PAYMENT_SANDBOX) {
      setEditsHydrated(true);
      return;
    }
    try {
      const stored = window.localStorage.getItem(EDIT_STORAGE_KEY);
      if (stored) setEdits(JSON.parse(stored) as DemoEditState);
    } catch {
      window.localStorage.removeItem(EDIT_STORAGE_KEY);
    } finally {
      setEditsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!DEMO_MODE || PAYMENT_SANDBOX || !editsHydrated) return;
    window.localStorage.setItem(EDIT_STORAGE_KEY, JSON.stringify(edits));
  }, [edits, editsHydrated]);

  useEffect(() => {
    let active = true;
    const initialLoad = !hasLoadedData.current;

    async function loadCalendar() {
      if (initialLoad) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const response = PAYMENT_SANDBOX
          ? await fetch(
              `/api/payment-sandbox/calendar?start=${requestPeriod.start}&end=${requestPeriod.end}`,
              { cache: "no-store" },
            ).then(async (r) => {
              if (!r.ok) throw new Error("無法連接隔離測試服務，請稍後重試。");
              return r.json() as Promise<CalendarResponse>;
            })
          : await apiClient.get<CalendarResponse>(
              `/bookings/calendar?start=${requestPeriod.start}&end=${requestPeriod.end}`,
            );
        if (!active) return;
        setData(response);
        setProperties(response.properties);
        setLastLoadedAt(new Date());
        hasLoadedData.current = true;
      } catch (requestError) {
        if (!active) return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : "無法讀取訂單日曆",
        );
      } finally {
        if (!active) return;
        if (initialLoad) setLoading(false);
        setRefreshing(false);
      }
    }

    void loadCalendar();
    return () => {
      active = false;
    };
  }, [reloadKey, requestPeriod.end, requestPeriod.start, setProperties]);

  useEffect(() => {
    if (!PAYMENT_SANDBOX) return;
    const order = new URLSearchParams(window.location.search).get("order");
    if (
      order &&
      openedOrderLink.current !== order &&
      data?.bookings.some((b) => b.id === order)
    ) {
      openedOrderLink.current = order;
      setSelectedId(order);
    }
  }, [data]);

  useEffect(() => {
    if (!PAYMENT_SANDBOX) return;
    const refresh = () => {
      if (!document.hidden) setReloadKey((value) => value + 1);
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const rawEditedBookings = useMemo(
    () =>
      (data?.bookings ?? [])
        .map((booking) => overlayEdits(booking, edits))
        .filter((booking): booking is CalendarBooking => booking !== null),
    [data, edits],
  );

  const editedBookings = useMemo(
    () => coalesceContiguousBookings(rawEditedBookings),
    [rawEditedBookings],
  );

  const allowedPropertyIds = useMemo(() => {
    if (!membership || membership.allProperties) return null;
    return new Set(membership.propertyIds);
  }, [membership]);

  const selectedProperties = useMemo(
    () =>
      (data?.properties ?? []).filter(
        (property) =>
          selectedPropertyIds.includes(property.id) &&
          (!allowedPropertyIds || allowedPropertyIds.has(property.id)),
      ),
    [allowedPropertyIds, data, selectedPropertyIds],
  );

  const propertyBookings = useMemo(
    () =>
      editedBookings.filter(
        (booking) =>
          selectedPropertyIds.includes(booking.property_id) &&
          (!allowedPropertyIds ||
            allowedPropertyIds.has(booking.property_id)) &&
          booking.reservation_status === "confirmed",
      ),
    [allowedPropertyIds, editedBookings, selectedPropertyIds],
  );

  const filteredBookings = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return propertyBookings;

    return propertyBookings.filter((booking) =>
      [
        booking.guest_name,
        booking.room_number,
        booking.order_id,
        booking.external_order_no,
        booking.property_name,
        booking.service_note,
        PLATFORM_LABELS[booking.platform] ?? booking.platform,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized)),
    );
  }, [propertyBookings, query]);

  const visibleRooms = useMemo(
    () =>
      (data?.rooms ?? []).filter(
        (room) =>
          selectedPropertyIds.includes(room.property_id) &&
          (!allowedPropertyIds || allowedPropertyIds.has(room.property_id)),
      ),
    [allowedPropertyIds, data, selectedPropertyIds],
  );

  const selectedBooking = useMemo(
    () => editedBookings.find((booking) => booking.id === selectedId) ?? null,
    [editedBookings, selectedId],
  );

  const selectedOrderSegments = useMemo(() => {
    if (!selectedBooking) return [];
    return editedBookings.filter(
      (booking) => booking.order_id === selectedBooking.order_id,
    );
  }, [editedBookings, selectedBooking]);

  const metrics = useMemo(() => {
    const relevant = filteredBookings.filter(
      (booking) =>
        booking.check_in < displayPeriod.end &&
        booking.check_out >= displayPeriod.start,
    );
    const occupied = relevant.filter(
      (booking) => overlapNights(booking, displayPeriod) > 0,
    );
    const orderCount = new Set(relevant.map((booking) => booking.order_id))
      .size;
    const arrivals = relevant.filter(
      (booking) =>
        booking.check_in >= displayPeriod.start &&
        booking.check_in < displayPeriod.end,
    ).length;
    const departures = relevant.filter(
      (booking) =>
        booking.check_out >= displayPeriod.start &&
        booking.check_out < displayPeriod.end,
    ).length;
    const roomNights = occupied.reduce(
      (sum, booking) => sum + overlapNights(booking, displayPeriod),
      0,
    );
    const amount = occupied.reduce((sum, booking) => {
      const totalNights = Math.max(
        1,
        dayDifference(booking.check_out, booking.check_in),
      );
      const visibleNights = overlapNights(booking, displayPeriod);
      return (
        sum + Math.round((booking.room_rate * visibleNights) / totalNights)
      );
    }, 0);

    return { orderCount, arrivals, departures, roomNights, amount };
  }, [displayPeriod, filteredBookings]);

  const handleVisibleMonthChange = useCallback((month: string) => {
    setVisibleMonth(month);
    setAnchorDate(month);
  }, []);

  function switchView(nextView: CalendarView) {
    if (nextView === view) return;
    if (nextView === "month") {
      const month = startOfMonth(anchorDate);
      setVisibleMonth(month);
      setMonthTarget(month);
    }
    setView(nextView);
  }

  function navigate(direction: -1 | 1) {
    if (view === "month") {
      const target = addMonths(visibleMonth, direction);
      setVisibleMonth(target);
      setMonthTarget(target);
      setAnchorDate(target);
      return;
    }
    if (view === "week") {
      setAnchorDate((value) => addDays(value, direction * 7));
      return;
    }
    setAnchorDate((value) => addDays(value, direction));
  }

  function goToToday() {
    const today = localTodayIso();
    setAnchorDate(today);
    if (view === "month") {
      const month = startOfMonth(today);
      setVisibleMonth(month);
      setMonthTarget(month);
    }
  }

  function selectDay(date: string) {
    setAnchorDate(date);
    setView("day");
  }

  function appendAudit(
    current: BookingAuditEvent[] | undefined,
    event: BookingAuditEvent,
  ): BookingAuditEvent[] {
    return [...(current ?? []), event];
  }

  function recordPayment(input: RecordPaymentInput) {
    if (!selectedBooking || !permissions.recordPayments) return;
    const orderId = selectedBooking.order_id;
    const existingPatch = edits.orders[orderId] ?? {};
    const existingPayments = existingPatch.payments ?? selectedBooking.payments;
    const payment: PaymentRecord = {
      id: uniqueId("payment"),
      amount: input.amount,
      payment_type: input.paymentType,
      payment_method: input.paymentMethod,
      received_at: input.receivedAt,
      created_at: new Date().toISOString(),
    };
    const payments = [...existingPayments, payment];
    const orderTotal = selectedOrderSegments.reduce(
      (sum, segment) => sum + segment.room_rate,
      0,
    );
    const paidAmount = payments.reduce((sum, item) => sum + item.amount, 0);
    const paymentStatus: PaymentStatus =
      paidAmount >= orderTotal ? "paid" : "deposit";
    const event: BookingAuditEvent = {
      id: uniqueId("audit"),
      action: "record_payment",
      summary: `登記${
        input.paymentType === "deposit"
          ? "訂金"
          : input.paymentType === "balance"
            ? "尾款"
            : "款項"
      } ${formatMoney(input.amount)}，收款日 ${input.receivedAt}`,
      occurred_at: new Date().toISOString(),
    };

    setEdits((current) => ({
      ...current,
      orders: {
        ...current.orders,
        [orderId]: {
          ...current.orders[orderId],
          payments,
          payment_status: paymentStatus,
          audit_log: appendAudit(current.orders[orderId]?.audit_log, event),
        },
      },
    }));
    toast.success("付款已登記", {
      description: `${formatMoney(input.amount)} · ${input.receivedAt}`,
    });
  }

  function updateBooking(input: UpdateBookingInput) {
    if (!selectedBooking || !permissions.editBookings) return;
    const conflict = editedBookings.find(
      (booking) =>
        booking.order_id !== selectedBooking.order_id &&
        booking.reservation_status === "confirmed" &&
        booking.property_id === selectedBooking.property_id &&
        booking.room_id === input.roomId &&
        booking.check_in < input.checkOut &&
        booking.check_out > input.checkIn,
    );

    if (conflict) {
      toast.error("無法修改：新日期已有訂單", {
        description: `${input.roomNumber} 房與 ${conflict.guest_name} 的住宿區間重疊。`,
      });
      return;
    }

    const event: BookingAuditEvent = {
      id: uniqueId("audit"),
      action: "update_booking",
      summary: `更新為 ${input.roomNumber} 房，${input.checkIn}–${input.checkOut}${
        permissions.viewPrices ? `，房費 ${formatMoney(input.roomRate)}` : ""
      }`,
      occurred_at: new Date().toISOString(),
    };
    const sourceIds = selectedBooking.source_segment_ids ?? [
      selectedBooking.id,
    ];
    const [primaryId, ...obsoleteIds] = sourceIds;

    setEdits((current) => {
      const segments = { ...current.segments };
      segments[primaryId] = {
        ...segments[primaryId],
        hidden: false,
        room_id: input.roomId,
        room_number: input.roomNumber,
        check_in: input.checkIn,
        check_out: input.checkOut,
        room_rate: input.roomRate,
        extra_guest_count: input.extraGuestCount,
        extra_bed_count: input.extraBedCount,
        pet_count: input.petCount,
        baby_supplies: input.babySupplies,
        service_note: input.serviceNote || null,
      };
      for (const id of obsoleteIds) {
        segments[id] = { ...segments[id], hidden: true };
      }

      return {
        orders: {
          ...current.orders,
          [selectedBooking.order_id]: {
            ...current.orders[selectedBooking.order_id],
            guest_name: input.guestName,
            audit_log: appendAudit(
              current.orders[selectedBooking.order_id]?.audit_log,
              event,
            ),
          },
        },
        segments,
      };
    });
    toast.success("訂單資料已修改");
  }

  function cancelBooking(reason: string) {
    if (!selectedBooking || !permissions.cancelBookings) return;
    const event: BookingAuditEvent = {
      id: uniqueId("audit"),
      action: "cancel_booking",
      summary: reason ? `取消預訂：${reason}` : "取消預訂",
      occurred_at: new Date().toISOString(),
    };

    setEdits((current) => ({
      ...current,
      orders: {
        ...current.orders,
        [selectedBooking.order_id]: {
          ...current.orders[selectedBooking.order_id],
          reservation_status: "cancelled",
          audit_log: appendAudit(
            current.orders[selectedBooking.order_id]?.audit_log,
            event,
          ),
        },
      },
    }));
    toast.success("預訂已取消", {
      description: "房況已在示範資料中釋出。",
    });
  }

  function closeMobileSearch() {
    setQuery("");
    setMobileSearchOpen(false);
  }

  return (
    <div className="pb-0 md:space-y-4 md:pb-8">
      {PAYMENT_SANDBOX && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-3 text-sm">
          <div>
            <p className="font-semibold">日曆與付款任務已連接</p>
            <p className="mt-1 text-xs text-muted-foreground">
              隔離測試 · 點選 301 房測試訂單，登記付款後會保存並更新日曆。
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/missions">交辦與查看任務</Link>
          </Button>
        </div>
      )}
      {mobileSearchOpen && (
        <div className="fixed inset-x-0 top-0 z-[70] flex h-14 items-center gap-2 border-b bg-background px-2 shadow-sm md:hidden">
          <Search className="ml-2 size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setQuery(event.target.value)
            }
            placeholder="搜尋客人、房號、需求或訂單編號"
            className="h-10 flex-1 border-0 bg-transparent px-1 text-base shadow-none focus-visible:ring-0"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={closeMobileSearch}
            aria-label="清除並關閉搜尋"
          >
            <X className="size-5" />
          </Button>
        </div>
      )}

      <section className="sticky top-0 z-30 hidden overflow-hidden rounded-2xl border bg-background/95 shadow-sm backdrop-blur md:block">
        <div className="flex flex-col gap-4 border-b px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                SF
              </span>
              Sweetfun Operations
            </div>
            <div className="mt-2 flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">
                訂單與房況日曆
              </h1>
              {effectiveRole !== "owner" && (
                <span className="rounded-full border bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  權限預覽
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <div className="flex rounded-lg border bg-muted/40 p-1">
              {(Object.keys(VIEW_LABELS) as CalendarView[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => switchView(option)}
                  className={cn(
                    "min-w-14 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    view === option
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {VIEW_LABELS[option]}
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setReloadKey((value) => value + 1)}
              disabled={loading || refreshing}
              aria-label="重新整理"
            >
              <RefreshCw
                className={cn(
                  "size-4",
                  (loading || refreshing) && "animate-spin",
                )}
              />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3 px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => navigate(-1)}
              aria-label="上一個區間"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="outline" onClick={goToToday}>
              今天
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => navigate(1)}
              aria-label="下一個區間"
            >
              <ChevronRight className="size-4" />
            </Button>
            <div className="ml-1 min-w-48 truncate text-base font-semibold">
              {displayPeriod.label}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative w-72">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setQuery(event.target.value)
                }
                placeholder="搜尋客人、房號、需求或訂單編號"
                className="bg-background pl-9"
              />
            </div>
            <span className="whitespace-nowrap text-[11px] text-muted-foreground">
              {lastLoadedAt
                ? `${lastLoadedAt.toLocaleTimeString("zh-TW", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })} 更新`
                : "等待同步"}
            </span>
          </div>
        </div>
      </section>

      <div className="hidden gap-3 sm:grid-cols-2 md:grid xl:grid-cols-5">
        <MetricCard
          icon={CalendarDays}
          label="訂單"
          value={metrics.orderCount}
        />
        <MetricCard icon={LogIn} label="入住" value={metrics.arrivals} />
        <MetricCard icon={LogOut} label="退房" value={metrics.departures} />
        <MetricCard icon={DoorOpen} label="房晚" value={metrics.roomNights} />
        <MetricCard
          icon={CircleDollarSign}
          label="房費"
          value={
            permissions.viewPrices ? formatMoney(metrics.amount) : "已隱藏"
          }
        />
      </div>

      <div className="hidden flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-2.5 text-xs text-muted-foreground shadow-xs lg:flex">
        <span className="font-semibold text-foreground">圖例</span>
        {Object.entries(PLATFORM_LABELS).map(([platform, label]) => (
          <span key={platform} className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-2.5 rounded-sm border",
                PLATFORM_STYLES[platform] ?? PLATFORM_STYLES.other,
              )}
            />
            {label}
          </span>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-3">
          {(Object.keys(PAYMENT_LABELS) as PaymentStatus[]).map((status) => (
            <span key={status} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "size-2 rounded-full",
                  PAYMENT_DOT_STYLES[status],
                )}
              />
              {PAYMENT_LABELS[status]}
            </span>
          ))}
        </span>
      </div>

      {DEMO_MODE && !PAYMENT_SANDBOX && (
        <div className="hidden rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 md:block">
          示範模式：可測試權限、付款、改期與取消；變更只保存在這台裝置。
        </div>
      )}

      {error && (
        <div className="m-2 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive md:m-0">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 shrink-0" />
            <span>{error}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            重試
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-[calc(100dvh-7rem)] items-center justify-center gap-2 bg-card text-sm text-muted-foreground md:min-h-96 md:rounded-xl md:border md:shadow-sm">
          <LoaderCircle className="size-4 animate-spin" />
          讀取訂單與房況中
        </div>
      ) : selectedProperties.length === 0 ? (
        <div className="m-2 rounded-xl border border-dashed bg-card px-4 py-16 text-center text-sm text-muted-foreground md:m-0">
          請從左上角選單選擇至少一間旅宿。
        </div>
      ) : (
        <>
          {view === "month" && (
            <div className="calendar-month-mobile-viewport -mx-2 md:mx-0">
              <MonthScroller
                months={MONTHS}
                targetMonth={monthTarget}
                bookings={filteredBookings}
                rooms={visibleRooms}
                properties={selectedProperties}
                onVisibleMonthChange={handleVisibleMonthChange}
                onSelectBooking={(booking) => setSelectedId(booking.id)}
                onSelectDay={selectDay}
              />
            </div>
          )}
          {view === "week" && (
            <div className="-mx-2 md:mx-0">
              <WeekCarousel
                anchorDate={anchorDate}
                bookings={filteredBookings}
                rooms={visibleRooms}
                properties={selectedProperties}
                onNavigateWeek={(offset) =>
                  setAnchorDate((value) => addDays(value, offset * 7))
                }
                onSelectBooking={(booking) => setSelectedId(booking.id)}
                onSelectDay={selectDay}
              />
            </div>
          )}
          {view === "day" && (
            <div className="-mx-2 p-2 md:mx-0 md:p-0">
              <DayView
                date={anchorDate}
                bookings={filteredBookings}
                rooms={visibleRooms}
                properties={selectedProperties}
                onSelectBooking={(booking) => setSelectedId(booking.id)}
                onSelectDay={selectDay}
              />
            </div>
          )}
        </>
      )}

      {!loading &&
        !error &&
        selectedProperties.length > 0 &&
        filteredBookings.length === 0 &&
        view !== "month" && (
          <div className="m-2 rounded-xl border border-dashed bg-card px-4 py-10 text-center text-sm text-muted-foreground md:m-0">
            這個區間沒有符合條件的訂單。
          </div>
        )}

      <BookingDetailsPanel
        booking={selectedBooking}
        orderSegments={selectedOrderSegments}
        rooms={data?.rooms ?? []}
        permissions={
          PAYMENT_SANDBOX
            ? { ...permissions, editBookings: false, cancelBookings: false }
            : permissions
        }
        paymentWorkspace={
          PAYMENT_SANDBOX && selectedBooking && permissions.viewPrices ? (
            <PaymentWorkspace
              key={selectedBooking.order_id}
              orderId={selectedBooking.order_id}
              readOnly={!permissions.recordPayments}
              onChange={() => setReloadKey((value) => value + 1)}
            />
          ) : undefined
        }
        onClose={() => setSelectedId(null)}
        onRecordPayment={recordPayment}
        onUpdateBooking={updateBooking}
        onCancelBooking={cancelBooking}
      />
    </div>
  );
}
