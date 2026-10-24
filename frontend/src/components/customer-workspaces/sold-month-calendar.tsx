"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MonthScroller } from "@/components/calendar/calendar-views";
import { customerCalendarProjection } from "@/lib/customer-workspaces/calendar-parity";
import { calendarWindow } from "@/lib/customer-workspaces/order-query";
import type { WorkspaceView } from "@/lib/customer-workspaces/types";
import { field, secondary, today } from "./client";

function monthAfter(month: string) {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1))
    .toISOString().slice(0, 7);
}
function moveMonth(month: string, delta: number) {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1))
    .toISOString().slice(0, 7);
}
function monthNights(checkIn: string, checkOut: string, month: string) {
  const start = checkIn > `${month}-01` ? checkIn : `${month}-01`;
  const end = checkOut < `${monthAfter(month)}-01` ? checkOut : `${monthAfter(month)}-01`;
  return Math.max(0, (Date.parse(end) - Date.parse(start)) / 86400000);
}

export function CustomerSoldMonth({ data: initial, propertyId, initialMonth, initialDay, initialRoom, loadWindow = true }: {
  data: WorkspaceView;
  propertyId: string;
  initialMonth?: string;
  initialDay?: string;
  initialRoom?: string;
  loadWindow?: boolean;
}) {
  const router = useRouter();
  const [month, setMonth] = useState(initialMonth ?? today().slice(0, 7));
  const [day, setDay] = useState(initialDay ?? "");
  const [room, setRoom] = useState(initialRoom ?? "");
  const [channel, setChannel] = useState("all");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const windowKey = `${propertyId}:${month}:${initial.version}:${retry}`;
  const [loaded, setLoaded] = useState(() => ({
    key: windowKey,
    data: initial.properties.some((property) => property.id === propertyId)
      ? calendarWindow(initial, { property: propertyId, month }) : initial,
  }));
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    if (!loadWindow) return;
    const controller = new AbortController();
    fetch(`/api/customer-workspaces/${initial.slug}/operations?${new URLSearchParams({
      view: "calendar", property: propertyId, month,
    })}`, { cache: "no-store", signal: AbortSignal.any([
      controller.signal, AbortSignal.timeout(20000),
    ]) })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail || "月份房況暫時讀取失敗");
        return body as WorkspaceView;
      })
      .then((data) => { if (!controller.signal.aborted) setLoaded({ key: windowKey, data }); })
      .catch((error) => { if (!controller.signal.aborted) setFailure({
        key: windowKey,
        message: error instanceof Error ? error.message : "月份房況暫時讀取失敗",
      }); });
    return () => controller.abort();
  }, [initial.slug, propertyId, month, windowKey, loadWindow]);

  const error = failure?.key === windowKey ? failure.message : "";
  const loading = loadWindow && loaded.key !== windowKey && !error;
  const data = loaded.key === windowKey ? loaded.data : initial;
  const property = data.properties.find((candidate) => candidate.id === propertyId);
  const projection = useMemo(() => property
    ? customerCalendarProjection(data, property)
    : { properties: [], rooms: [], bookings: [] }, [data, property]);
  if (!property) return null;
  const selectedRoom = property.rooms.some((candidate) => candidate.id === room) ? room : "";
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");
  const visible = projection.bookings.filter((booking) =>
    (!selectedRoom || booking.room_id === selectedRoom) &&
    (channel === "all" || booking.platform === channel) &&
    (!normalizedQuery || [booking.guest_name, booking.room_number, booking.external_order_no ?? ""]
      .some((value) => value.toLocaleLowerCase("zh-TW").includes(normalizedQuery))));
  const monthBookings = visible.filter((booking) =>
    booking.check_in < `${monthAfter(month)}-01` && booking.check_out > `${month}-01`);
  const orderIds = new Set(monthBookings.map((booking) => booking.order_id));
  const arrivals = monthBookings.filter((booking) => booking.check_in.startsWith(month)).length;
  const departures = monthBookings.filter((booking) => booking.check_out.startsWith(month)).length;
  const nights = monthBookings.reduce((sum, booking) => sum + monthNights(booking.check_in, booking.check_out, month), 0);
  const knownAmounts = data.bookings.filter((booking) => orderIds.has(booking.id) && booking.total !== null);
  const missingAmounts = data.bookings.filter((booking) => orderIds.has(booking.id) && booking.total === null).length;
  const moneyVisible = data.role !== "viewer_no_price";
  const ready = data.readiness?.[propertyId];
  const known = (date: string) =>
    Boolean(ready?.complete) &&
    (property.setup?.mode !== "sheet" || Boolean(ready?.coverageTo)) &&
    (!ready?.coverageFrom || date >= ready.coverageFrom) &&
    (!ready?.coverageTo || date < ready.coverageTo);
  const dayBookings = visible.filter((booking) => booking.check_in <= day && day < booking.check_out)
    .sort((a, b) => a.room_number.localeCompare(b.room_number, "zh-TW", { numeric: true }));
  function navigate(nextMonth: string, nextDay = "") {
    if (nextMonth < "2000-01" || nextMonth > "2100-12") return;
    setMonth(nextMonth);
    setDay(nextDay);
    setRevision((value) => value + 1);
    window.history.replaceState(null, "", `/w/${data.slug}/calendar?${new URLSearchParams({
      property: propertyId, month: nextMonth, ...(nextDay ? { day: nextDay } : {}),
      ...(selectedRoom ? { room: selectedRoom } : {}),
    })}`);
  }
  return (
    <section className="my-6 space-y-3" aria-label="訂單與房況日曆">
      <div className="rounded-2xl border bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <h2 className="text-lg font-semibold">訂單與房況日曆</h2>
          <span className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white">已售訂單 · 月</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <button type="button" className={secondary} aria-label="上一月" onClick={() => navigate(moveMonth(month, -1))}>〈</button>
          <button type="button" className={secondary} onClick={() => navigate(today().slice(0, 7), today())}>今天</button>
          <button type="button" className={secondary} aria-label="下一月" onClick={() => navigate(moveMonth(month, 1))}>〉</button>
          <label className="font-semibold"><span className="sr-only">月份</span>
            <input className={`${field} w-44`} type="month" min="2000-01" max="2100-12" value={month}
              onChange={(event) => { if (/^\d{4}-\d{2}$/.test(event.target.value)) navigate(event.target.value); }} />
          </label>
          <label className="ml-auto"><span className="sr-only">搜尋客人、房號或訂單</span>
            <input className={`${field} w-56`} value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="搜尋客人、房號或訂單" />
          </label>
          <label><span className="sr-only">房間</span><select className={field} value={selectedRoom} onChange={(event) => setRoom(event.target.value)}>
            <option value="">全部房間</option>{property.rooms.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select></label>
          <label><span className="sr-only">通路</span><select className={field} value={channel} onChange={(event) => setChannel(event.target.value)}>
            <option value="all">全部通路</option>
            {["direct", "booking", "agoda", "airbnb", "ctrip", "owljourney", "other"].map((value) =>
              <option key={value} value={value}>{{ direct: "直訂", booking: "Booking", agoda: "Agoda", airbnb: "Airbnb", ctrip: "Trip", owljourney: "Owl", other: "其他" }[value as "direct"]}</option>)}
          </select></label>
          <button type="button" className={secondary} onClick={() => setRetry((value) => value + 1)}>重新整理</button>
        </div>
      </div>
      {!loading && !error && <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["訂單紀錄", orderIds.size], ["入住", arrivals], ["退房", departures], ["房晚", nights],
          [moneyVisible ? (selectedRoom ? "相關訂單總額（含其他房間）" : "已知訂單總額") : "訂單金額", moneyVisible
            ? `${knownAmounts.reduce((sum, booking) => sum + booking.total!, 0).toLocaleString("zh-TW")} 元${missingAmounts ? `（${missingAmounts} 筆未知）` : ""}`
            : "依權限隱藏"],
        ].map(([label, value]) => <div key={label} className="rounded-xl border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p>
        </div>)}
      </div>}
      {loading && <p role="status" className="rounded-xl bg-white p-5">正在讀取月份房況…</p>}
      {error && <div role="alert" className="rounded-xl bg-red-50 p-5">{error}
        <button type="button" className={`${secondary} ml-3`} onClick={() => setRetry((value) => value + 1)}>重新讀取</button></div>}
      {!loading && !error && <MonthScroller
        months={[`${month}-01`]} targetMonth={`${month}-01`} targetRevision={revision}
        bookings={visible} rooms={projection.rooms} properties={projection.properties}
        onVisibleMonthChange={() => {}}
        onSelectBooking={(booking) => { router.push(`/w/${data.slug}/orders/${encodeURIComponent(booking.order_id)}?${new URLSearchParams({
          back: `/w/${data.slug}/calendar?property=${encodeURIComponent(propertyId)}&month=${month}`,
        })}`); }}
        onSelectDay={(date) => navigate(date.slice(0, 7), date)} />}
      <p className="text-xs text-slate-600">來源尚未完整核對時，日曆空白不表示可售；原 Google Sheet 不會因檢視或匯入預覽而改動。</p>
      {day && <section aria-label="當日房晚" className="rounded-2xl border bg-white p-5">
        <h3 className="font-semibold">{day} · 當晚房間</h3>
        {!known(day) && <p className="mt-2 text-sm text-amber-800">來源尚待核對或超出已確認範圍，空白不能視為空房。</p>}
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {dayBookings.map((booking) => <a key={booking.id}
            className="rounded-lg border p-3 hover:border-teal-500"
            href={`/w/${data.slug}/orders/${encodeURIComponent(booking.order_id)}?${new URLSearchParams({
              back: `/w/${data.slug}/calendar?property=${encodeURIComponent(propertyId)}&month=${month}&day=${day}`,
            })}`}>
            <strong>{booking.room_number} · {booking.guest_name || "姓名未填"}</strong>
            <p className="text-xs text-slate-600">{booking.check_in} 入住 → {booking.check_out} 退房</p>
          </a>)}
        </div>
        {!dayBookings.length && <p className="mt-3 text-sm text-slate-500">當晚沒有已確認訂單。</p>}
      </section>}
    </section>
  );
}
