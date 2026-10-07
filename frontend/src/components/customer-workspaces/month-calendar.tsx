"use client";
import { useEffect, useState } from "react";
import type { WorkspaceView } from "@/lib/customer-workspaces/types";
import { staysOf } from "@/lib/customer-workspaces/domain";
import {
  calendarWindow,
  orderIssues,
  tagsFor,
} from "@/lib/customer-workspaces/order-query";
import { OrderTags } from "./order-tags";
import { field, plusDays, secondary, today } from "./client";
export function MonthCalendar({
  data: initial,
  propertyId,
  loadWindow = false,
  initialMonth,
  initialDay,
  initialRoom,
}: {
  data: WorkspaceView;
  loadWindow?: boolean;
  propertyId: string;
  initialMonth?: string;
  initialDay?: string;
  initialRoom?: string;
}) {
  const [month, setMonth] = useState(initialMonth || today().slice(0, 7)),
    [day, setDay] = useState(initialDay || ""),
    [room, setRoom] = useState(initialRoom || "");
  const [retry, setRetry] = useState(0);
  const windowKey = `${propertyId}:${month}:${initial.version}:${retry}`;
  const [loaded, setLoaded] = useState(() => ({
    key: windowKey,
    data: initial.properties.some((p) => p.id === propertyId)
      ? calendarWindow(initial, { property: propertyId, month })
      : initial,
  }));
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  useEffect(() => {
    if (!loadWindow || !propertyId) return;
    const controller = new AbortController();
    fetch(
      `/api/customer-workspaces/${initial.slug}/operations?${new URLSearchParams({ view: "calendar", property: propertyId, month })}`,
      {
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20000),
        ]),
      },
    )
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.detail || "月份房況暫時讀取失敗");
        return value as WorkspaceView;
      })
      .then((next) => {
        if (!controller.signal.aborted)
          setLoaded({ key: windowKey, data: next });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setFailure({
            key: windowKey,
            message:
              error instanceof Error ? error.message : "月份房況暫時讀取失敗",
          });
      });
    return () => controller.abort();
  }, [loadWindow, initial.slug, propertyId, month, windowKey]);
  const error = failure?.key === windowKey ? failure.message : "";
  const loading = loadWindow && loaded.key !== windowKey && !error;
  const data = loadWindow && loaded.key === windowKey ? loaded.data : initial;
  const property = data.properties.find((p) => p.id === propertyId);
  if (!property) return null;
  const first = `${month}-01`,
    start = plusDays(first, -new Date(`${first}T00:00:00Z`).getUTCDay()),
    nextMonth = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1),
    )
      .toISOString()
      .slice(0, 10);
  const weeks = Math.ceil(
    (Date.parse(nextMonth) - Date.parse(start)) / (7 * 86400000),
  );
  const orders = data.bookings.filter(
      (b) => b.propertyId === propertyId && b.status === "confirmed",
    ),
    blocks = (data.blocks ?? []).filter(
      (b) => b.propertyId === propertyId && b.status === "active",
    ),
    tags = tagsFor(property);
  const selectedRoom = property.rooms.some((r) => r.id === room) ? room : "";
  const segments = orders.flatMap((b) =>
    staysOf(b).flatMap((s, i) =>
      s.roomIds
        .filter((id) => !selectedRoom || selectedRoom === id)
        .map((roomId) => ({ b, s, roomId, key: `${b.id}:${i}:${roomId}` })),
    ),
  );
  const conflicts = new Set(
    orders
      .filter((b) => orderIssues(data, b).includes("房晚重疊"))
      .map((b) => b.id),
  );
  const dayRows = segments
    .filter(({ s }) => s.checkIn <= day && day < s.checkOut)
    .sort(
      (a, b) =>
        (
          property.rooms.find((r) => r.id === a.roomId)?.name || ""
        ).localeCompare(
          property.rooms.find((r) => r.id === b.roomId)?.name || "",
          "zh-TW",
          { numeric: true },
        ) || a.b.id.localeCompare(b.b.id),
    );
  const ready = data.readiness?.[propertyId];
  const known = (date: string) =>
    (ready?.complete ?? (!data.onboarding || data.onboarding.complete)) &&
    (!ready?.coverageFrom || date >= ready.coverageFrom) &&
    (!ready?.coverageTo || date < ready.coverageTo);
  function back(date = day) {
    return `/w/${data.slug}/calendar?${new URLSearchParams({ property: propertyId, month, ...(date ? { day: date } : {}), ...(selectedRoom ? { room: selectedRoom } : {}) })}`;
  }
  function link(id: string, date: string, roomId: string) {
    return `/w/${data.slug}/orders/${encodeURIComponent(id)}?${new URLSearchParams({ back: `${back(date)}#day-${date}`, date, room: roomId })}`;
  }
  function update(next: { month?: string; day?: string; room?: string }) {
    const m = next.month ?? month,
      d = next.day ?? day,
      r = next.room ?? selectedRoom;
    if (m < "2000-01" || m > "2100-12") return;
    setMonth(m);
    setDay(d);
    setRoom(r);
    window.history.replaceState(
      null,
      "",
      `/w/${data.slug}/calendar?${new URLSearchParams({ property: propertyId, month: m, ...(d ? { day: d } : {}), ...(r ? { room: r } : {}) })}`,
    );
  }
  const move = (delta: number) =>
    update({
      month: new Date(
        Date.UTC(
          Number(month.slice(0, 4)),
          Number(month.slice(5, 7)) - 1 + delta,
          1,
        ),
      )
        .toISOString()
        .slice(0, 7),
      day: "",
    });
  return (
    <section className="my-6">
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <button
          className={secondary}
          aria-label="上一月"
          onClick={() => move(-1)}
        >
          ←
        </button>
        <label className="min-w-0">
          月份
          <input
            className={field}
            type="month"
            min="2000-01"
            max="2100-12"
            value={month}
            onChange={(e) => {
              if (/^\d{4}-\d{2}$/.test(e.target.value))
                update({ month: e.target.value, day: "" });
            }}
          />
        </label>
        <button
          className={secondary}
          aria-label="下一月"
          onClick={() => move(1)}
        >
          →
        </button>
        <button
          className={secondary}
          onClick={() => update({ month: today().slice(0, 7), day: today() })}
        >
          今天
        </button>
        <label className="min-w-0 flex-1 sm:max-w-56">
          房間
          <select
            className={field}
            value={selectedRoom}
            onChange={(e) => update({ room: e.target.value })}
          >
            <option value="">全部房間</option>
            {property.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading && (
        <p role="status" className="rounded-xl bg-white p-5">
          正在讀取月份房況…
        </p>
      )}
      {error && (
        <div role="alert" className="rounded-xl bg-red-50 p-5">
          <p>{error}</p>
          <button
            className={`${secondary} mt-3`}
            onClick={() => setRetry((value) => value + 1)}
          >
            重新讀取月份
          </button>
        </div>
      )}
      {!loading && !error && (
        <>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="grid grid-cols-7 border-b bg-stone-100 text-center text-xs">
              {"日一二三四五六".split("").map((d) => (
                <span className="py-3" key={d}>
                  {d}
                </span>
              ))}
            </div>
            {Array.from({ length: weeks }, (_, week) => {
              const weekStart = plusDays(start, week * 7),
                weekEnd = plusDays(weekStart, 7),
                days = Array.from({ length: 7 }, (_, i) =>
                  plusDays(weekStart, i),
                );
              const weekSegments = segments
                .filter(
                  ({ s }) => s.checkIn < weekEnd && s.checkOut > weekStart,
                )
                .sort(
                  (a, b) =>
                    a.s.checkIn.localeCompare(b.s.checkIn) ||
                    a.roomId.localeCompare(b.roomId),
                );
              const laneEnds: number[] = [];
              const bars = weekSegments.map((segment) => {
                const first = Math.max(
                    0,
                    (Date.parse(segment.s.checkIn) - Date.parse(weekStart)) /
                      86400000,
                  ),
                  end = Math.min(
                    7,
                    (Date.parse(segment.s.checkOut) - Date.parse(weekStart)) /
                      86400000,
                  );
                let lane = laneEnds.findIndex((last) => last <= first);
                if (lane < 0) lane = laneEnds.length;
                laneEnds[lane] = end;
                return { ...segment, first, end, lane };
              });
              return (
                <div key={weekStart} className="border-b last:border-0">
                  <div className="grid grid-cols-7">
                    {days.map((date) => {
                      const rows = segments.filter(
                          ({ s }) => s.checkIn <= date && date < s.checkOut,
                        ),
                        ids = new Set(rows.flatMap(({ b }) => b.tagIds ?? [])),
                        blocked = blocks.some((b) =>
                          staysOf(b).some(
                            (s) =>
                              s.checkIn <= date &&
                              date < s.checkOut &&
                              (!selectedRoom ||
                                s.roomIds.includes(selectedRoom)),
                          ),
                        );
                      return (
                        <button
                          key={date}
                          id={`day-${date}`}
                          aria-label={`${date}，${rows.length} 房晚${blocked ? "，含封房" : ""}${!known(date) ? "，來源待核對" : ""}`}
                          aria-pressed={day === date}
                          onClick={() => update({ day: date })}
                          className={`min-w-0 border-r px-1 py-3 text-center last:border-r-0 ${day === date ? "bg-teal-100 ring-1 ring-inset ring-teal-600" : "hover:bg-stone-50"} ${date.startsWith(month) ? "" : "text-slate-400"}`}
                        >
                          <span className="text-sm font-medium">
                            {Number(date.slice(8))}
                          </span>
                          <span className="mt-1 block text-[10px] sm:hidden">
                            {rows.length ? `${rows.length} 房晚` : "—"}
                          </span>
                          <span className="block sm:hidden">
                            <OrderTags
                              compact
                              limit={1}
                              tags={tags.filter((t) => ids.has(t.id))}
                            />
                          </span>
                          {(!known(date) || blocked) && (
                            <span className="block text-[10px] text-amber-800">
                              {blocked ? "封房" : "待核對"}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <div className="hidden grid-cols-7 gap-y-1 px-1 pb-2 sm:grid">
                    {bars.map(({ b, s, roomId, key, first, end, lane }) => (
                      <a
                        key={key}
                        style={{
                          gridColumn: `${first + 1} / ${end + 1}`,
                          gridRow: lane + 1,
                        }}
                        href={link(
                          b.id,
                          s.checkIn < weekStart ? weekStart : s.checkIn,
                          roomId,
                        )}
                        className="mx-0.5 flex min-w-0 items-center gap-1 rounded-lg bg-teal-50 px-2 py-2 text-xs text-teal-950 hover:bg-teal-100"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {conflicts.has(b.id) ? "⚠ 房晚重疊 · " : ""}
                          {s.checkIn < weekStart ? "← " : ""}
                          {
                            property.rooms.find((r) => r.id === roomId)?.name
                          } · {b.guestName || "姓名未填"} ·{" "}
                          {b.platform || "平台未填"}
                          {s.checkOut > weekEnd ? " →" : ""}
                        </span>
                        <OrderTags
                          compact
                          limit={3}
                          tags={tags.filter((t) => b.tagIds?.includes(t.id))}
                        />
                      </a>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {ready?.sourceUpdatedAt && (
            <p className="mt-3 text-xs text-slate-500">
              來源最近確認：
              {new Date(ready.sourceUpdatedAt).toLocaleString("zh-TW", {
                timeZone: "Asia/Taipei",
              })}
            </p>
          )}
          <p className="mt-3 text-xs text-slate-500">
            點日期查看當晚房間，點住宿開完整訂單。空白不代表可售；退房當晚不算占房。
          </p>
          {day && (
            <section
              aria-label="當日房晚"
              className="mt-5 rounded-2xl border bg-white p-5"
            >
              <h2 className="font-semibold">{day} · 當晚房間</h2>
              <p className="mt-1 text-xs text-slate-500">按房號排序</p>
              {!known(day) && (
                <p className="my-3 text-sm text-amber-800">
                  來源尚待核對或超出已確認範圍。
                </p>
              )}
              <div className="mt-3 space-y-2">
                {dayRows.map(({ b, s, roomId, key }) => (
                  <a
                    key={key}
                    href={link(b.id, day, roomId)}
                    className="block rounded-xl border p-3 hover:border-teal-500"
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <strong className="text-sm">
                        {conflicts.has(b.id) ? "⚠ 房晚重疊 · " : ""}
                        {
                          property.rooms.find((r) => r.id === roomId)?.name
                        } · {b.guestName || "姓名未填"}
                      </strong>
                      <OrderTags
                        tags={tags.filter((t) => b.tagIds?.includes(t.id))}
                      />
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      {b.platform || "平台未填"} · {s.checkIn} 入住 →{" "}
                      {s.checkOut} 退房
                    </p>
                  </a>
                ))}
                {blocks.flatMap((b) =>
                  staysOf(b)
                    .filter(
                      (s) =>
                        s.checkIn <= day &&
                        day < s.checkOut &&
                        (!selectedRoom || s.roomIds.includes(selectedRoom)),
                    )
                    .map((s, i) => (
                      <p
                        key={`${b.id}:${i}`}
                        className="rounded-xl bg-slate-100 p-3 text-sm"
                      >
                        封房：
                        {property.rooms
                          .filter((r) => s.roomIds.includes(r.id))
                          .map((r) => r.name)
                          .join("、")}{" "}
                        · {b.reason}
                      </p>
                    )),
                )}
              </div>
              {!dayRows.length && (
                <p className="mt-3 text-sm text-slate-500">當晚未顯示訂單。</p>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
