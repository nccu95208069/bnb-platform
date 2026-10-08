"use client";
import { useEffect, useState } from "react";
import type { WorkspaceView } from "@/lib/customer-workspaces/types";
import { bookingStatusLabel } from "@/lib/customer-workspaces/hold-state";
import { api, button, field, secondary } from "./client";
import { useCommand } from "./use-command";

export function HoldControls({ data, booking, onSaved, onPendingChange, externalLocked }: {
  data: WorkspaceView; booking: WorkspaceView["bookings"][number]; onSaved: (data: WorkspaceView) => void;
  onPendingChange: (pending: boolean) => void; externalLocked: boolean;
}) {
  const command = useCommand(`/api/customer-workspaces/${data.slug}/operations`);
  const [action, setAction] = useState(""), [notice, setNotice] = useState("");
  const [scope, setScope] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [amount, setAmount] = useState(""), [method, setMethod] = useState("cash");
  const [account, setAccount] = useState(""), [overpayment, setOverpayment] = useState(false);
  const [deadline, setDeadline] = useState("");
  const [receivedAt, setReceivedAt] = useState(() => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16));
  const pending = command.busy || command.uncertain, locked = pending || externalLocked;
  useEffect(() => { onPendingChange(pending); return () => onPendingChange(false); }, [pending, onPendingChange]);
  const property = data.properties.find(p => p.id === booking.propertyId);
  const canManage = data.features?.holds && ["owner", "admin"].includes(data.role);
  const isPayment = ["hold-convert", "hold-late-payment", "hold-refund"].includes(action);
  async function save(extra: Record<string, unknown> = {}) {
    const result = await command.execute<{ workspace: WorkspaceView }>({
      action, bookingId: booking.id, bookingVersion: booking.version, version: data.version,
      confirmPlatformOnly: scope, ...extra,
    });
    if (result) { onSaved(result.data.workspace); setAction(""); setScope(false); setConfirmed(false); setNotice("已儲存並重新查回。"); }
  }
  if (!booking.hold) return null;
  return <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-5">
    <h2 className="text-lg font-semibold">{bookingStatusLabel(booking)}</h2>
    <p className="mt-2 text-sm">保留期限：{new Date(booking.hold.expiresAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}（臺北）</p>
    <p className="mt-2 text-sm">{booking.hold.state === "converted" ? "此單已從保留轉為正式訂單，後續以訂單與款項狀態為準。" : booking.status === "cancelled" ? "此保留已釋出，本工作區不再由這張單占用房間。" : "本工作區保留。外部通路尚未同步；到期後仍保留房間，等待業主決定。"}</p>
    {booking.hold.latePaymentReview && <p role="status" className="mt-2 font-medium">釋出後收到款項，待人工處理；此筆款項不會重新占用房間。</p>}
    {notice && <p role="status" className="mt-3">{notice}</p>}
    {canManage && booking.status !== "confirmed" && booking.hold.state !== "converted" && <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        {(booking.status === "held" ? [["hold-extend", "延長保留"], ["hold-convert", "確認已收訂金"], ["hold-release", "釋出保留"]] : [["hold-late-payment", "登記釋出後到款"], ["hold-refund", "登記退款"]]).map(([value, label]) =>
          <button type="button" key={value} disabled={locked} className={secondary} onClick={() => { setAction(value); setScope(false); setConfirmed(false); command.setError(""); }}>{label}</button>)}
      </div>
      {action && <form className="mt-4" onSubmit={e => { e.preventDefault(); void save(isPayment ? { amount: Number(amount), method, receiptAccountId: account || undefined, receivedAt: `${receivedAt}+08:00`, confirmedReceipt: confirmed, allowOverpayment: overpayment } : action === "hold-extend" ? { expiresAt: new Date(`${deadline}+08:00`).toISOString() } : {}); }}>
        <fieldset disabled={locked} className="space-y-3">
          {action === "hold-extend" && <>
            <div className="flex gap-2">{[12, 24].map(hours => <button type="button" className={secondary} key={hours} disabled={!scope} onClick={() => void save({ hours })}>延長 {hours} 小時</button>)}</div>
            <label className="block">或指定更晚期限（臺北）<input type="datetime-local" className={field} required value={deadline} onChange={e => setDeadline(e.target.value)} /></label>
          </>}
          {isPayment && <>
            <label className="block">實際{action === "hold-refund" ? "退款" : "收款"}金額<input type="number" min="0.01" max="100000000" step="0.01" required className={field} value={amount} onChange={e => setAmount(e.target.value)} /></label>
            <label className="block">入帳時間（臺北）<input type="datetime-local" required className={field} value={receivedAt} onChange={e => setReceivedAt(e.target.value)} /></label>
            <label className="block">方式<select className={field} value={method} onChange={e => { setMethod(e.target.value); setAccount(""); }}><option value="cash">現金</option><option value="bank">轉帳</option><option value="card">信用卡</option><option value="other">其他</option></select></label>
            {method !== "cash" && <label className="block">入帳帳戶<select className={field} required={["bank", "card"].includes(method)} value={account} onChange={e => setAccount(e.target.value)}><option value="">請選擇</option>{property?.receiptAccounts?.map(a => <option key={a.id} value={a.id}>{a.name} · •••• {a.last4}</option>)}</select></label>}
            <label className="flex gap-2"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核對實際{action === "hold-refund" ? "退款" : "入帳"}，金額與時間正確。</label>
            {action !== "hold-refund" && <label className="flex gap-2"><input type="checkbox" checked={overpayment} onChange={e => setOverpayment(e.target.checked)} />若超過房費，我已核對並確認保留溢收。</label>}
          </>}
          {action === "hold-release" && <p>確認後解除這張保留單的房況占用。其他訂單與關房紀錄會繼續保留。</p>}
          <label className="flex gap-2 text-sm"><input type="checkbox" required checked={scope} onChange={e => setScope(e.target.checked)} />我確認這次操作僅更新本工作區，外部通路需另外核對。</label>
          <button className={button}>確認{action === "hold-release" ? "釋出" : "儲存"}</button>
          <button className={`${secondary} ml-2`} type="button" onClick={() => setAction("")}>取消</button>
        </fieldset>
      </form>}
      {command.error && <p role="alert" className="mt-3 text-red-800">{command.error}</p>}
      {command.uncertain ? <button className={`${button} mt-3`} disabled={command.busy} onClick={() => void save()}>重試相同操作並核對結果</button> : command.error && <button disabled={locked} className={`${secondary} mt-3`} onClick={async () => { try { onSaved(await api<WorkspaceView>(`/api/customer-workspaces/${data.slug}`)); setAction(""); command.setError(""); } catch (e) { command.setError((e as Error).message); } }}>重新載入最新資料</button>}
    </div>}
  </section>;
}
