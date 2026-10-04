"use client";
import { useState } from "react";
import type { OrderTag, WorkspaceView } from "@/lib/customer-workspaces/types";
import { staysOf } from "@/lib/customer-workspaces/domain";
import { stayCounts, tagsFor } from "@/lib/customer-workspaces/order-query";
import { api, button, field, secondary } from "./client";
import { OrderFinance, formatMoney } from "./order-finance";
import { OrderTags, tagColors } from "./order-tags";
import { useCommand } from "./use-command";
export function OrderDetail({
  initial,
  bookingId,
  backHref,
  selectedDate,
  selectedRoom,
}: {
  initial: WorkspaceView;
  bookingId: string;
  backHref: string;
  selectedDate?: string;
  selectedRoom?: string;
}) {
  const [data, setData] = useState(initial),
    [paymentLocked, setPaymentLocked] = useState(false),
    [editing, setEditing] = useState(false),
    [tagEdit, setTagEdit] = useState<OrderTag | null>(null),
    [notice, setNotice] = useState("");
  const booking = data.bookings.find((b) => b.id === bookingId)!;
  const property = data.properties.find((p) => p.id === booking.propertyId)!;
  const [notes, setNotes] = useState(booking.notes ?? ""),
    [platform, setPlatform] = useState(booking.platform ?? ""),
    [bookedAt, setBookedAt] = useState(booking.bookedAt ?? "");
  const [tagName, setTagName] = useState(""),
    [tagShort, setTagShort] = useState(""),
    [tagColor, setTagColor] = useState<OrderTag["color"]>("blue");
  const command = useCommand(
      `/api/customer-workspaces/${data.slug}/operations`,
    ),
    locked = command.busy || command.uncertain || paymentLocked;
  const canWrite = ["owner", "admin", "housekeeper"].includes(data.role),
    canManage = ["owner", "admin"].includes(data.role),
    visibleMoney = data.role !== "viewer_no_price";
  const counts = stayCounts(booking),
    tags = tagsFor(property),
    activeTags = tags.filter((t) => booking.tagIds?.includes(t.id));
  async function save(input: Record<string, unknown>) {
    const result = await command.execute<{ workspace: WorkspaceView }>({
      ...input,
      version: data.version,
      bookingId: booking.id,
      bookingVersion: booking.version,
      propertyId: property.id,
    });
    if (result) {
      setData(result.data.workspace);
      setNotice("已儲存並重新查回。");
      if (result.input.action === "order-details") setEditing(false);
      if (result.input.action === "tag") setTagEdit(null);
    }
  }
  return (
    <main className="min-h-dvh bg-stone-50 px-4 py-6 text-slate-900 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <a
          href={backHref}
          aria-disabled={locked}
          onClick={(event) => {
            if (locked) event.preventDefault();
          }}
          className="text-sm text-teal-800 underline"
        >
          ← 返回原查詢
        </a>
        <header className="my-6">
          <p className="text-sm text-slate-500">{property.name} · 訂單明細</p>
          <h1 tabIndex={-1} className="my-2 text-3xl font-semibold">
            {booking.guestName || "未填姓名"}
          </h1>
          <p className="mb-3 text-sm">
            {booking.platform || "平台未填"} · 訂房日期：
            {booking.bookedAt || "未填"} ·{" "}
            {booking.status === "cancelled" ? "已取消" : "有效訂單"}
          </p>
          <OrderTags tags={activeTags} />
          {(booking.imported?.externalId || booking.calendar?.externalId) && (
            <p className="mt-3 break-all text-sm">
              來源訂單編號：
              {booking.imported?.externalId || booking.calendar?.externalId}
            </p>
          )}
        </header>
        {notice && (
          <p role="status" className="my-3 rounded-xl bg-teal-50 p-3">
            {notice}
          </p>
        )}
        {command.error && (
          <div role="alert" className="my-3 rounded-xl bg-red-50 p-3">
            <p>{command.error}</p>
            {!command.uncertain && (
              <button
                className={`${secondary} mt-2`}
                disabled={locked}
                onClick={async () => {
                  try {
                    const next = await api<WorkspaceView>(
                      `/api/customer-workspaces/${data.slug}`,
                    );
                    setData(next);
                    setNotice("已重新載入，請核對現有內容再儲存。");
                  } catch (e) {
                    setNotice((e as Error).message);
                  }
                }}
              >
                重新載入最新資料
              </button>
            )}
          </div>
        )}
        {command.uncertain && (
          <button
            className={button}
            disabled={command.busy}
            onClick={() => void save({})}
          >
            重試相同操作
          </button>
        )}
        <section className="rounded-2xl border bg-white p-5">
          <h2 className="text-lg font-semibold">入住、退房日期</h2>
          <p className="mt-2 text-sm text-slate-600">
            {counts.nights} 個住宿晚 · {counts.roomNights} 房晚 · 同一筆訂單
          </p>
          {selectedDate && (
            <p className="mt-3 rounded-lg bg-teal-50 p-3 text-sm">
              由 {selectedDate}
              {selectedRoom
                ? ` · ${property.rooms.find((r) => r.id === selectedRoom)?.name ?? ""}`
                : ""}{" "}
              進入；以下保留全部住宿。
            </p>
          )}
          <div className="mt-4 space-y-3">
            {staysOf(booking).map((stay, index) => (
              <div key={index} className="rounded-xl bg-stone-50 p-4">
                <strong>
                  {property.rooms
                    .filter((r) => stay.roomIds.includes(r.id))
                    .map((r) => r.name)
                    .join("、")}
                </strong>
                <p className="mt-1 text-sm">
                  {stay.checkIn} 入住 → {stay.checkOut} 退房
                </p>
              </div>
            ))}
          </div>
          {visibleMoney && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-teal-800">
                每房每晚金額
              </summary>
              {booking.nightlyPrices?.length ? (
                <ul className="mt-3 space-y-2 text-sm">
                  {booking.nightlyPrices.map((p) => (
                    <li key={`${p.roomId}:${p.date}`}>
                      {p.date} ·{" "}
                      {property.rooms.find((r) => r.id === p.roomId)?.name} ·{" "}
                      {formatMoney(p.amount)}（來源逐晚價格）
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-slate-500">
                  來源未提供逐晚金額，整筆訂單總額見下方。
                </p>
              )}
            </details>
          )}
        </section>
        {visibleMoney && (
          <section className="mt-5 rounded-2xl border bg-white p-5">
            <h2 className="text-lg font-semibold">訂單款項</h2>
            <OrderFinance
              data={data}
              booking={booking}
              onSaved={setData}
              onPendingChange={setPaymentLocked}
              externalLocked={command.busy || command.uncertain}
            />
          </section>
        )}
        {visibleMoney && (
          <section className="mt-5 rounded-2xl border bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">特殊需求與備註</h2>
              {canWrite && !editing && (
                <button
                  className={secondary}
                  disabled={locked}
                  onClick={() => {
                    setNotes(booking.notes ?? "");
                    setPlatform(booking.platform ?? "");
                    setBookedAt(booking.bookedAt ?? "");
                    setEditing(true);
                  }}
                >
                  {booking.notes ? "編輯備註" : "新增備註"}／訂單資料
                </button>
              )}
            </div>
            {editing ? (
              <form
                className="mt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save({
                    action: "order-details",
                    notes,
                    platform,
                    bookedAt,
                  });
                }}
              >
                <fieldset disabled={locked} className="space-y-4">
                  <label className="block">
                    訂單備註
                    <textarea
                      className={field}
                      maxLength={2000}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows={4}
                    />
                  </label>
                  <label className="block">
                    預訂平台
                    <input
                      className={field}
                      maxLength={80}
                      value={platform}
                      onChange={(e) => setPlatform(e.target.value)}
                      placeholder="例如 Booking、Agoda、LINE"
                    />
                  </label>
                  <label className="block">
                    實際訂房日期（可留空）
                    <input
                      className={field}
                      type="date"
                      min="2000-01-01"
                      max="2100-12-31"
                      value={bookedAt}
                      onChange={(e) => setBookedAt(e.target.value)}
                    />
                  </label>
                  <div className="flex gap-2">
                    <button className={button}>儲存</button>
                    <button
                      type="button"
                      className={secondary}
                      onClick={() => setEditing(false)}
                    >
                      取消
                    </button>
                  </div>
                </fieldset>
              </form>
            ) : (
              <p className="mt-4 whitespace-pre-wrap text-sm">
                {booking.notes || "尚無備註"}
              </p>
            )}
            {booking.contact && (
              <p className="mt-4 text-sm">聯絡方式：{booking.contact}</p>
            )}
          </section>
        )}
        <section className="mt-5 rounded-2xl border bg-white p-5">
          <h2 className="text-lg font-semibold">快速標籤</h2>
          <p className="mt-2 text-sm text-slate-500">
            同館共用名稱與月曆色標。
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                aria-pressed={booking.tagIds?.includes(tag.id) ?? false}
                disabled={!canWrite || locked}
                className={`rounded-lg border px-3 py-2 text-sm ${booking.tagIds?.includes(tag.id) ? `${tagColors[tag.color]} ring-1 ring-current` : "bg-white"}`}
                onClick={() =>
                  void save({
                    action: "order-tags",
                    tagIds: booking.tagIds?.includes(tag.id)
                      ? booking.tagIds.filter((id) => id !== tag.id)
                      : [...(booking.tagIds ?? []), tag.id],
                  })
                }
              >
                {booking.tagIds?.includes(tag.id) ? "✓ " : "＋ "}
                {tag.name}（{tag.short}）
              </button>
            ))}
          </div>
          {canManage && (
            <details className="mt-5">
              <summary className="cursor-pointer text-sm text-teal-800">
                新增／編輯共用標籤
              </summary>
              <div className="mt-3 flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    disabled={locked}
                    className={secondary}
                    onClick={() => {
                      setTagEdit(tag);
                      setTagName(tag.name);
                      setTagShort(tag.short);
                      setTagColor(tag.color);
                    }}
                  >
                    編輯 {tag.name}
                  </button>
                ))}
                <button
                  disabled={locked}
                  className={secondary}
                  onClick={() => {
                    setTagEdit({ id: "", name: "", short: "", color: "blue" });
                    setTagName("");
                    setTagShort("");
                    setTagColor("blue");
                  }}
                >
                  ＋新增標籤
                </button>
              </div>
              {tagEdit && (
                <form
                  className="mt-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save({
                      action: "tag",
                      tagId: tagEdit.id || undefined,
                      name: tagName,
                      short: tagShort,
                      color: tagColor,
                    });
                  }}
                >
                  <fieldset disabled={locked} className="space-y-3">
                    <label className="block">
                      完整名稱
                      <input
                        required
                        maxLength={30}
                        className={field}
                        value={tagName}
                        onChange={(e) => setTagName(e.target.value)}
                      />
                    </label>
                    <label className="block">
                      月曆顯示一個字
                      <input
                        required
                        maxLength={10}
                        className={field}
                        value={tagShort}
                        onChange={(e) => setTagShort(e.target.value)}
                      />
                    </label>
                    <label className="block">
                      顏色
                      <select
                        className={field}
                        value={tagColor}
                        onChange={(e) =>
                          setTagColor(e.target.value as OrderTag["color"])
                        }
                      >
                        {Object.entries({
                          blue: "藍",
                          orange: "橘",
                          purple: "紫",
                          green: "綠",
                          rose: "粉",
                          slate: "灰",
                        }).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="text-sm text-slate-500">
                      編輯後會同步更新本館已使用此標籤的訂單。
                    </p>
                    <button className={button}>儲存標籤</button>
                    <button
                      type="button"
                      className={`${secondary} ml-2`}
                      onClick={() => setTagEdit(null)}
                    >
                      取消
                    </button>
                  </fieldset>
                </form>
              )}
            </details>
          )}
        </section>
        <details className="my-5 rounded-xl border p-4 text-sm">
          <summary className="cursor-pointer">來源資訊</summary>
          <p className="mt-3 break-all">系統訂單編號：{booking.id}</p>
          <p>
            資料來源：
            {
              { os: "手動建立", sheet: "試算表", calendar: "日曆" }[
                booking.entry
              ]
            }
          </p>
          <p>
            建檔時間：
            {new Date(booking.createdAt).toLocaleString("zh-TW", {
              timeZone: "Asia/Taipei",
            })}
            （非訂房日期）
          </p>
          {booking.bookedAt && (
            <p>
              訂房日期來源：
              {booking.bookedAtSource === "sheet"
                ? "來源試算表"
                : "人工填寫"} · {booking.bookedAtTimeZone || "Asia/Taipei"}
            </p>
          )}
        </details>
      </div>
    </main>
  );
}
