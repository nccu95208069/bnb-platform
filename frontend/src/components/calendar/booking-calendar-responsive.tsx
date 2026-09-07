"use client";

import { CalendarPrivacy } from "./calendar-privacy";
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
import { useCalendarHistory } from "./calendar-history";
import { AvailabilityCalendar } from "@/components/calendar/availability-calendar";
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
import { apiClient, ApiError } from "@/lib/api-client";
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

function SoldBookingCalendar() {
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
  const rolePermissions = useEffectivePermissions();
  const effectiveRole = useEffectiveRole();

  const anchorDate = useCalendarPreferences((state) => state.anchorDate);
  const setAnchorDate = useCalendarPreferences((state) => state.setAnchorDate);
  const [visibleMonth, setVisibleMonth] = useState(() =>
    startOfMonth(anchorDate),
  );
  const [todayRequest,setTodayRequest] = useState(0);
  const [monthTarget, setMonthTarget] = useState(() =>
    startOfMonth(anchorDate),
  );
  const [data, setData] = useState<CalendarResponse | null>(null);
  const permissions = { ...rolePermissions, viewPrices: rolePermissions.viewPrices && !data?.price_hidden };
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedId = useCalendarPreferences((s) => s.selectedBookingId);
  const setSelectedId = useCalendarPreferences((s) => s.setSelectedBookingId);
  const historyRevision = useCalendarPreferences((s) => s.historyRevision);
  useEffect(() => {
    const month = startOfMonth(useCalendarPreferences.getState().anchorDate);
    setVisibleMonth(month);
    setMonthTarget(month);
  }, [historyRevision]);
  const [reloadKey, setReloadKey] = useState(0);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [edits, setEdits] = useState<DemoEditState>(EMPTY_EDITS);
  const [editsHydrated, setEditsHydrated] = useState(false);
  const hasLoadedData = useRef(false);
  const previousView = useRef<CalendarView>(view);
  const handledNavigationRequest = useRef(navigationRequest?.id ?? 0);

  const requestPeriod = useMemo(
    () => fetchPeriod(anchorDate, query.trim() ? "month" : view),
    [anchorDate, view, query],
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
      new URLSearchParams(window.location.search).has("order") &&
      !new URLSearchParams(window.location.search).has("view")
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
      setTodayRequest(value=>value+1);
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
  }, [navigationRequest, view, visibleMonth, setAnchorDate]);

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
        if (requestError instanceof ApiError && [401,403].includes(requestError.status)) { setData(null); setSelectedId(null); void initializeAccess(); }
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
  }, [reloadKey, requestPeriod.end, requestPeriod.start, setProperties, setSelectedId, initializeAccess, membership?.id, membership?.role]);

  useEffect(() => {
    if (!PAYMENT_SANDBOX && !data?.source?.automatic_sync) return;
    const refresh = () => {
      if (!document.hidden) setReloadKey((value) => value + 1);
    };
    const timer = setInterval(refresh, PAYMENT_SANDBOX ? 5000 : 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [data?.source?.automatic_sync]);

  const unavailableSelectedSource = data?.source_errors?.some(item => selectedPropertyIds.includes(item.property_id) && (!allowedPropertyIds || allowedPropertyIds.has(item.property_id)));

  const rawEditedBookings = useMemo(
    () =>
      (data?.bookings ?? [])
        .map((booking) => data?.source?.read_only ? booking : overlayEdits(booking, edits))
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
        ...(booking.guest_name_sources ?? []),
        ...(booking.guest_remarks ?? []).flatMap(r => [r.label, r.source]),
        booking.notes,
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
    const orderCount = new Set(relevant.filter(b => !b.source_conflict).map((booking) => booking.order_id))
      .size;
    const arrivals = relevant.filter(
      (booking) =>
        !booking.source_conflict && booking.check_in >= displayPeriod.start &&
        booking.check_in < displayPeriod.end,
    ).length;
    const departures = relevant.filter(
      (booking) =>
        !booking.source_conflict && booking.check_out >= displayPeriod.start &&
        booking.check_out < displayPeriod.end,
    ).length;
    const roomNights = occupied.reduce(
      (sum, booking) => sum + overlapNights(booking, displayPeriod),
      0,
    );
    const amount = occupied.reduce((sum, booking) => {
      if (booking.source_conflict) return sum;
      if (booking.nightly_amounts) return sum + booking.nightly_amounts
        .filter(n => n.date >= displayPeriod.start && n.date < displayPeriod.end)
        .reduce((total, n) => total + n.amount, 0);
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

  const handleVisibleMonthChange = useCallback(
    (month: string) => {
      setVisibleMonth(month);
      setAnchorDate((current) => startOfMonth(current) === month ? current : month);
    },
    [setAnchorDate],
  );

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
    setTodayRequest(value=>value+1);
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
                  })} ${data?.source ? "載入" : "更新"}`
                : "等待載入"}
            </span>
          </div>
        </div>
      </section>

      {data?.source_errors?.filter(item => selectedPropertyIds.includes(item.property_id) && (!allowedPropertyIds || allowedPropertyIds.has(item.property_id))).map(item => (
        <div key={item.property_id} role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {item.label}暫時無法載入，相關房況與統計尚無法確認。其他民宿仍可正常查看。
        </div>
      ))}

      <div className="hidden gap-3 sm:grid-cols-2 md:grid xl:grid-cols-5">
        <MetricCard
          icon={CalendarDays}
          label={data?.source ? "訂單紀錄" : "訂單"}
          value={unavailableSelectedSource ? "—" : metrics.orderCount}
        />
        <MetricCard icon={LogIn} label="入住" value={unavailableSelectedSource ? "—" : metrics.arrivals} />
        <MetricCard icon={LogOut} label="退房" value={unavailableSelectedSource ? "—" : metrics.departures} />
        <MetricCard icon={DoorOpen} label="房晚" value={unavailableSelectedSource ? "—" : metrics.roomNights} />
        <MetricCard
          icon={CircleDollarSign}
          label="房費"
          value={
            unavailableSelectedSource ? "—" : permissions.viewPrices ? formatMoney(metrics.amount) : "已隱藏"
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

      {DEMO_MODE && !PAYMENT_SANDBOX && !data?.source && (
        <div className="hidden rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 md:block">
          示範模式：可測試權限、付款、改期與取消；變更只保存在這台裝置。
        </div>
      )}

      {data?.guest_access?.available && <CalendarPrivacy authenticated={data.guest_access.authenticated} />}

      {(data?.sources ?? (data?.source ? [{ property_id: "sweetfun", source: data.source, summary: data.source_summary }] : []))
        .filter(item => selectedPropertyIds.includes(item.property_id) && (!allowedPropertyIds || allowedPropertyIds.has(item.property_id)))
        .map(({ property_id, source, summary }) => (
        <div key={property_id} className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-[11px] text-sky-950" role="status">
          <details>
            <summary className="cursor-pointer py-0.5">
              <span className="font-medium">{source.label}</span> · 唯讀 · {source.automatic_sync && source.sync ? ({ healthy: "同步正常", confirming: "確認變更中", waiting: "等待首次檢查", error: "檢查失敗，保留上次資料", stale: "資料可能過期" })[source.sync.status] : "尚未自動同步"}
              {source.sync?.last_checked_at && <span className="ml-1 text-sky-800">{new Date(source.sync.last_checked_at).toLocaleTimeString("zh-TW", {timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false})}</span>}
            </summary>
            <div className="mt-1 space-y-1 border-t border-sky-200 pt-1.5">
          <p className="font-medium">{source.label} · {data?.guest_access?.authenticated ? "私人唯讀檢視" : "匿名唯讀快照"} · {new Date(source.observed_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}</p>
          {source.automatic_sync && source.sync ? <div aria-live="polite">
            <p>{({ waiting: "監控已設定，等待首次檢查。", healthy: "每分鐘自動檢查訂房表。", confirming: "發現資料變更，等待下一次檢查確認；目前保留上次資料。", error: "訂房表檢查失敗，目前保留上次資料，系統會自動重試。", stale: "已超過 5 分鐘未完成檢查，目前顯示上次資料。" })[source.sync.status]}</p>
            <p>最後檢查：{source.sync.last_checked_at ? new Date(source.sync.last_checked_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }) : "尚未完成"} · 比對 {source.sync.cutoff} 起的入住紀錄與所有未來訂單。</p>
          </div> : <p>尚未啟用自動同步。</p>}
          <p>已付清指客人已付清，OTA 收款與旅宿入帳尚未記錄。</p>
          <p>訂單編號可空白，使用唯一 ID 識別每列；跨列連住需共同編號。</p>
            </div>
          </details>
          {(summary?.new_issue_rows ?? 0) > 0 && <p className="mt-1">新增或變更的問題涉及 {summary?.new_issue_rows} 列，相關房況待核對。</p>}
        </div>
      ))}

      {query.trim() && <section className="m-2 rounded-xl border bg-card p-3 md:m-0" aria-label="搜尋結果">
        <h2 className="text-sm font-semibold">搜尋結果 · {filteredBookings.length} 筆（2025–2027）</h2>
        <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
          {filteredBookings.slice(0,50).map(booking=><button key={booking.id} className="block w-full rounded border p-2 text-left text-sm hover:bg-muted" onClick={()=>setSelectedId(booking.id)}>
            <span className="block">{booking.check_in}–{booking.check_out} · {booking.room_number} · {booking.guest_name}</span>
            <span className="text-xs">{booking.guest_remarks?.map(r=>r.label).join(" · ")}</span>
          </button>)}
          {!filteredBookings.length && <p className="text-sm text-muted-foreground">沒有符合的訂單。</p>}
          {filteredBookings.length>50 && <p className="text-xs">先顯示 50 筆，請增加關鍵字縮小範圍。</p>}
        </div>
      </section>}
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
                targetDate={todayRequest ? localTodayIso() : undefined}
                targetRevision={todayRequest}
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
          data?.source?.read_only
            ? { ...permissions, editBookings: false, cancelBookings: false, recordPayments: false }
            : PAYMENT_SANDBOX
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

export function BookingCalendarResponsive() {
  const mode = useCalendarPreferences((state) => state.mode);
  const setMode = useCalendarPreferences((state) => state.setMode);
  const ready = useCalendarHistory();
  const { viewPrices } = useEffectivePermissions();
  const selectedPropertyIds = useCalendarPreferences((state) => state.selectedPropertyIds);
  const membership = useAccessControl((state) => state.membership);
  const sweetfunAllowed = PAYMENT_SANDBOX || !!membership?.allProperties || !!membership?.propertyIds.includes("sweetfun");
  const showUnsold = viewPrices && sweetfunAllowed && (selectedPropertyIds.length === 0 || selectedPropertyIds.includes("sweetfun"));
  useEffect(() => { if (ready && !showUnsold && mode === "unsold") setMode("sold"); }, [ready, showUnsold, mode, setMode]);
  if (!ready)
    return <p className="p-4 text-sm text-muted-foreground">讀取日曆…</p>;
  return (
    <div>
      {showUnsold && (
        <div className="sticky top-14 z-40 mb-1 flex justify-end bg-background/95 py-1 backdrop-blur md:top-0">
          <div
            className="inline-flex gap-1 rounded-xl border bg-muted/40 p-1"
            role="group"
            aria-label="切換已售與未售"
          >
            {(["sold", "unsold"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={mode === value ? "default" : "ghost"}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                }}
              >
                {value === "sold" ? "已售訂單" : "未售房況"}
              </Button>
            ))}
          </div>
        </div>
      )}
      {mode === "unsold" && showUnsold ? (
        <AvailabilityCalendar />
      ) : (
        <SoldBookingCalendar />
      )}
    </div>
  );
}
