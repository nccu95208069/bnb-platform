"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useCalendarPreferences } from "./calendar-preferences";
import {
  addDays,
  addMonths,
  currentPeriod,
  formatMonthLabel,
  localTodayIso,
  startOfMonth,
  WEEKDAY_LABELS,
} from "./calendar-utils";
import {
  availabilityApi,
  availabilityError,
  channelLabels,
  inventoryLabels,
  policyLabels,
  priceText,
  type AvailabilityResult,
  type Channel,
  type RoomNight,
  type PriceQuote,
} from "@/lib/availability";
import { paymentApi, type Mission } from "@/lib/payment-workflow";
import {
  useEffectivePermissions,
  useEffectiveRole,
} from "@/lib/access-control";
import { cn } from "@/lib/utils";

const stateStyles: Record<string, string> = {
  available: "border-emerald-200 bg-emerald-50/70 text-emerald-950",
  held: "border-amber-200 bg-amber-50 text-amber-950",
  maintenance: "border-slate-200 bg-slate-100 text-slate-600",
  blocked: "border-slate-200 bg-slate-100 text-slate-600",
  unknown: "border-amber-300 bg-amber-50 text-amber-900",
  conflict: "border-red-200 bg-red-50 text-red-900",
  sold: "border-border bg-muted/40 text-muted-foreground",
  past: "border-transparent bg-muted/30 text-muted-foreground",
};
function PricePair({
  cell,
  compact = false,
  hidePrice = false,
}: {
  cell: RoomNight;
  compact?: boolean;
  hidePrice?: boolean;
}) {
  const p = cell.pricing;
  if (cell.state !== "available")
    return <span className="text-xs">{inventoryLabels[cell.state]}</span>;
  if (hidePrice || !p) return <span className="text-xs">可售</span>;
  const delta =
    p.current_price != null && p.suggested_price != null
      ? p.suggested_price - p.current_price
      : null;
  return (
    <div className={compact ? "space-y-0.5" : "space-y-1"}>
      <p
        className={
          compact
            ? "text-[11px] font-semibold tabular-nums sm:text-sm"
            : "text-xl font-semibold tabular-nums"
        }
      >
        {priceText(p.current_price)}
      </p>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          {p.suggested_price != null
            ? `建議 ${priceText(p.suggested_price)}${delta ? `（${delta > 0 ? "+" : ""}${delta}）` : ""}`
            : (policyLabels[p.exclusion ?? p.policy] ?? "尚無建議")}
        </p>
      )}
    </div>
  );
}

