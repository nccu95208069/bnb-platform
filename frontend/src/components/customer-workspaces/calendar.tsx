"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  StaySegment,
  WorkspaceView,
} from "@/lib/customer-workspaces/types";
import { Modal } from "./modal";
import { api, button, field, plusDays, secondary, today } from "./client";
import { staysOf } from "@/lib/customer-workspaces/domain";
import { WorkspaceNav } from "./workspace-nav";
import { OrderDetail } from "./order-detail";
import { MonthCalendar } from "./month-calendar";
export function CustomerCalendar({
  initial,
  initialPropertyId,
  initialMonth,
  initialDay,
  initialRoom,
}: {
  initial: WorkspaceView;
  initialPropertyId?: string;
  initialMonth?: string;
  initialDay?: string;
  initialRoom?: string;
}) {
  const router = useRouter();
  const [data, setData] = useState(initial),
    [start, setStart] = useState(today()),
    [propertyId, setPropertyId] = useState(
      initial.properties.some((p) => p.id === initialPropertyId)
        ? initialPropertyId!
        : (initial.properties[0]?.id ?? ""),
    );
  const [creating, setCreating] = useState(false),
    [holdMode, setHoldMode] = useState(false),
    [confirmHoldScope, setConfirmHoldScope] = useState(false),
    [selected, setSelected] = useState(""),
    [highlight, setHighlight] = useState(""),
    [error, setError] = useState("");
  const property = data.properties.find((p) => p.id === propertyId),
    days = Array.from({ length: 7 }, (_, i) => plusDays(start, i));
  const [checkIn, setCheckIn] = useState(start),
    [nights, setNights] = useState(1),
    [roomIds, setRoomIds] = useState<string[]>([]);
  const [extraStays, setExtraStays] = useState<StaySegment[]>([]),
    [expectedDeposit, setExpectedDeposit] = useState(""),
    [allowOverpayment, setAllowOverpayment] = useState(false);
  const [guestName, setGuestName] = useState(""),
    [total, setTotal] = useState(""),
    [paid, setPaid] = useState(""),
    [paymentKind, setPaymentKind] = useState("none"),
    [method, setMethod] = useState(""),
    [receivedAt, setReceivedAt] = useState(""),
    [contact, setContact] = useState(""),
    [notes, setNotes] = useState(""),
    [platform, setPlatform] = useState(""),
    [bookedAt, setBookedAt] = useState("");
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const pending = useRef<Record<string, unknown> | null>(null);
  const key = useRef("");
  const canWrite =
      ["owner", "admin", "housekeeper"].includes(data.role) &&
      !data.readiness?.[propertyId]?.connected &&
      (data.readiness?.[propertyId]?.complete ??
        (!data.onboarding || data.onboarding.complete)),
    checkOut = plusDays(checkIn, nights);
  const active = data.bookings.filter(
    (b) => b.propertyId === propertyId && b.status !== "cancelled",
  );
  const blocks = (data.blocks ?? []).filter(
    (b) => b.propertyId === propertyId && b.status === "active",
  );
  const dayKnown = (date: string) =>
    (data.readiness?.[propertyId]?.complete ??
      (!data.onboarding || data.onboarding.complete)) &&
    (!data.readiness?.[propertyId]?.coverageFrom ||
      date >= data.readiness[propertyId].coverageFrom!) &&
    (!data.readiness?.[propertyId]?.coverageTo ||
      date < data.readiness[propertyId].coverageTo!);
  const isConnected = Boolean(data.readiness?.[propertyId]?.connected);
  useEffect(() => {
    if (!isConnected || creating || selected) return;
    let alive = true;
    const timer = window.setInterval(() => {
      api<WorkspaceView>(`/api/customer-workspaces/${data.slug}`)
        .then((next) => {
          if (alive) setData(next);
        })
        .catch(() => {
          if (alive)
            setData((old) => ({
              ...old,
              readiness: {
                ...old.readiness,
                [propertyId]: {
                  ...old.readiness![propertyId],
                  complete: false,
                  stale: true,
                },
              },
            }));
        });
    }, 60000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [isConnected, propertyId, data.slug, creating, selected]);
  const picked = data.bookings.find((b) => b.id === selected);
  const occupied = (roomId: string) =>
    [...active, ...blocks].some((b) =>
      staysOf(b).some(
        (s) =>
          s.roomIds.includes(roomId) &&
          s.checkIn < checkOut &&
          checkIn < s.checkOut,
      ),
    );
  function open(date = start, roomId?: string) {
    if (!property) return;
    setCheckIn(date);
    setNights(1);
    setRoomIds(
      property.kind === "villa"
        ? property.villaRoomIds
        : roomId
          ? [roomId]
          : [],
    );
    setExtraStays([]);
    setHoldMode(false);
    setConfirmHoldScope(false);
    setExpectedDeposit("");
    setAllowOverpayment(false);
    setGuestName("");
    setTotal("");
    setPaid("");
    setPaymentKind("none");
    setContact("");
    setNotes("");
    setPlatform("");
    setBookedAt("");
    setMethod("");
    const local = new Date(Date.now() + 8 * 60 * 60000)
      .toISOString()
      .slice(0, 16);
    setReceivedAt(local);
    setError("");
    setUncertain(false);
    pending.current = null;
    key.current = crypto.randomUUID();
    setCreating(true);
  }
  async function refresh() {
    try {
      setData(
        await api<WorkspaceView>(`/api/customer-workspaces/${data.slug}`),
      );
      setError("房況已重新載入，請核對後建立。");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!property || busy) return;
    setBusy(true);
    setError("");
    pending.current ??= {
      requestKey: key.current,
      ...(holdMode ? { action: "hold-create", confirmPlatformOnly: confirmHoldScope } : {}),
      version: data.version,
      propertyId,
      checkIn,
      checkOut,
      roomIds,
      ...(extraStays.length
        ? { stays: [{ checkIn, checkOut, roomIds }, ...extraStays] }
        : {}),
      expectedDeposit: expectedDeposit === "" ? null : Number(expectedDeposit),
      allowOverpayment,
      guestName,
      total: total === "" ? null : Number(total),
      contact,
      notes,
      platform,
      bookedAt,
      payment:
        holdMode || paymentKind === "none"
          ? null
          : {
              kind: paymentKind,
              amount: paid === "" ? null : Number(paid),
              method,
              receivedAt: new Date(`${receivedAt}+08:00`).toISOString(),
            },
    };
    try {
      const result = await api<{ workspace: WorkspaceView; bookingId: string }>(
        `/api/customer-workspaces/${data.slug}${pending.current.action === "hold-create" ? "/operations" : ""}`,
        "POST",
        pending.current,
      );
      setData(result.workspace);
      setHighlight(result.bookingId);
      setSelected(result.bookingId);
      setStart(checkIn);
      setCreating(false);
      pending.current = null;
      setUncertain(false);
    } catch (e) {
      setError((e as Error).message);
      if (
        e instanceof Error &&
        "status" in e &&
        typeof e.status === "number" &&
        e.status < 500
      ) {
        pending.current = null;
        setUncertain(false);
      } else setUncertain(true);
    } finally {
      setBusy(false);
    }
  }
  if (picked && !creating)
    return (
      <OrderDetail
        key={picked.id}
        initial={data}
        bookingId={picked.id}
        backHref={`/w/${data.slug}/calendar?${new URLSearchParams({ property: propertyId, month: picked.checkIn.slice(0, 7), day: picked.checkIn })}`}
      />
    );
  return (
    <main className="min-h-dvh bg-stone-50 p-4 text-slate-800 sm:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <a href="/workspaces" className="text-sm text-teal-800 underline">
              我的旅宿
            </a>
            <h1 className="mt-2 text-2xl font-semibold">{data.name}</h1>
            <p className="mt-1 text-sm text-slate-500">
              房況日曆 · 訂房保存在此工作區
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {["owner", "admin"].includes(data.role) && (
              <a
                className={secondary}
                href={`/w/${data.slug}/import?property=${encodeURIComponent(propertyId)}`}
              >
                匯入與核對來源
              </a>
            )}
            <button
              className={secondary}
              onClick={async () => {
                try {
                  await api("/api/customer-session", "DELETE", {});
                  router.replace("/start");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              登出
            </button>
            {canWrite && (
              <button
                className={`${button} hidden sm:block`}
                onClick={() => open()}
              >
                ＋新增訂房
              </button>
            )}
          </div>
        </header>
        <WorkspaceNav data={data} current="calendar" propertyId={propertyId} />
        {(data.readiness?.[propertyId]?.complete === false ||
          (!data.readiness &&
            data.onboarding &&
            !data.onboarding.complete)) && (
          <p role="alert" className="mt-5 rounded-xl bg-amber-50 p-4 leading-7">
            資料尚未完整：
            {(data.readiness?.[propertyId]?.unresolvedCount ??
            data.onboarding?.unresolvedCount ??
            0)
              ? `有 ${data.readiness?.[propertyId]?.unresolvedCount ?? data.onboarding?.unresolvedCount ?? 0} 列仍待核對。`
              : data.readiness?.[propertyId]?.stale
                ? "日曆同步暫未恢復。"
                : "尚未完成資料匯入。"}
            未顯示訂單的日期不能直接視為空房。請先
            <a
              className="underline"
              href={`/w/${data.slug}/import?property=${encodeURIComponent(propertyId)}`}
            >
              完成資料核對
            </a>
            ，再新增訂房。
          </p>
        )}
        {data.readiness?.[propertyId]?.coverageFrom && (
          <p className="mt-4 text-sm text-slate-600">
            本館訂單已核對範圍：{data.readiness[propertyId].coverageFrom}{" "}
            {data.readiness[propertyId].coverageTo
              ? ` 至 ${data.readiness[propertyId].coverageTo}（不含末日）`
              : "起"}
            。範圍外的空白不能直接視為空房。
          </p>
        )}
        {data.readiness?.[propertyId]?.connected && (
          <p className="mt-4 rounded-xl bg-teal-50 p-4 text-sm leading-7">
            本館持續同步 Google 日曆。新增訂單、入住退房與房間調整請到{" "}
            <a
              className="underline"
              href="https://calendar.google.com/calendar/u/0/r"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google Calendar
            </a>
            ；收退款在本系統登記。來源變更或同步中斷可到「匯入與核對來源」處理。
          </p>
        )}
        {data.properties.length > 1 && (
          <label className="mt-5 block">
            目前旅宿
            <select
              className={field}
              value={propertyId}
              onChange={(e) => {
                setPropertyId(e.target.value);
                setSelected("");
              }}
            >
              {data.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <MonthCalendar
          loadWindow
          key={propertyId}
          data={data}
          propertyId={propertyId}
          initialMonth={initialMonth}
          initialDay={initialDay}
          initialRoom={initialRoom}
        />
        <details className="my-5">
          <summary className="cursor-pointer text-sm text-teal-800">
            週房況與快速新增訂房
          </summary>
          <div className="my-6 flex flex-wrap items-center gap-2">
            <button
              aria-label="上一週"
              className={secondary}
              onClick={() => setStart(plusDays(start, -7))}
            >
              ←
            </button>
            <input
              aria-label="日曆起始日期"
              className="rounded-xl border p-2"
              type="date"
              value={start}
              min="2000-01-01"
              max="2100-12-24"
              onChange={(e) => e.target.value && setStart(e.target.value)}
            />
            <button
              aria-label="下一週"
              className={secondary}
              onClick={() => setStart(plusDays(start, 7))}
            >
              →
            </button>
            <button className={secondary} onClick={() => setStart(today())}>
              今天
            </button>
            <button className={secondary} onClick={refresh}>
              重新載入
            </button>
          </div>
          <div className="overflow-x-auto rounded-2xl border bg-white">
            <div className="min-w-[720px]">
              <div className="grid grid-cols-[100px_repeat(7,minmax(0,1fr))] border-b bg-stone-100">
                <span className="p-3 text-sm">房間</span>
                {days.map((day) => (
                  <button
                    disabled={!canWrite || !dayKnown(day)}
                    key={day}
                    className="border-l p-3 text-sm hover:bg-teal-50"
                    onClick={() => open(day)}
                  >
                    {day.slice(5)}
                    <span className="mt-1 block text-xs text-teal-800">
                      {!dayKnown(day) ? "待核對" : canWrite ? "＋訂房" : ""}
                    </span>
                  </button>
                ))}
              </div>
              {property?.rooms.map((room) => (
                <div
                  key={room.id}
                  className="grid grid-cols-[100px_minmax(0,1fr)] border-b last:border-0"
                >
                  <div className="p-4 text-sm font-medium">{room.name}</div>
                  <div className="relative grid min-h-20 grid-cols-7">
                    {days.map((day) => (
                      <button
                        key={day}
                        disabled={
                          !canWrite ||
                          !dayKnown(day) ||
                          blocks.some((b) =>
                            staysOf(b).some(
                              (s) =>
                                s.roomIds.includes(room.id) &&
                                s.checkIn <= day &&
                                day < s.checkOut,
                            ),
                          )
                        }
                        aria-label={`${room.name} ${day} ${dayKnown(day) ? "新增訂房" : "房況待核對"}`}
                        onClick={() => open(day, room.id)}
                        className={`col-span-1 row-start-1 border-l ${dayKnown(day) ? "hover:bg-teal-50" : "bg-slate-100"}`}
                      />
                    ))}
                    {blocks
                      .flatMap((block) =>
                        staysOf(block).map((stay, index) => ({
                          ...block,
                          ...stay,
                          segmentKey: `${block.id}:${index}`,
                        })),
                      )
                      .filter(
                        (b) =>
                          b.roomIds.includes(room.id) &&
                          b.checkIn < plusDays(start, 7) &&
                          start < b.checkOut,
                      )
                      .map((b) => {
                        const first = Math.max(
                            0,
                            Math.round(
                              (Date.parse(b.checkIn) - Date.parse(start)) /
                                86400000,
                            ),
                          ),
                          end = Math.min(
                            7,
                            Math.round(
                              (Date.parse(b.checkOut) - Date.parse(start)) /
                                86400000,
                            ),
                          );
                        return (
                          <div
                            key={b.segmentKey}
                            style={{
                              gridColumn: `${first + 1} / ${end + 1}`,
                              gridRow: 1,
                            }}
                            className="z-10 m-1 self-center overflow-hidden rounded-lg bg-slate-200 p-2 text-sm text-slate-800"
                          >
                            <span className="block truncate font-medium">
                              封房 · {b.reason}
                            </span>
                            <span className="block truncate text-xs">
                              {b.checkIn.slice(5)} → {b.checkOut.slice(5)}
                            </span>
                          </div>
                        );
                      })}
                    {active
                      .flatMap((order) =>
                        staysOf(order).map((stay, index) => ({
                          ...order,
                          ...stay,
                          segmentKey: `${order.id}:${index}`,
                        })),
                      )
                      .filter(
                        (b) =>
                          b.roomIds.includes(room.id) &&
                          b.checkIn < plusDays(start, 7) &&
                          start < b.checkOut,
                      )
                      .map((b) => {
                        const first = Math.max(
                          0,
                          Math.round(
                            (Date.parse(b.checkIn) - Date.parse(start)) /
                              86400000,
                          ),
                        );
                        const end = Math.min(
                          7,
                          Math.round(
                            (Date.parse(b.checkOut) - Date.parse(start)) /
                              86400000,
                          ),
                        );
                        return (
                          <button
                            key={b.segmentKey}
                            onClick={() => {
                              const back = `/w/${data.slug}/calendar?${new URLSearchParams({ property: propertyId, month: start.slice(0, 7), day: start })}`;
                              router.push(
                                `/w/${data.slug}/orders/${encodeURIComponent(b.id)}?${new URLSearchParams({ back, date: start, room: room.id })}`,
                              );
                            }}
                            style={{
                              gridColumn: `${first + 1} / ${end + 1}`,
                              gridRow: 1,
                            }}
                            className={`z-10 m-1 self-center overflow-hidden rounded-lg p-2 text-left text-sm ${highlight === b.id ? "bg-teal-800 text-white ring-2 ring-teal-400" : "bg-teal-100 text-teal-950"}`}
                          >
                            <span className="block truncate font-medium">
                              {b.guestName || "未填姓名"}
                            </span>
                            <span className="block truncate text-xs">
                              {b.checkIn.slice(5)} → {b.checkOut.slice(5)}
                              {b.roomIds.length > 1
                                ? ` · ${b.roomIds.length} 房`
                                : ""}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-500">
            每格代表當晚住宿，退房當日可接下一筆訂房。手機可左右滑動查看。
          </p>
        </details>
        {!active.length && !blocks.length && (
          <p className="my-10 text-center text-slate-500">
            {canWrite
              ? "還沒有訂房。點日期或「＋」開始登記。"
              : "目前沒有已匯入的訂房；請先確認來源與房況範圍。"}
          </p>
        )}
        {canWrite && (
          <button
            aria-label="新增訂房"
            className={`${button} fixed bottom-6 right-5 z-20 h-14 w-14 rounded-full p-0 text-3xl shadow-lg sm:hidden`}
            onClick={() => open()}
          >
            ＋
          </button>
        )}
        {error && !creating && (
          <p role="status" className="mt-5 rounded-xl bg-amber-50 p-4">
            {error}
          </p>
        )}
        {creating && property && (
          <Modal
            label="新增訂房"
            locked={busy || uncertain}
            onClose={() => setCreating(false)}
          >
            <form
              onSubmit={submit}
              className="max-h-[95dvh] w-full max-w-xl overflow-auto rounded-2xl bg-white p-5 sm:p-7"
            >
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-xl font-semibold">新增訂房</h2>
                <button
                  type="button"
                  disabled={busy || uncertain}
                  className={secondary}
                  onClick={() => setCreating(false)}
                >
                  關閉
                </button>
              </div>
              <fieldset disabled={busy || uncertain} className="space-y-5">
                {data.features?.holds && ["owner", "admin"].includes(data.role) && (
                  <label className="block">建立類型
                    <select className={field} value={holdMode ? "hold" : "booking"} onChange={e => { setHoldMode(e.target.value === "hold"); setPaymentKind("none"); }}>
                      <option value="booking">正式訂單</option><option value="hold">保留單（24 小時）</option>
                    </select>
                  </label>
                )}
                {holdMode && <div className="rounded-xl bg-amber-50 p-4 text-sm">
                  <p>成功建立起保留 24 小時；到期後繼續保留，等待業主決定。請填整筆房費，實際收到訂金後再轉正式訂單。</p>
                  <label className="mt-3 flex gap-2"><input type="checkbox" required checked={confirmHoldScope} onChange={e => setConfirmHoldScope(e.target.checked)} />我確認僅保留本工作區房況，外部通路尚未同步關房。</label>
                </div>}

                <label className="block">
                  入住日期
                  <input
                    type="date"
                    required
                    min="2000-01-01"
                    max="2100-12-30"
                    className={field}
                    value={checkIn}
                    onChange={(e) =>
                      e.target.value && setCheckIn(e.target.value)
                    }
                  />
                </label>
                <div>
                  <p className="mb-2">住幾晚</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {[1, 2, 3].map((n) => (
                      <button
                        type="button"
                        aria-pressed={nights === n}
                        key={n}
                        className={nights === n ? button : secondary}
                        onClick={() => setNights(n)}
                      >
                        {n} 晚
                      </button>
                    ))}
                    <button
                      type="button"
                      aria-label="減少一晚"
                      className={secondary}
                      onClick={() => setNights(Math.max(1, nights - 1))}
                    >
                      −
                    </button>
                    <input
                      aria-label="晚數"
                      type="number"
                      min={1}
                      max={366}
                      value={nights}
                      className="w-16 rounded-xl border p-2"
                      onChange={(e) =>
                        setNights(
                          Math.max(
                            1,
                            Math.min(366, Number(e.target.value) || 1),
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      aria-label="增加一晚"
                      className={secondary}
                      onClick={() => setNights(Math.min(366, nights + 1))}
                    >
                      ＋
                    </button>
                  </div>
                  <p className="mt-2 text-sm text-slate-600">
                    退房：{checkOut}
                  </p>
                </div>
                <div>
                  <p className="mb-2">房間（可複選）</p>
                  <div className="flex flex-wrap gap-2">
                    {property.kind !== "rooms" && (
                      <button
                        type="button"
                        className={
                          property.villaRoomIds.every((id) =>
                            roomIds.includes(id),
                          )
                            ? button
                            : secondary
                        }
                        disabled={property.villaRoomIds.some(occupied)}
                        onClick={() => setRoomIds(property.villaRoomIds)}
                      >
                        整棟
                        {property.villaRoomIds.some(occupied)
                          ? " · 已有訂房"
                          : ""}
                      </button>
                    )}
                    {property.kind !== "villa" &&
                      property.rooms.map((r) => (
                        <button
                          type="button"
                          key={r.id}
                          disabled={occupied(r.id) && !roomIds.includes(r.id)}
                          aria-pressed={roomIds.includes(r.id)}
                          className={
                            roomIds.includes(r.id) ? button : secondary
                          }
                          onClick={() =>
                            setRoomIds(
                              roomIds.includes(r.id)
                                ? roomIds.filter((id) => id !== r.id)
                                : [...roomIds, r.id],
                            )
                          }
                        >
                          {r.name}
                          {occupied(r.id) ? " · 已售" : ""}
                        </button>
                      ))}
                  </div>
                </div>
                <section className="space-y-4 border-t pt-4">
                  <h3 className="font-semibold">同一訂單的其他住宿日期</h3>
                  <p className="text-sm text-slate-500">
                    若同一天訂三間房，在上方複選即可；不同日期、換房或分段住宿，可新增項目。整筆房費與訂金只登記一次。
                  </p>
                  {extraStays.map((stay, index) => (
                    <fieldset
                      key={index}
                      className="space-y-3 rounded-xl border p-4"
                    >
                      <legend>住宿項目 {index + 2}</legend>
                      <label className="block">
                        項目 {index + 2} 入住日期
                        <input
                          className={field}
                          type="date"
                          required
                          min="2000-01-01"
                          max="2100-12-30"
                          value={stay.checkIn}
                          onChange={(e) =>
                            setExtraStays(
                              extraStays.map((s, i) =>
                                i === index
                                  ? { ...s, checkIn: e.target.value }
                                  : s,
                              ),
                            )
                          }
                        />
                      </label>
                      <label className="block">
                        項目 {index + 2} 退房日期
                        <input
                          className={field}
                          type="date"
                          required
                          min={stay.checkIn}
                          max="2100-12-31"
                          value={stay.checkOut}
                          onChange={(e) =>
                            setExtraStays(
                              extraStays.map((s, i) =>
                                i === index
                                  ? { ...s, checkOut: e.target.value }
                                  : s,
                              ),
                            )
                          }
                        />
                      </label>
                      <div className="flex flex-wrap gap-3">
                        {property.kind === "villa" ? (
                          <p>
                            整棟：{property.rooms.map((r) => r.name).join("、")}
                          </p>
                        ) : (
                          property.rooms.map((room) => (
                            <label key={room.id} className="flex gap-2">
                              <input
                                type="checkbox"
                                checked={stay.roomIds.includes(room.id)}
                                onChange={(e) =>
                                  setExtraStays(
                                    extraStays.map((s, i) =>
                                      i === index
                                        ? {
                                            ...s,
                                            roomIds: e.target.checked
                                              ? [...s.roomIds, room.id]
                                              : s.roomIds.filter(
                                                  (id) => id !== room.id,
                                                ),
                                          }
                                        : s,
                                    ),
                                  )
                                }
                              />
                              {room.name}
                            </label>
                          ))
                        )}
                      </div>
                      <button
                        type="button"
                        className={secondary}
                        onClick={() =>
                          setExtraStays(
                            extraStays.filter((_, i) => i !== index),
                          )
                        }
                      >
                        移除此住宿項目
                      </button>
                    </fieldset>
                  ))}
                  <button
                    type="button"
                    className={secondary}
                    disabled={extraStays.length >= 49}
                    onClick={() =>
                      setExtraStays([
                        ...extraStays,
                        {
                          checkIn: checkOut,
                          checkOut: plusDays(checkOut, 1),
                          roomIds:
                            property.kind === "villa"
                              ? [...property.villaRoomIds]
                              : [],
                        },
                      ])
                    }
                  >
                    ＋新增不同日期的住宿項目
                  </button>
                </section>
                <label className="block">
                  旅客稱呼（選填）
                  <input
                    className={field}
                    value={guestName}
                    maxLength={100}
                    onChange={(e) => setGuestName(e.target.value)}
                  />
                </label>
                <details open={holdMode || undefined} className="rounded-xl border p-3">
                  <summary className="cursor-pointer font-medium">
                    ＋登記房費／已收款
                  </summary>
                  <div className="mt-4 space-y-4">
                    <label className="block">
                      整筆房費（全部房間、全部晚數合計）
                      <input
                        className={field}
                        type="number"
                        min={0}
                        step="0.01"
                        value={total}
                        required={holdMode}
                        placeholder="未記錄"
                        onChange={(e) => setTotal(e.target.value)}
                      />
                    </label>
                    <label className="block">
                      約定訂金（選填）
                      <input
                        className={field}
                        type="number"
                        min="0"
                        max="100000000"
                        step="0.01"
                        value={expectedDeposit}
                        onChange={(e) => setExpectedDeposit(e.target.value)}
                      />
                    </label>
                    <label className="block">
                      旅宿實際收款
                      <select
                        className={field}
                        value={paymentKind}
                        disabled={holdMode}
                        onChange={(e) => setPaymentKind(e.target.value)}
                      >
                        <option value="none">尚未登記</option>
                        <option value="deposit">收訂金</option>
                        <option value="full">收全額</option>
                        <option value="balance">收尾款</option>
                        <option value="other">其他費用</option>
                      </select>
                    </label>
                    {paymentKind !== "none" && (
                      <>
                        <p className="text-sm text-slate-500">
                          記錄旅宿已收到的款項；OTA
                          顯示客人已付款不代表旅宿已入帳。
                        </p>
                        <label className="block">
                          實收金額
                          <input
                            className={field}
                            required
                            type="number"
                            min={0}
                            step="0.01"
                            value={paid}
                            onChange={(e) => setPaid(e.target.value)}
                          />
                        </label>
                        <label className="block">
                          收款時間（臺北）
                          <input
                            className={field}
                            required
                            type="datetime-local"
                            value={receivedAt}
                            onChange={(e) => setReceivedAt(e.target.value)}
                          />
                        </label>
                        <label className="block">
                          付款方式（選填）
                          <input
                            className={field}
                            value={method}
                            maxLength={100}
                            placeholder="例如：轉帳、現金"
                            onChange={(e) => setMethod(e.target.value)}
                          />
                        </label>
                      </>
                    )}
                    {paymentKind !== "none" && (
                      <label className="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={allowOverpayment}
                          onChange={(e) =>
                            setAllowOverpayment(e.target.checked)
                          }
                        />
                        如果實收超過整筆房費，我已核對並確認保留溢收
                      </label>
                    )}
                  </div>
                </details>
                <details className="rounded-xl border p-3">
                  <summary className="cursor-pointer font-medium">
                    ＋聯絡方式／備註
                  </summary>
                  <label className="mt-4 block">
                    預訂平台
                    <input
                      className={field}
                      value={platform}
                      maxLength={80}
                      onChange={(e) => setPlatform(e.target.value)}
                    />
                  </label>
                  <label className="mt-4 block">
                    實際訂房日期（可留空）
                    <input
                      type="date"
                      className={field}
                      value={bookedAt}
                      min="2000-01-01"
                      max="2100-12-31"
                      onChange={(e) => setBookedAt(e.target.value)}
                    />
                  </label>
                  <label className="mt-4 block">
                    聯絡方式
                    <input
                      className={field}
                      value={contact}
                      maxLength={200}
                      onChange={(e) => setContact(e.target.value)}
                    />
                  </label>
                  <label className="mt-4 block">
                    備註
                    <textarea
                      className={field}
                      value={notes}
                      maxLength={2000}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </label>
                </details>
              </fieldset>
              <div className="sticky -bottom-5 z-10 -mx-5 mt-5 border-t bg-white px-5 pb-5 pt-3 sm:-bottom-7 sm:-mx-7 sm:px-7 sm:pb-7">
                <div className="rounded-xl bg-teal-50 p-4 text-sm">
                  <p className="font-semibold">
                    {property.name} ·{" "}
                    {property.rooms
                      .filter((r) => roomIds.includes(r.id))
                      .map((r) => r.name)
                      .join("、") || "請選房間"}
                  </p>
                  <p className="mt-1">
                    {checkIn} 入住 → {checkOut} 退房 · {nights} 晚
                  </p>
                  {extraStays.length > 0 && (
                    <p className="mt-2">
                      另有 {extraStays.length}{" "}
                      個住宿項目，共用同一筆訂單與收款。
                    </p>
                  )}
                </div>
                {error && (
                  <p role="alert" className="mt-4 text-sm text-red-800">
                    {error}
                  </p>
                )}
                {uncertain && (
                  <p className="mt-3 text-sm text-amber-800">
                    結果尚待確認，請重試同一筆操作，系統不會重複建立。
                  </p>
                )}
                <div className="mt-5 flex gap-2">
                  <button
                    className={`${button} flex-1`}
                    disabled={
                      busy ||
                      !roomIds.length ||
                      extraStays.some(
                        (s) => !s.roomIds.length || s.checkOut <= s.checkIn,
                      ) ||
                      (!uncertain && roomIds.some(occupied))
                    }
                  >
                    {busy
                      ? "建立中…"
                      : uncertain
                        ? "重試並核對結果"
                        : holdMode ? "建立 24 小時保留單" : "建立訂房"}
                  </button>
                  {!uncertain && (
                    <button
                      type="button"
                      className={secondary}
                      disabled={busy}
                      onClick={refresh}
                    >
                      更新房況
                    </button>
                  )}
                </div>
              </div>
            </form>
          </Modal>
        )}
      </div>
    </main>
  );
}
