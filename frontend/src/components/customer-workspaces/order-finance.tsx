"use client";
import { useEffect, useState } from "react";
import type { WorkspaceView } from "@/lib/customer-workspaces/types";
import { businessDate, financeSummary } from "@/lib/customer-workspaces/domain";
import { button, field, secondary, today } from "./client";
import { useCommand } from "./use-command";
export const paymentLabels: Record<string, string> = {
  deposit: "訂金",
  balance: "尾款",
  full: "全額",
  other: "其他收款",
  refund: "退款",
};
export const financeLabels: Record<string, string> = {
  unknown: "待核對",
  unpaid: "未收款",
  partial: "部分已收",
  paid: "已結清",
  overpaid: "有溢收",
};
export const formatMoney = (amount: number | null | undefined) =>
  amount == null
    ? "待核對"
    : `NT$ ${amount.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;
type BookingView = WorkspaceView["bookings"][number];
export function OrderFinance({
  data,
  booking,
  onSaved,
  onPendingChange,
}: {
  data: WorkspaceView;
  booking: BookingView;
  onSaved: (value: WorkspaceView) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const summary = financeSummary(booking),
    canWrite =
      ["owner", "admin", "housekeeper"].includes(data.role) &&
      booking.status === "confirmed",
    canManage =
      ["owner", "admin"].includes(data.role) && booking.status === "confirmed";
  const [action, setAction] = useState("payment"),
    [kind, setKind] = useState(booking.payments.length ? "balance" : "deposit"),
    [amount, setAmount] = useState(""),
    [method, setMethod] = useState(""),
    [note, setNote] = useState(""),
    [receivedAt, setReceivedAt] = useState(() =>
      new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16),
    ),
    [asOf, setAsOf] = useState(businessDate(booking.createdAt)),
    [total, setTotal] = useState(
      booking.total === null ? "" : String(booking.total),
    ),
    [expectedDeposit, setExpectedDeposit] = useState(
      booking.expectedDeposit == null ? "" : String(booking.expectedDeposit),
    ),
    [confirmed, setConfirmed] = useState(false),
    [notice, setNotice] = useState("");
  const command = useCommand(
      `/api/customer-workspaces/${data.slug}/operations`,
    ),
    locked = command.busy || command.uncertain;
  useEffect(() => {
    onPendingChange?.(locked);
  }, [locked, onPendingChange]);
  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    setNotice("");
    let input: Record<string, unknown> = {
      action,
      bookingId: booking.id,
      bookingVersion: booking.version,
      version: data.version,
    };
    if (action === "payment")
      input = {
        ...input,
        kind,
        amount: amount === "" ? null : Number(amount),
        method,
        note,
        receivedAt: receivedAt ? new Date(receivedAt).toISOString() : "",
        allowOverpayment: confirmed,
      };
    if (action === "opening")
      input = {
        ...input,
        amount: amount === "" ? null : Number(amount),
        asOf,
        note,
      };
    if (action === "terms")
      input = {
        ...input,
        total: total === "" ? null : Number(total),
        expectedDeposit:
          expectedDeposit === "" ? null : Number(expectedDeposit),
        allowOverpayment: confirmed,
      };
    const result = await command.execute<{ workspace: WorkspaceView }>(input);
    if (result) {
      onSaved(result.data.workspace);
      setAmount("");
      setNote("");
      setConfirmed(false);
      setNotice(
        result.input.action === "cancel"
          ? "訂單已取消，房間已釋出。"
          : "已保存並重新核對訂單金額。",
      );
    }
  }
  return (
    <section className="mt-5 border-t pt-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <p>
          整筆應收
          <strong className="mt-1 block">{formatMoney(booking.total)}</strong>
        </p>
        <p>
          累計旅宿實收
          <strong className="mt-1 block">
            {formatMoney(summary.received)}
          </strong>
        </p>
        <p>
          尚待收款
          <strong className="mt-1 block">
            {formatMoney(summary.remaining)}
          </strong>
        </p>
      </div>
      <p className="mt-3 text-sm">
        狀態：{financeLabels[summary.status]}
        {summary.credit ? ` · 溢收 ${formatMoney(summary.credit)}` : ""}
      </p>
      {booking.expectedDeposit != null && (
        <p className="mt-2 text-sm">
          約定訂金 {formatMoney(booking.expectedDeposit)} · 已登記為訂金{" "}
          {formatMoney(summary.depositReceived)}
          <span className="block text-xs text-slate-500">
            期初實收若無明細，不會自動歸類為訂金。
          </span>
        </p>
      )}
      {booking.entry === "sheet" && (
        <div className="my-4 rounded-xl bg-stone-50 p-3 text-sm leading-6">
          {booking.importedFinance?.receivedMeaning === "source" && (
            <p>
              來源累計已付：
              {formatMoney(booking.importedFinance.sourcePaid ?? null)}
              （保留原表摘要）
            </p>
          )}
          <p>匯入前累計旅宿實收：{formatMoney(summary.openingReceived)}</p>
          {booking.importedFinance?.guestPaid != null && (
            <p>
              旅客付平台：{formatMoney(booking.importedFinance.guestPaid)}
              （不列為旅宿實收）
            </p>
          )}
          <p>
            匯入後逐筆收款 {formatMoney(summary.recordedReceived)}，退款{" "}
            {formatMoney(summary.refunds)}
            。來源累計只保留期初摘要，不補造交易明細。
          </p>
          {summary.openingReceived === null && (
            <p className="text-amber-800">
              期初實收尚未確認，因此整筆實收與尾款保持待核對。
            </p>
          )}
        </div>
      )}
      <h3 className="mt-5 font-semibold">收退款明細</h3>
      {!booking.payments.length && (
        <p className="my-3 text-sm text-slate-500">尚無逐筆收退款紀錄。</p>
      )}
      <ol className="my-3 space-y-3">
        {booking.payments.map((p) => (
          <li key={p.id} className="rounded-xl border p-3 text-sm">
            <div className="flex justify-between gap-3">
              <strong>{paymentLabels[p.kind]}</strong>
              <strong>
                {p.kind === "refund" ? "−" : ""}
                {formatMoney(p.amount)}
              </strong>
            </div>
            <p className="mt-1 text-slate-500">
              {new Date(p.receivedAt).toLocaleString("zh-TW", {
                timeZone: "Asia/Taipei",
              })}{" "}
              · {p.method || "未填方式"}
            </p>
            {p.note && <p className="mt-1 whitespace-pre-wrap">{p.note}</p>}
          </li>
        ))}
      </ol>
      {notice && (
        <p role="status" className="my-3 rounded-xl bg-teal-50 p-3">
          {notice}
        </p>
      )}
      {command.error && (
        <p role="alert" className="my-3 rounded-xl bg-red-50 p-3">
          {command.error}
        </p>
      )}
      {canWrite && (
        <form className="mt-5 space-y-4" onSubmit={submit}>
          <fieldset disabled={locked} className="space-y-4">
            <legend className="mb-3 font-semibold">登記款項</legend>
            <div className="flex flex-wrap gap-2">
              {[
                ["payment", "收款／退款"],
                ...(canManage
                  ? [
                      ["terms", "修改應收與訂金"],
                      ...(booking.entry === "sheet" &&
                      summary.openingReceived === null
                        ? [["opening", "確認期初實收"]]
                        : []),
                      ["cancel", "取消訂單"],
                    ]
                  : []),
              ].map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={action === value ? button : secondary}
                  onClick={() => {
                    setAction(value);
                    setAmount("");
                    setConfirmed(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {action === "payment" && (
              <>
                <label className="block">
                  款項類別
                  <select
                    className={field}
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value);
                      setConfirmed(false);
                    }}
                  >
                    {Object.entries(paymentLabels)
                      .filter(([value]) => value !== "refund" || canManage)
                      .map(([value, label]) => (
                        <option value={value} key={value}>
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="block">
                  本次{kind === "refund" ? "退款" : "實收"}金額
                  <input
                    className={field}
                    type="number"
                    min="0.01"
                    step="0.01"
                    max="100000000"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label className="block">
                  實際收退款時間
                  <input
                    className={field}
                    type="datetime-local"
                    required
                    value={receivedAt}
                    onChange={(e) => setReceivedAt(e.target.value)}
                  />
                </label>
                <label className="block">
                  付款方式
                  <input
                    className={field}
                    maxLength={100}
                    placeholder="例如轉帳、現金、平台撥款"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  />
                </label>
                <p className="text-sm text-slate-500">
                  只登記已實際收到或退還的款項。此處不會向客人扣款或轉帳；同筆訂單的多房與多段住宿共用這份帳。
                </p>
              </>
            )}
            {action === "opening" && (
              <>
                <p className="text-sm leading-6">
                  請核對匯入以前，旅宿實際收到多少；沒有收到可填
                  0。這筆金額不包含匯入後新增的明細，確認後不能覆寫。
                </p>
                <label className="block">
                  匯入前累計實收
                  <input
                    className={field}
                    type="number"
                    min="0"
                    step="0.01"
                    max="100000000"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label className="block">
                  期初核對截至日期
                  <input
                    className={field}
                    type="date"
                    max={businessDate(booking.createdAt)}
                    required
                    value={asOf}
                    onChange={(e) => setAsOf(e.target.value)}
                  />
                </label>
              </>
            )}
            {action === "terms" && (
              <>
                <label className="block">
                  整筆訂單應收總額
                  <input
                    className={field}
                    type="number"
                    min="0"
                    max="100000000"
                    step="0.01"
                    required
                    value={total}
                    onChange={(e) => setTotal(e.target.value)}
                  />
                </label>
                <label className="block">
                  約定訂金（可留空）
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
                <p className="text-sm text-slate-500">
                  增加住宿費、清潔費等應收時，請核對整筆總額。修改應收不會改動已收款明細。
                </p>
              </>
            )}
            {(action === "payment" || action === "opening") && (
              <label className="block">
                備註
                <input
                  className={field}
                  maxLength={500}
                  placeholder="可記錄核對依據，勿填完整卡號或帳戶密碼"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
            )}
            {(action === "terms" ||
              (action === "payment" && kind !== "refund")) && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                若結果超過應收，我已核對並確認保留溢收金額
              </label>
            )}
            {action === "cancel" && (
              <>
                <p className="text-sm leading-6">
                  取消會釋出全部住宿項目的房間。系統要求已確認的實收餘額為
                  0；若仍有款項，請先完成退款登記。平台庫存與客人通知需另外處理。
                </p>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    required
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  確認取消這筆訂單
                </label>
              </>
            )}
            <button className={button}>
              {action === "cancel" ? "確認取消並釋出房間" : "保存並核對"}
            </button>
          </fieldset>
          {command.uncertain && (
            <div className="rounded-xl bg-amber-50 p-4">
              <p>
                結果暫時無法確認，已保留原操作。請重試核對，避免另登記一筆。
              </p>
              <button
                type="button"
                className={`${button} mt-3`}
                disabled={command.busy}
                onClick={() => void submit()}
              >
                重試相同操作
              </button>
            </div>
          )}
        </form>
      )}
      {booking.status === "cancelled" && (
        <p className="mt-4 text-sm">訂單已取消，歷史收退款紀錄保留。</p>
      )}
      <p className="mt-4 text-xs text-slate-500">
        日期以臺北時間顯示 · {today()}
      </p>
    </section>
  );
}