export function AvailabilityCalendar() {
  const view = useCalendarPreferences((s) => s.view),
    setView = useCalendarPreferences((s) => s.setView);
  const anchor = useCalendarPreferences((s) => s.anchorDate),
    setAnchor = useCalendarPreferences((s) => s.setAnchorDate);
  const navigation = useCalendarPreferences((s) => s.navigationRequest),
    setPeriodLabel = useCalendarPreferences((s) => s.setMobilePeriodLabel);
  const setProperties = useCalendarPreferences((s) => s.setProperties);
  const search = useCalendarPreferences((s) => s.searchQuery),
    setSearch = useCalendarPreferences((s) => s.setSearchQuery);
  const searchOpen = useCalendarPreferences((s) => s.mobileSearchOpen),
    setSearchOpen = useCalendarPreferences((s) => s.setMobileSearchOpen);
  const permissions = useEffectivePermissions(),
    role = useEffectiveRole();
  const canPrice = permissions.viewPrices,
    canHandoff = role === "owner" || role === "admin";
  const channel = useCalendarPreferences((s) => s.availabilityChannel);
  const setChannel = useCalendarPreferences((s) => s.setAvailabilityChannel);
  const room = useCalendarPreferences((s) => s.availabilityRoom);
  const setRoom = useCalendarPreferences((s) => s.setAvailabilityRoom);
  const cycle = useCalendarPreferences((s) => s.availabilityCycle);
  const setCycle = useCalendarPreferences((s) => s.setAvailabilityCycle);
  const onlyAvailable = useCalendarPreferences((s) => s.availabilityOnly);
  const setOnlyAvailable = useCalendarPreferences((s) => s.setAvailabilityOnly);
  const expandedWeeks = useCalendarPreferences((s) => s.expandedWeeks);
  const setExpandedWeeks = useCalendarPreferences((s) => s.setExpandedWeeks);
  const [data, setData] = useState<AvailabilityResult | null>(null),
    [error, setError] = useState("");
  const [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  const selected = useCalendarPreferences((s) => s.availabilitySelection);
  const setSelected = useCalendarPreferences((s) => s.setAvailabilitySelection);
  const [quote, setQuote] = useState<PriceQuote | null>(null),
    [nights, setNights] = useState("1");
  const preview = useCalendarPreferences((s) => s.pricingPreview);
  const setPreview = useCalendarPreferences((s) => s.setPricingPreview);
  const [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const goal = useCalendarPreferences((s) => s.pricingGoal);
  const setGoal = useCalendarPreferences((s) => s.setPricingGoal);
  const mission = useCalendarPreferences((s) => s.pricingMission);
  const setMission = useCalendarPreferences((s) => s.setPricingMission);
  const actionLock = useRef(false);
  const pendingRequest = useRef<Record<string, unknown> | null>(null);
  const handledNavigation = useRef(navigation?.id ?? 0);
  const period = useMemo(
    () =>
      view === "month"
        ? {
            start: startOfMonth(anchor),
            end: addMonths(startOfMonth(anchor), 1),
            label: formatMonthLabel(anchor),
          }
        : currentPeriod(anchor, view),
    [anchor, view],
  );
  const query = useMemo(
    () => ({
      start: period.start,
      end: period.end,
      rooms: room === "all" ? [] : [room],
      channel,
      demo_cycle: cycle,
    }),
    [period.start, period.end, room, channel, cycle],
  );
  useEffect(() => {
    setPeriodLabel(period.label);
  }, [period.label, setPeriodLabel]);
  useEffect(() => {
    if (!navigation || navigation.id <= handledNavigation.current) return;
    handledNavigation.current = navigation.id;
    if (navigation.action === "today") setAnchor(localTodayIso());
    else {
      const direction = navigation.action === "previous" ? -1 : 1;
      setAnchor((a) =>
        view === "month"
          ? addMonths(a, direction)
          : addDays(a, direction * (view === "week" ? 7 : 1)),
      );
    }
  }, [navigation, view, setAnchor]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    availabilityApi
      .check(query)
      .then((result) => {
        if (!active) return;
        setData(result);
        setProperties([
          {
            id: result.property_id,
            name: "Sweetfun 測試旅宿",
            short_name: "Sweetfun",
            location: "合成示範",
            room_count: 6,
            color: "emerald",
          },
        ]);
      })
      .catch((e) => {
        if (active) setError(availabilityError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [query, refresh, setProperties]);
  const cells = useMemo(() => data?.cells ?? [], [data]);
  const byKey = useMemo(
    () => new Map(cells.map((c) => [`${c.date}|${c.room}`, c])),
    [cells],
  );
  const selectedCell = selected
    ? byKey.get(`${selected.date}|${selected.room}`)
    : undefined;
  const hidePrice = !canPrice || !!data?.price_hidden;
  const days = useMemo(() => {
    const result = [];
    for (let d = period.start; d < period.end; d = addDays(d, 1))
      result.push(d);
    return result;
  }, [period]);
  const monthDays = useMemo(() => {
    const weekday = (new Date(period.start + "T12:00:00Z").getUTCDay() + 6) % 7;
    const first = addDays(period.start, -weekday);
    return Array.from(
      { length: Math.ceil((weekday + days.length) / 7) * 7 },
      (_, i) => addDays(first, i),
    );
  }, [period.start, days.length]);
  function matches(c: RoomNight) {
    return (
      (!onlyAvailable || c.state === "available") &&
      (!search.trim() ||
        `${c.room} ${c.date} ${inventoryLabels[c.state]} ${c.reason}`.includes(
          search.trim(),
        ))
    );
  }
  function openCell(c: RoomNight) {
    setSelected({ room: c.room, date: c.date });
    setQuote(null);
    setNights("1");
    setActionError("");
  }
  function selectDay(day: string) {
    setAnchor(day);
    setView("day");
  }
  function move(direction: number) {
    setAnchor((a) =>
      view === "month"
        ? addMonths(a, direction)
        : addDays(a, direction * (view === "week" ? 7 : 1)),
    );
  }
  async function action(fn: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setActionError("");
    try {
      await fn();
    } catch (e) {
      setActionError(availabilityError(e));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  async function previewRange(single?: RoomNight) {
    if (!data) return;
    let source = data;
    const selection = single
      ? {
          start: single.date,
          end: addDays(single.date, 1),
          rooms: [single.room],
          channel,
          demo_cycle: cycle,
        }
      : data.query;
    if (single) source = await availabilityApi.check(selection);
    const result = await availabilityApi.preview({
      ...selection,
      expected_snapshot: source.snapshot_id,
    });
    const key = crypto.randomUUID();
    setPreview({ ...result, review_key: key });
    setMission(null);
    pendingRequest.current = null;
  }
  async function handoff() {
    if (!preview) return;
    if (pendingRequest.current?.idempotency_key !== preview.review_key)
      pendingRequest.current = null;
    pendingRequest.current ??= {
      ...preview.query,
      expected_snapshot: preview.snapshot_id,
      goal,
      idempotency_key: preview.review_key,
    };
    const result = await paymentApi<Mission>(
      "/pricing-missions",
      pendingRequest.current,
    );
    setMission(result);
  }
  const previewMission =
    mission &&
    (mission.request as Record<string, unknown>).idempotency_key ===
      preview?.review_key
      ? mission
      : null;
  const rooms = data?.rooms ?? [];
  const periodReady =
    !loading &&
    !error &&
    data?.query.start === query.start &&
    data?.query.end === query.end &&
    data?.query.channel === channel &&
    data?.query.demo_cycle === cycle &&
    JSON.stringify(data?.query.rooms) === JSON.stringify(query.rooms);
  const focusedError = actionError && !preview && !selectedCell;
  return (
    <div className="space-y-4 pb-8">
      {searchOpen && (
        <div className="fixed inset-x-0 top-0 z-[70] flex h-14 gap-2 border-b bg-background p-2 md:hidden">
          <Input
            aria-label="搜尋未售房況"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋房號、維修、可售"
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="關閉搜尋"
            onClick={() => setSearchOpen(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="hidden items-center gap-2 text-xs font-medium text-emerald-700 sm:flex">
            <CalendarDays className="size-4" />
            房況與售價
          </p>
          <h1 className="mt-1 text-xl font-semibold sm:text-2xl">未售房況</h1>
          <p className="mt-1 hidden text-sm text-muted-foreground sm:block">
            先看可售房晚，再核對價格與調價建議。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border p-1">
            {(["month", "week", "day"] as const).map((v) => (
              <Button
                key={v}
                size="sm"
                variant={view === v ? "secondary" : "ghost"}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {{ month: "月", week: "週", day: "日" }[v]}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            aria-label="更新未售房況"
            disabled={loading}
            onClick={() => setRefresh((v) => v + 1)}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3">
        <div className="hidden items-center gap-1 md:flex">
          <Button
            variant="ghost"
            size="icon"
            aria-label="上一個未售區間"
            onClick={() => move(-1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAnchor(localTodayIso())}
          >
            今天
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="下一個未售區間"
            onClick={() => move(1)}
          >
            <ChevronRight className="size-4" />
          </Button>
          <span className="ml-2 text-sm font-semibold">{period.label}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={room} onValueChange={setRoom}>
            <SelectTrigger className="w-28" aria-label="篩選房間">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部房間</SelectItem>
              {["101", "102", "201", "202", "301", "302"].map((r) => (
                <SelectItem key={r} value={r}>
                  {r} 房
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={channel}
            onValueChange={(v) => setChannel(v as Channel)}
          >
            <SelectTrigger className="w-32" aria-label="售價通路">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(channelLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[
          ["可售房晚", data?.counts.available ?? 0, "text-emerald-700"],
          [
            "暫留・封房・維修",
            (data?.counts.held ?? 0) +
              (data?.counts.blocked ?? 0) +
              (data?.counts.maintenance ?? 0),
            "text-muted-foreground",
          ],
          [
            "待確認・衝突",
            (data?.counts.unknown ?? 0) + (data?.counts.conflict ?? 0),
            "text-amber-700",
          ],
        ].map(([label, count, color]) => (
          <Card key={label} className="gap-0 py-0 shadow-none">
            <CardContent className="p-3 sm:p-4">
              <p className="text-[10px] text-muted-foreground sm:text-xs">
                {label}
              </p>
              <p
                className={cn("mt-1 text-xl font-semibold sm:text-2xl", color)}
              >
                {loading ? "—" : count}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={onlyAvailable ? "outline" : "secondary"}
            onClick={() => setOnlyAvailable(false)}
          >
            可售與待處理
          </Button>
          <Button
            size="sm"
            variant={onlyAvailable ? "secondary" : "outline"}
            onClick={() => setOnlyAvailable(true)}
          >
            只看可售
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative hidden sm:block">
            <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="h-9 w-44 pl-8"
              aria-label="搜尋房號或狀態"
              placeholder="房號或狀態"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {canPrice && (
            <Button
              size="sm"
              disabled={!periodReady || busy}
              onClick={() => void action(() => previewRange())}
            >
              <Sparkles className="size-4" />
              預演此區間調價
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="text-emerald-600">●</span> 可售
        </span>
        <span>
          <span className="text-amber-500">●</span> 暫留／待確認
        </span>
        <span>● 封房／維修</span>
        <span className="hidden items-center gap-1 sm:flex">
          <ShieldCheck className="size-3" />
          價格保護，不代表不能訂房
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
        <div className="mr-auto">
          <p className="text-xs font-medium sm:text-sm">房價約每 3–5 天更新</p>
          <p className="mt-1 hidden text-xs text-muted-foreground sm:block">
            約每 3–5 天調整未售房晚，涵蓋至少未來 90 天。每晚、每通路各有價格。
          </p>
        </div>
        <Select
          value={String(cycle)}
          onValueChange={(v) => {
            setCycle(Number(v) as 1 | 2);
            setQuote(null);
            setPreview(null);
          }}
        >
          <SelectTrigger className="w-44" aria-label="示範調價輪次">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">示範第 1 輪價格</SelectItem>
            <SelectItem value="2">模擬第 2 輪價格</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-950">
        假資料預覽 · {channelLabels[channel]}{" "}
        示範售價，建議未發布。尚未接入正式房況與定價引擎。
      </p>
      {(error || focusedError) && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error || actionError}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRefresh((v) => v + 1)}
          >
            重新查核
          </Button>
        </div>
      )}
      {loading ? (
        <div className="flex min-h-72 items-center justify-center gap-2 text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          查核房況與價格中
        </div>
      ) : (
        !error &&
        data && (
          <>
            {view === "month" && (
              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="grid grid-cols-7 border-b bg-muted/30">
                  {WEEKDAY_LABELS.map((d) => (
                    <div
                      key={d}
                      className="p-2 text-center text-xs text-muted-foreground"
                    >
                      {d}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7">
                  {monthDays.map((day, index) => {
                    const weekKey = monthDays[Math.floor(index / 7) * 7];
                    const expanded = expandedWeeks.includes(weekKey);
                    const inMonth = day >= period.start && day < period.end;
                    const dayCells = cells.filter((c) => c.date === day);
                    const shown = dayCells.filter(
                      (c) =>
                        c.state !== "sold" && c.state !== "past" && matches(c),
                    );
                    const count = dayCells.filter(
                      (c) => c.state === "available",
                    ).length;
                    return (
                      <Fragment key={day}>
                        <div
                          data-unsold-date={day}
                          className={cn(
                            "min-h-28 border-b border-r p-1 sm:min-h-44 sm:p-2",
                            !inMonth && "bg-muted/25",
                          )}
                        >
                          <button
                            className="flex w-full items-center justify-between pb-1 text-left text-xs"
                            aria-label={`${day} 查看日曆`}
                            onClick={() => selectDay(day)}
                          >
                            <span
                              className={cn(
                                "flex size-6 items-center justify-center rounded-full",
                                day === localTodayIso()
                                  ? "bg-primary text-primary-foreground"
                                  : "",
                              )}
                            >
                              {Number(day.slice(-2))}
                            </span>
                            {inMonth && (
                              <span className="hidden text-[10px] text-muted-foreground sm:inline">
                                可售 {count}
                              </span>
                            )}
                          </button>
                          {shown
                            .slice(0, expanded ? shown.length : 3)
                            .map((c, i) => (
                              <button
                                key={c.room}
                                title={`${c.date} ${c.room} 房 ${inventoryLabels[c.state]}`}
                                aria-label={`${c.date} ${c.room} 房 ${inventoryLabels[c.state]} ${hidePrice ? "" : priceText(c.pricing?.current_price)}`}
                                onClick={() => openCell(c)}
                                className={cn(
                                  "mb-1 w-full rounded-md border px-1 py-1 text-left sm:flex sm:items-center sm:justify-between",
                                  stateStyles[c.state],
                                  !expanded && i === 2 && "hidden sm:flex",
                                )}
                              >
                                <span className="flex items-center gap-0.5 text-[10px] font-medium sm:text-xs">
                                  {c.room}
                                  {c.pricing &&
                                    !c.pricing.eligible &&
                                    c.state === "available" && (
                                      <ShieldCheck className="hidden size-3 sm:inline" />
                                    )}
                                </span>
                                <PricePair
                                  cell={c}
                                  compact
                                  hidePrice={hidePrice}
                                />
                              </button>
                            ))}
                          {!expanded && shown.length > 2 && (
                            <button
                              className="w-full text-left text-[9px] text-muted-foreground sm:hidden"
                              aria-expanded={false}
                              aria-label={`${day} 展開其餘房間`}
                              onClick={() =>
                                setExpandedWeeks((v) => [...v, weekKey])
                              }
                            >
                              另 {shown.length - 2} 房
                            </button>
                          )}
                          {!expanded && shown.length > 3 && (
                            <button
                              className="hidden w-full text-left text-[10px] text-muted-foreground sm:block"
                              aria-expanded={false}
                              aria-label={`${day} 展開其餘房間`}
                              onClick={() =>
                                setExpandedWeeks((v) => [...v, weekKey])
                              }
                            >
                              另 {shown.length - 3} 房
                            </button>
                          )}
                          {inMonth && shown.length === 0 && (
                            <p className="pt-2 text-[10px] text-muted-foreground">
                              {day < data.asof
                                ? "已過期"
                                : search.trim()
                                  ? "無符合條件"
                                  : onlyAvailable
                                    ? "無可售"
                                    : "無未售"}
                            </p>
                          )}
                        </div>
                        {expanded && index % 7 === 6 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="col-span-7 h-8 w-full rounded-none border-b bg-muted/20 text-xs"
                            aria-label={`${weekKey} 收合這一列`}
                            aria-expanded={true}
                            onClick={() =>
                              setExpandedWeeks((v) =>
                                v.filter((w) => w !== weekKey),
                              )
                            }
                          >
                            收合這一列
                          </Button>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            )}
            {view === "week" && (
              <div
                className="overflow-auto rounded-xl border bg-card"
                role="region"
                aria-label="未售週曆，可橫向捲動"
                tabIndex={0}
              >
                <table className="w-full min-w-[840px] border-collapse text-sm">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 w-20 border-b bg-card p-3 text-left">
                        房間
                      </th>
                      {days.map((day) => (
                        <th key={day} className="min-w-28 border-b p-2">
                          <button onClick={() => selectDay(day)}>
                            {day.slice(5)}
                            <span className="ml-1 text-xs text-muted-foreground">
                              {
                                ["日", "一", "二", "三", "四", "五", "六"][
                                  new Date(day + "T12:00Z").getUTCDay()
                                ]
                              }
                            </span>
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rooms.map((r) => (
                      <tr key={r}>
                        <th className="sticky left-0 z-10 border-b bg-card p-3 text-left">
                          {r}
                        </th>
                        {days.map((day) => {
                          const c = byKey.get(`${day}|${r}`);
                          return (
                            <td key={day} className="border-b border-l p-1">
                              {c && (
                                <button
                                  className={cn(
                                    "min-h-24 w-full rounded-lg border p-2 text-left",
                                    stateStyles[c.state],
                                    !matches(c) && "opacity-35",
                                  )}
                                  onClick={() => openCell(c)}
                                  aria-label={`${day} ${r} 房 ${inventoryLabels[c.state]}`}
                                >
                                  <PricePair cell={c} hidePrice={hidePrice} />
                                  {c.pricing?.policy !== "tiered" &&
                                    c.state === "available" && (
                                      <p className="mt-1 truncate text-[10px]">
                                        {policyLabels[c.pricing?.policy ?? ""]}
                                      </p>
                                    )}
                                </button>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {view === "day" && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {cells.filter(matches).map((c) => (
                  <Card key={c.room} className="overflow-hidden py-0">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <h2 className="text-lg font-semibold">{c.room} 房</h2>
                        <Badge
                          variant="outline"
                          className={stateStyles[c.state]}
                        >
                          {inventoryLabels[c.state]}
                        </Badge>
                      </div>
                      <div className="my-4">
                        <PricePair cell={c} hidePrice={hidePrice} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {c.state === "available"
                          ? `最多 ${c.max_guests} 人 · 最少 ${c.minimum_nights} 晚`
                          : c.reason}
                      </p>
                      <Button
                        variant="outline"
                        className="mt-4 w-full"
                        onClick={() => openCell(c)}
                      >
                        查看房晚與價格
                        <ArrowRight className="size-4" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
                {cells.filter(matches).length === 0 && (
                  <p className="py-10 text-sm text-muted-foreground">
                    沒有符合條件的房晚。
                  </p>
                )}
              </div>
            )}
          </>
        )
      )}
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>
              {selected?.room} 房 · {selected?.date}
            </SheetTitle>
            <SheetDescription>房況、通路售價與調價資格</SheetDescription>
          </SheetHeader>
          {selectedCell && (
            <div className="space-y-5 px-4 pb-8">
              <Badge
                variant="outline"
                className={stateStyles[selectedCell.state]}
              >
                {inventoryLabels[selectedCell.state]}
              </Badge>
              <p className="text-sm">{selectedCell.reason}</p>
              {!hidePrice && selectedCell.pricing && (
                <>
                  <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/40 p-3">
                    {[
                      ["基準價", selectedCell.pricing.base_price],
                      [
                        `${channelLabels[channel]} 目前價`,
                        selectedCell.pricing.current_price,
                      ],
                      ["建議・未發布", selectedCell.pricing.suggested_price],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <p className="text-[10px] text-muted-foreground">
                          {label}
                        </p>
                        <p className="mt-1 text-base font-semibold">
                          {value == null ? "—" : priceText(Number(value))}
                        </p>
                      </div>
                    ))}
                  </div>
                  <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <CircleHelp className="size-4 shrink-0" />
                    價格版本 {selectedCell.pricing.price_version}
                    。客人前台實付尚未核對，通路促銷可能使實付與系統價不同。
                  </p>
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="flex items-center gap-2 font-medium">
                      <ShieldCheck className="size-4" />
                      {
                        policyLabels[
                          selectedCell.pricing.exclusion ??
                            selectedCell.pricing.policy
                        ]
                      }
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selectedCell.pricing.eligible
                        ? "可加入調價預演，仍需原引擎產生正式計畫。"
                        : "此格不進一般調價清單，仍依實際房況決定是否可訂。"}
                    </p>
                  </div>
                  <section className="space-y-2 border-t pt-4">
                    <h3 className="font-semibold">查連住與總價</h3>
                    <p className="text-xs text-muted-foreground">
                      入住 {selectedCell.date} · 退房{" "}
                      {addDays(
                        selectedCell.date,
                        Math.max(1, Math.min(30, Number(nights) || 1)),
                      )}{" "}
                      · 雙人住宿
                    </p>
                    <div className="flex gap-2">
                      <Label className="sr-only" htmlFor="stay-nights">
                        住宿晚數
                      </Label>
                      <Input
                        id="stay-nights"
                        type="number"
                        min="1"
                        max="30"
                        value={nights}
                        onChange={(e) => {
                          setNights(e.target.value);
                          setQuote(null);
                        }}
                        className="w-20"
                      />
                      <Button
                        variant="outline"
                        disabled={
                          busy ||
                          !Number.isInteger(Number(nights)) ||
                          Number(nights) < 1 ||
                          Number(nights) > 30
                        }
                        onClick={() =>
                          void action(async () => {
                            setQuote(
                              await availabilityApi.price({
                                start: selectedCell.date,
                                end: addDays(selectedCell.date, Number(nights)),
                                rooms: [],
                                room: selectedCell.room,
                                channel,
                                demo_cycle: cycle,
                              }),
                            );
                          })
                        }
                      >
                        查核每晚房況與價格
                      </Button>
                    </div>
                    {quote &&
                      quote.room === selectedCell.room &&
                      quote.start === selectedCell.date &&
                      quote.channel === channel &&
                      quote.nights[0]?.pricing?.price_version ===
                        selectedCell.pricing.price_version && (
                        <div
                          role="status"
                          className="rounded-lg bg-muted/40 p-3 text-sm"
                        >
                          {quote.status === "quote_ready" ? (
                            <>
                              <p className="font-semibold">
                                {quote.nights.length} 晚合計{" "}
                                {priceText(quote.total)}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {quote.message}
                              </p>
                            </>
                          ) : (
                            <p>
                              目前無法提供連住報價：
                              {policyLabels[quote.reason ?? ""] ??
                                "需先查核房況"}
                              {quote.reason === "minimum_stay"
                                ? `（至少 ${quote.minimum_nights} 晚）`
                                : ""}
                              。
                            </p>
                          )}
                        </div>
                      )}
                  </section>
                  <Button
                    className="w-full"
                    disabled={
                      busy || !selectedCell.pricing.eligible || !periodReady
                    }
                    onClick={() =>
                      void action(() => previewRange(selectedCell))
                    }
                  >
                    <Sparkles className="size-4" />
                    預演此房晚調價
                  </Button>
                </>
              )}
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock3 className="size-3" />
                來源觀測{" "}
                {new Date(selectedCell.inventory_observed_at).toLocaleString(
                  "zh-TW",
                )}
              </p>
              {actionError && !preview && (
                <p role="alert" className="text-sm text-destructive">
                  {actionError}
                </p>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open && !busy) setPreview(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>調價預演與交辦</DialogTitle>
            <DialogDescription>
              先核對提案與排除原因，再交給定價 Agent。這裡不會發布價格。
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  可提案 {preview.proposed.length} 房晚
                </Badge>
                <Badge variant="outline">
                  排除 {preview.excluded.length} 房晚
                </Badge>
                <Badge variant="outline">未發布</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {preview.query.start} 至 {preview.query.end}（不含末日）·{" "}
                {channelLabels[preview.query.channel]}
              </p>
              <div className="max-h-64 overflow-auto rounded-lg border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="p-2">房晚</th>
                      <th>目前</th>
                      <th>建議</th>
                      <th>差額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.proposed.map((c) => (
                      <tr key={`${c.date}|${c.room}`} className="border-t">
                        <td className="p-2">
                          {c.date} · {c.room}
                        </td>
                        <td>{priceText(c.pricing?.current_price)}</td>
                        <td>{priceText(c.pricing?.suggested_price)}</td>
                        <td>
                          {(c.pricing?.suggested_price ?? 0) -
                            (c.pricing?.current_price ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer">
                  查看 {preview.excluded.length} 格排除原因
                </summary>
                <ul className="mt-2 max-h-40 space-y-1 overflow-auto">
                  {preview.excluded.map((c) => (
                    <li key={`${c.date}|${c.room}`}>
                      {c.date} · {c.room}：{policyLabels[c.reason] ?? c.reason}
                    </li>
                  ))}
                </ul>
              </details>
              {previewMission ? (
                <div
                  role="status"
                  className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3"
                >
                  <p className="font-medium">交辦已保存，等待定價引擎接手</p>
                  <p className="text-xs">尚未發布，正式計畫仍需原核准流程。</p>
                  <Button asChild>
                    <Link
                      href={`/missions?mission=${previewMission.mission_id}`}
                    >
                      到任務中心查看
                    </Link>
                  </Button>
                </div>
              ) : canHandoff ? (
                <>
                  <Label htmlFor="pricing-goal">給定價 Agent 的交辦內容</Label>
                  <Textarea
                    id="pricing-goal"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    maxLength={2000}
                  />
                  <Button
                    disabled={busy || !goal.trim() || !preview.proposed.length}
                    onClick={() => void action(handoff)}
                  >
                    {busy && <LoaderCircle className="size-4 animate-spin" />}
                    儲存調價交辦
                  </Button>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  此角色可檢視預演；交辦調價需 Owner 或 Admin。
                </p>
              )}
              {actionError && (
                <p role="alert" className="text-sm text-destructive">
                  {actionError}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{preview.notice}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
