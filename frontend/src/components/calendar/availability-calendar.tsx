"use client";
import {useIntlLocale} from "@/components/i18n/language-provider";
import {useT} from "@/components/i18n/language-provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { probabilityText } from "@/lib/sales-probability";
import { PricePair, roomNightStyle } from "./availability-presentation";
import { UnsoldMonthScroller } from "./unsold-month-scroller";
import { availabilityFeatures } from "@/lib/availability-features";
import {
  ArrowRight,
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
import { PAYMENT_SANDBOX, paymentApi, type Mission } from "@/lib/payment-workflow";
import {
  useEffectivePermissions,
  useEffectiveRole,
} from "@/lib/access-control";
import { cn } from "@/lib/utils";

export function AvailabilityCalendar() {
const uiLocale = useIntlLocale();

  const uiText = useT();

  const view = useCalendarPreferences((s) => s.view),
    setView = useCalendarPreferences((s) => s.setView);
  const anchor = useCalendarPreferences((s) => s.anchorDate),
    setAnchor = useCalendarPreferences((s) => s.setAnchorDate);
  const navigation = useCalendarPreferences((s) => s.navigationRequest),
    setPeriodLabel = useCalendarPreferences((s) => s.setMobilePeriodLabel);
  const setProperties = useCalendarPreferences((s) => s.setProperties);
  const selectedPropertyIds = useCalendarPreferences((s) => s.selectedPropertyIds);
  const property = selectedPropertyIds.includes("sweetfun") || selectedPropertyIds.length === 0 ? "sweetfun" : selectedPropertyIds[0];
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
  const savedCycle = useCalendarPreferences((s) => s.availabilityCycle);
  const cycle = availabilityFeatures.demoPriceCycles ? savedCycle : 1;
  const setCycle = useCalendarPreferences((s) => s.setAvailabilityCycle);
  const onlyAvailable = useCalendarPreferences((s) => s.availabilityOnly);
  const setOnlyAvailable = useCalendarPreferences((s) => s.setAvailabilityOnly);
  const [monthJump, setMonthJump] = useState(0);
  const [monthSelected, setMonthSelected] = useState<RoomNight | null>(null);
  const onVisibleMonth = useCallback((month: string) => setAnchor(month), [setAnchor]);
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
            label: formatMonthLabel(anchor, uiLocale),
          }
        : currentPeriod(anchor, view, uiLocale),
    [anchor, view, uiLocale],
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
    setMonthJump(v => v + 1);
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
    setData(null);
    const params = new URLSearchParams({start:query.start,end:query.end,rooms:query.rooms.join(","),channel:query.channel,property});
    const request = PAYMENT_SANDBOX ? availabilityApi.check(query) : fetch(`/api/v1/availability?${params}`,{cache:"no-store"}).then(async r => { const value = await r.json(); if (!r.ok) throw new Error(value.detail); return value as AvailabilityResult; });
    request
      .then((result) => {
        if (!active) return;
        setData(result);
        if (!PAYMENT_SANDBOX && result.properties) setProperties(result.properties);
        if (PAYMENT_SANDBOX) setProperties([
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
  }, [query, refresh, setProperties, property]);
  useEffect(() => { const timer = window.setInterval(() => setRefresh(v => v + 1), 60000); const focus=()=>setRefresh(v=>v+1); window.addEventListener("focus",focus); return ()=>{clearInterval(timer);window.removeEventListener("focus",focus);}; }, []);
  const cells = useMemo(() => data?.cells ?? [], [data]);
  const byKey = useMemo(
    () => new Map(cells.map((c) => [`${c.date}|${c.room}`, c])),
    [cells],
  );
  const selectedCell = selected
    ? byKey.get(`${selected.date}|${selected.room}`) ?? (monthSelected?.date === selected.date && monthSelected.room === selected.room ? monthSelected : undefined)
    : undefined;
  const hidePrice = !canPrice || !!data?.price_hidden;
  const days = useMemo(() => {
    const result = [];
    for (let d = period.start; d < period.end; d = addDays(d, 1))
      result.push(d);
    return result;
  }, [period]);
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
    setMonthSelected(c);
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
    setMonthJump(v => v + 1);
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
    <div className="space-y-2 px-2 pb-2 md:px-0">
      {searchOpen && (
        <div className="fixed inset-x-0 top-0 z-[70] flex h-14 gap-2 border-b bg-background p-2 md:hidden">
          <Input
            aria-label={uiText("搜尋未售房況")}
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={uiText("搜尋房號、維修、可售")}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={uiText("關閉搜尋")}
            onClick={() => setSearchOpen(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}
      <h1 className="sr-only">{uiText("未售房況")}</h1>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="hidden items-center gap-1 md:flex">
          <Button
            variant="ghost"
            size="icon"
            aria-label={uiText("上一個未售區間")}
            onClick={() => move(-1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setAnchor(localTodayIso()); setMonthJump(v => v + 1); }}
          >
            {uiText("今天")}</Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={uiText("下一個未售區間")}
            onClick={() => move(1)}
          >
            <ChevronRight className="size-4" />
          </Button>
          <span className="ml-2 text-sm font-semibold">{uiText(period.label)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={room} onValueChange={setRoom}>
            <SelectTrigger className="w-28" aria-label={uiText("篩選房間")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{uiText("全部房間")}</SelectItem>
              {["101", "102", "201", "202", "301", "302"].map((r) => (
                <SelectItem key={r} value={r}>
                  {r} {uiText("房")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={channel}
            onValueChange={(v) => setChannel(v as Channel)}
          >
            <SelectTrigger className="w-32" aria-label={uiText("售價通路")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(channelLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {uiText(label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="icon" className="size-8" aria-label={uiText("更新未售房況")} disabled={loading} onClick={() => setRefresh(v => v + 1)}><RefreshCw className={cn("size-4", loading && "animate-spin")} /></Button>
        </div>
      </div>
      {!PAYMENT_SANDBOX && <p className="text-[11px] text-muted-foreground" aria-label={uiText("房價上次更新時間")}>{uiText("房價更新")}{data?.cells[0]?.pricing?.observed_at ? new Intl.DateTimeFormat("zh-TW", { timeZone:"Asia/Taipei", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).format(new Date(data.cells[0].pricing.observed_at)) : uiText("讀取中")}</p>}
      <div className="flex items-center gap-3 text-xs" aria-label={uiText("未售房況摘要")}>
        <span>{uiText("未售")}<strong className="tabular-nums">{loading ? "—" : data?.counts.available ?? 0}</strong></span>
        <span className="text-muted-foreground">{uiText("暫留／封房")}<strong className="tabular-nums">{loading ? "—" : (data?.counts.held ?? 0) + (data?.counts.blocked ?? 0) + (data?.counts.maintenance ?? 0)}</strong></span>
        <span className="text-amber-700">{uiText("待確認")}<strong className="tabular-nums">{loading ? "—" : (data?.counts.unknown ?? 0) + (data?.counts.conflict ?? 0)}</strong></span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={onlyAvailable ? "outline" : "secondary"}
            onClick={() => setOnlyAvailable(false)}
          >
            {uiText("未售與待處理")}</Button>
          <Button
            size="sm"
            variant={onlyAvailable ? "secondary" : "outline"}
            onClick={() => setOnlyAvailable(true)}
          >
            {uiText("只看未售")}</Button>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative hidden sm:block">
            <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="h-9 w-44 pl-8"
              aria-label={uiText("搜尋房號或狀態")}
              placeholder={uiText("房號或狀態")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {availabilityFeatures.pricingReview && canPrice && (
            <Button
              size="sm"
              disabled={!periodReady || busy}
              onClick={() => void action(() => previewRange())}
            >
              <Sparkles className="size-4" />
              {uiText("預演此區間調價")}</Button>
          )}
        </div>
      </div>
      <div aria-label={uiText("銷售機率圖例")} className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] leading-4">
        <span className="text-red-800">{uiText("● 高 ≥60%")}</span>
        <span className="text-emerald-800" title={uiText("40% 至未滿 60%")}>{uiText("● 中 40–60%")}</span>
        <span className="text-blue-800">{uiText("● 低 <40%")}</span>
        <span className="text-slate-500">{uiText("● 未提供")}</span>
      </div>
      {availabilityFeatures.demoPriceCycles && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
          <div className="mr-auto">
            <p className="text-xs font-medium sm:text-sm">
              {uiText("房價約每 3–5 天更新")}</p>
            <p className="mt-1 hidden text-xs text-muted-foreground sm:block">
              {uiText("約每 3–5 天調整未售房晚，涵蓋至少未來 90 天。每晚、每通路各有價格。")}</p>
          </div>
          <Select
            value={String(cycle)}
            onValueChange={(v) => {
              setCycle(Number(v) as 1 | 2);
              setQuote(null);
              setPreview(null);
            }}
          >
            <SelectTrigger className="w-44" aria-label={uiText("示範調價輪次")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">{uiText("示範第 1 輪價格")}</SelectItem>
              <SelectItem value="2">{uiText("模擬第 2 輪價格")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {PAYMENT_SANDBOX && <p className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-950">
        {uiText("假資料預覽 ·")}{channelLabels[channel]}{" "}
        {uiText("示範售價，建議未發布。尚未接入正式房況與定價引擎。")}</p>}
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
            {uiText("重新查核")}</Button>
        </div>
      )}
      {view === "month" ? (
        <UnsoldMonthScroller anchor={anchor} jump={monthJump} property={property} room={room} channel={channel} cycle={cycle} refresh={refresh} search={search} onlyAvailable={onlyAvailable} onVisibleMonth={onVisibleMonth} onSelect={openCell} onSelectDay={selectDay} />
      ) : loading ? (
        <div className="flex min-h-72 items-center justify-center gap-2 text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          {uiText("查核房況與價格中")}</div>
      ) : (
        !error &&
        data && (
          <>
            {view === "week" && (
              <div
                className="overflow-auto rounded-xl border bg-card"
                role="region"
                aria-label={uiText("未售週曆，可橫向捲動")}
                tabIndex={0}
              >
                <table className="w-full min-w-[840px] border-collapse text-sm">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 w-20 border-b bg-card p-3 text-left">
                        {uiText("房間")}</th>
                      {days.map((day) => (
                        <th key={day} className="min-w-28 border-b p-2">
                          <button onClick={() => selectDay(day)}>
                            {day.slice(5).replace("-", "/")}
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
                                    roomNightStyle(c),
                                    !matches(c) && "opacity-35",
                                  )}
                                  onClick={() => openCell(c)}
                                  aria-label={uiText("{0} {1} 房 {2}", [day,r,inventoryLabels[c.state]])}
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
                  <Card key={c.room} className={cn("overflow-hidden py-0", roomNightStyle(c))}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <h2 className="text-lg font-semibold">{c.room} {uiText("房")}</h2>
                        <Badge
                          variant="outline"
                          className={roomNightStyle(c)}
                        >
                          {inventoryLabels[c.state]}
                        </Badge>
                      </div>
                      <div className="my-4">
                        <PricePair cell={c} hidePrice={hidePrice} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {c.state === "available"
                          ? PAYMENT_SANDBOX ? uiText("最多 {0} 人 · 最少 {1} 晚", [c.max_guests,c.minimum_nights]) : uiText("訂房表未售；接單前請確認住宿限制")
                          : c.reason}
                      </p>
                      <Button
                        variant="outline"
                        className="mt-4 w-full"
                        onClick={() => openCell(c)}
                      >
                        {uiText("查看房晚與價格")}<ArrowRight className="size-4" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
                {cells.filter(matches).length === 0 && (
                  <p className="py-10 text-sm text-muted-foreground">
                    {uiText("沒有符合條件的房晚。")}</p>
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
              {selected?.room} {uiText("房 ·")}{selected?.date}
            </SheetTitle>
            <SheetDescription>{uiText("房況與通路售價")}</SheetDescription>
          </SheetHeader>
          {selectedCell && (
            <div className="space-y-5 px-4 pb-8">
              <Badge
                variant="outline"
                className={roomNightStyle(selectedCell)}
              >
                {inventoryLabels[selectedCell.state]}
              </Badge>
              <p className="text-sm">{selectedCell.reason}</p>
              {selectedCell.state === "available" && <div className={cn("rounded-lg border p-3 text-sm", roomNightStyle(selectedCell))}>
                <p className="font-semibold">{probabilityText(selectedCell.sales_probability)}</p>
                {selectedCell.sales_probability && <p className="mt-1 text-xs">{uiText("模型預測日期：")}{selectedCell.sales_probability.asof}{uiText("。這是定價模型的售出機率，非成交保證，也不表示調價已執行。")}</p>}
              </div>}
              {!hidePrice && selectedCell.pricing && (
                <>
                  <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/40 p-3">
                    {[
                      ["牌價", selectedCell.pricing.base_price],
                      [
                        `${channelLabels[channel]} 觀測價`,
                        selectedCell.pricing.current_price,
                      ],
                      ...(PAYMENT_SANDBOX ? [["建議・未發布", selectedCell.pricing.suggested_price]] : []),
                    ].map(([label, value]) => (
                      <div key={label}>
                        <p className="text-[10px] text-muted-foreground">
                          {uiText(label)}
                        </p>
                        <p className="mt-1 text-base font-semibold">
                          {value == null ? "—" : priceText(Number(value))}
                        </p>
                      </div>
                    ))}
                  </div>
                  <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <CircleHelp className="size-4 shrink-0" />
                    {selectedCell.pricing.limits}{uiText("。價格讀取：")}{selectedCell.pricing.observed_at ? new Date(selectedCell.pricing.observed_at).toLocaleString(uiLocale, {timeZone:"Asia/Taipei"}) : uiText("尚無資料")}{uiText("。價格版本")}{selectedCell.pricing.price_version}
                    {uiText("。客人前台實付尚未核對，通路促銷可能使實付與系統價不同。")}</p>
                  {availabilityFeatures.pricingReview && (
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
                          ? uiText("可加入調價預演，仍需原引擎產生正式計畫。")
                          : uiText("此格不進一般調價清單，仍依實際房況決定是否可訂。")}
                      </p>
                    </div>
                  )}

                  {availabilityFeatures.stayQuote && (
                    <section className="space-y-2 border-t pt-4">
                      <h3 className="font-semibold">{uiText("查連住與總價")}</h3>
                      <p className="text-xs text-muted-foreground">
                        {uiText("入住")}{selectedCell.date} {uiText("· 退房")}{" "}
                        {addDays(
                          selectedCell.date,
                          Math.max(1, Math.min(30, Number(nights) || 1)),
                        )}{" "}
                        {uiText("· 雙人住宿")}</p>
                      <div className="flex gap-2">
                        <Label className="sr-only" htmlFor="stay-nights">
                          {uiText("住宿晚數")}</Label>
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
                                  end: addDays(
                                    selectedCell.date,
                                    Number(nights),
                                  ),
                                  rooms: [],
                                  room: selectedCell.room,
                                  channel,
                                  demo_cycle: cycle,
                                }),
                              );
                            })
                          }
                        >
                          {uiText("查核每晚房況與價格")}</Button>
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
                                  {quote.nights.length} {uiText("晚合計")}{" "}
                                  {priceText(quote.total)}
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {quote.message}
                                </p>
                              </>
                            ) : (
                              <p>
                                {uiText("目前無法提供連住報價：")}{policyLabels[quote.reason ?? ""] ??
                                  "需先查核房況"}
                                {quote.reason === "minimum_stay"
                                  ? uiText("（至少 {0} 晚）", [quote.minimum_nights])
                                  : ""}
                                。
                              </p>
                            )}
                          </div>
                        )}
                    </section>
                  )}

                  {availabilityFeatures.pricingReview && (
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
                      {uiText("預演此房晚調價")}</Button>
                  )}
                </>
              )}
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock3 className="size-3" />
                {uiText("來源觀測")}{" "}
                {new Date(selectedCell.inventory_observed_at).toLocaleString(
                  uiLocale,
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
        open={availabilityFeatures.pricingReview && !!preview}
        onOpenChange={(open) => {
          if (!open && !busy) setPreview(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{uiText("調價預演與交辦")}</DialogTitle>
            <DialogDescription>
              {uiText("先核對提案與排除原因，再交給定價 Agent。這裡不會發布價格。")}</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  {uiText("可提案")}{preview.proposed.length} {uiText("房晚")}</Badge>
                <Badge variant="outline">
                  {uiText("排除")}{preview.excluded.length} {uiText("房晚")}</Badge>
                <Badge variant="outline">{uiText("未發布")}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {preview.query.start} {uiText("至")}{preview.query.end}{uiText("（不含末日）·")}{" "}
                {channelLabels[preview.query.channel]}
              </p>
              <div className="max-h-64 overflow-auto rounded-lg border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="p-2">{uiText("房晚")}</th>
                      <th>{uiText("目前")}</th>
                      <th>{uiText("建議")}</th>
                      <th>{uiText("差額")}</th>
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
                  {uiText("查看")}{preview.excluded.length} {uiText("格排除原因")}</summary>
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
                  <p className="font-medium">{uiText("交辦已保存，等待定價引擎接手")}</p>
                  <p className="text-xs">{uiText("尚未發布，正式計畫仍需原核准流程。")}</p>
                  <Button asChild>
                    <Link
                      href={`/missions?mission=${previewMission.mission_id}`}
                    >
                      {uiText("到任務中心查看")}</Link>
                  </Button>
                </div>
              ) : canHandoff ? (
                <>
                  <Label htmlFor="pricing-goal">{uiText("給定價 Agent 的交辦內容")}</Label>
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
                    {uiText("儲存調價交辦")}</Button>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {uiText("此角色可檢視預演；交辦調價需 Owner 或 Admin。")}</p>
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
