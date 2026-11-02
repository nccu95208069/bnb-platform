"use client";
import { bookingStatusLabel } from "@/lib/customer-workspaces/hold-state";
import { useState } from "react";
import type { WorkspaceView } from "@/lib/customer-workspaces/types";
import {
  cents,
  financeSummary,
  staysOf,
} from "@/lib/customer-workspaces/domain";
import { api, button, field, secondary, today } from "./client";
import { WorkspaceNav } from "./workspace-nav";
import { Modal } from "./modal";
import {
  financeLabels,
  formatMoney,
  OrderFinance,
  paymentLabels,
} from "./order-finance";
export function CustomerFinance({
  initial,
  initialPropertyId,
}: {
  initial: WorkspaceView;
  initialPropertyId?: string;
}) {
  const [paymentLocked, setPaymentLocked] = useState(false);
  const [data, setData] = useState(initial),
    [propertyId, setPropertyId] = useState(
      initial.properties.some((p) => p.id === initialPropertyId)
        ? initialPropertyId!
        : "all",
    ),
    [mode, setMode] = useState("receivables"),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [from, setFrom] = useState(`${today().slice(0, 7)}-01`),
    [to, setTo] = useState(today());
  const bookings = data.bookings.filter(
      (b) => propertyId === "all" || b.propertyId === propertyId,
    ),
    active = bookings.filter((b) => b.status === "confirmed"),
    summaries = active.map(financeSummary),
    unknown = summaries.filter((s) => s.received === null).length;
  const pending = bookings.filter((b) => {
      if (b.hold?.latePaymentReview) return true;
      if (b.status !== "confirmed") return false;
      const s = financeSummary(b);
      return (
        s.remaining === null ||
        s.remaining > 0 ||
        (s.credit !== null && s.credit > 0)
      );
    }),
    displayed = mode === "receivables" ? pending : bookings;
  const picked = data.bookings.find((b) => b.id === selected);
  const localDate = (time: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(time));
  const receipts = bookings
    .flatMap((booking) =>
      booking.payments.map((payment) => ({
        booking,
        payment,
        date: localDate(payment.receivedAt),
      })),
    )
    .filter((row) => row.date >= from && row.date <= to)
    .sort((a, b) => b.payment.receivedAt.localeCompare(a.payment.receivedAt));
  const received =
      receipts
        .filter((row) => row.payment.kind !== "refund")
        .reduce((sum, row) => sum + cents(row.payment.amount), 0) / 100,
    refunded =
      receipts
        .filter((row) => row.payment.kind === "refund")
        .reduce((sum, row) => sum + cents(row.payment.amount), 0) / 100;
  return (
    <main className="min-h-dvh bg-stone-50 p-4 text-slate-900 sm:p-8">
      <div className="mx-auto max-w-6xl">
        <a href="/workspaces" className="text-sm text-teal-800 underline">
          我的旅宿
        </a>
        <h1 className="mt-3 text-2xl font-semibold">{data.name} · 收款記帳</h1>
        <WorkspaceNav
          data={data}
          current="finance"
          propertyId={propertyId === "all" ? undefined : propertyId}
        />
        <p className="mb-5 text-sm leading-6 text-slate-600">
          每筆訂單共用一份收款帳，不因房間或住宿夜晚重複計算。這裡管理訂房應收、實收與退款；不包含完整會計、稅務或銀行自動對帳。
        </p>
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <label className="min-w-56">
            查看旅宿
            <select
              className={field}
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
            >
              <option value="all">全部有權限的旅宿</option>
              {data.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className={secondary}
            onClick={async () => {
              try {
                setData(
                  await api<WorkspaceView>(
                    `/api/customer-workspaces/${data.slug}`,
                  ),
                );
                setError("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            重新載入
          </button>
        </div>
        {Object.entries(data.readiness ?? {}).some(
          ([id, readiness]) =>
            !readiness.complete && (propertyId === "all" || propertyId === id),
        ) && (
          <p className="my-4 rounded-xl bg-amber-50 p-4 text-sm">
            有旅宿尚未完成訂單核對。以下只涵蓋已保存的訂單，不能當作完整營收。
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">有效訂單</p>
            <p className="mt-2 text-2xl font-semibold">{active.length} 筆</p>
          </div>
          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">已知尚待收款</p>
            <p className="mt-2 text-2xl font-semibold">
              {formatMoney(
                summaries.reduce((sum, s) => sum + cents(s.remaining ?? 0), 0) /
                  100,
              )}
            </p>
          </div>
          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">實收待核對</p>
            <p className="mt-2 text-2xl font-semibold">{unknown} 筆</p>
          </div>
        </div>
        {error && (
          <p role="alert" className="my-4 rounded-xl bg-red-50 p-4">
            {error}
          </p>
        )}
        <div className="my-5 flex flex-wrap gap-2">
          {[
            ["receivables", "尾款與待核對"],
            ["orders", "全部訂單"],
            ["receipts", "依收款日查帳"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={mode === value ? button : secondary}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "receipts" ? (
          <section className="rounded-2xl border bg-white p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                實際收款起日
                <input
                  className={field}
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                實際收款迄日
                <input
                  className={field}
                  type="date"
                  min={from}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </div>
            <p className="my-4">
              期間收款 {formatMoney(received)} · 退款 {formatMoney(refunded)} ·
              淨收款 {formatMoney((cents(received) - cents(refunded)) / 100)}
            </p>
            <p className="mb-4 text-sm text-slate-500">
              只統計逐筆收退款的實際日期。匯入前累計摘要不會被放入某一天的收款。
            </p>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-3">收款日</th>
                    <th>訂單</th>
                    <th>類別／方式</th>
                    <th className="text-right">金額</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map(({ booking, payment, date }) => (
                    <tr className="border-b" key={payment.id}>
                      <td className="py-3">{date}</td>
                      <td>
                        <button
                          className="underline"
                          onClick={() => setSelected(booking.id)}
                        >
                          {booking.guestName || "未填姓名"}
                        </button>
                      </td>
                      <td>
                        {paymentLabels[payment.kind]} ·{" "}
                        {payment.method || "未填"}
                      </td>
                      <td className="text-right">
                        {payment.kind === "refund" ? "−" : ""}
                        {formatMoney(payment.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!receipts.length && (
              <p className="my-8 text-center text-slate-500">
                這段期間沒有逐筆收退款紀錄。
              </p>
            )}
          </section>
        ) : (
          <section className="overflow-auto rounded-2xl border bg-white p-5">
            <table className="w-full min-w-[660px] text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-3">訂單／旅宿</th>
                  <th>住宿</th>
                  <th>整筆應收</th>
                  <th>實收</th>
                  <th>待收／狀態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((b) => {
                  const summary = financeSummary(b);
                  return (
                    <tr className="border-b" key={b.id}>
                      <td className="py-4">
                        <strong>{b.guestName || "未填姓名"}</strong>
                        <span className="block text-xs text-slate-500">
                          {
                            data.properties.find((p) => p.id === b.propertyId)
                              ?.name
                          }
                        </span>
                      </td>
                      <td>
                        {b.checkIn} → {b.checkOut}
                        <span className="block text-xs text-slate-500">
                          {staysOf(b).length} 個住宿項目 · {b.roomIds.length}{" "}
                          間房
                        </span>
                      </td>
                      <td>{formatMoney(b.total)}</td>
                      <td>{formatMoney(summary.received)}</td>
                      <td>
                        {formatMoney(summary.remaining)}
                        <span className="block text-xs text-slate-500">
                          {b.status !== "confirmed"
                            ? bookingStatusLabel(b)
                            : financeLabels[summary.status]}
                        </span>
                      </td>
                      <td>
                        <button
                          className={secondary}
                          onClick={() => setSelected(b.id)}
                        >
                          {["owner", "admin", "housekeeper"].includes(data.role)
                            ? "明細／登記款項"
                            : "查看明細"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!displayed.length && (
              <p className="my-8 text-center text-slate-500">
                目前沒有符合條件的訂單。
              </p>
            )}
          </section>
        )}
        {picked && (
          <Modal
            label="訂單收款明細"
            locked={paymentLocked}
            onClose={() => {
              if (!paymentLocked) setSelected("");
            }}
          >
            <div className="max-h-[92dvh] w-full max-w-2xl overflow-auto rounded-2xl bg-white p-5 sm:p-7">
              <div className="flex justify-between gap-3">
                <h2 className="text-xl font-semibold">
                  {picked.guestName || "未填姓名"} · 訂單收款
                </h2>
                <button
                  className={secondary}
                  disabled={paymentLocked}
                  onClick={() => setSelected("")}
                >
                  關閉
                </button>
              </div>
              <p className="mt-3 text-sm">
                {data.properties.find((p) => p.id === picked.propertyId)?.name}
              </p>
              {staysOf(picked).map((stay, i) => (
                <p key={i} className="mt-2 text-sm">
                  {stay.checkIn} → {stay.checkOut} ·{" "}
                  {data.properties
                    .find((p) => p.id === picked.propertyId)
                    ?.rooms.filter((r) => stay.roomIds.includes(r.id))
                    .map((r) => r.name)
                    .join("、")}
                </p>
              ))}
              {picked.hold && <a className="my-3 block text-sm text-teal-800 underline" href={`/w/${data.slug}/orders/${picked.id}`}>前往保留單明細處理延長、收款或釋出</a>}
              <OrderFinance
                key={picked.id}
                data={data}
                booking={picked}
                onSaved={setData}
                onPendingChange={setPaymentLocked}
              />
            </div>
          </Modal>
        )}
      </div>
    </main>
  );
}
