"use client";
import { useEffect, useState } from "react";
import { staysOf } from "@/lib/customer-workspaces/domain";
import type { WorkspaceView } from "@/lib/customer-workspaces/types";
import { api, button, field, secondary } from "./client";
import { formatMoney } from "./order-finance";
import { useCommand } from "./use-command";

type BookingView = WorkspaceView["bookings"][number];
type Draft = {
  version: number;
  bookingVersion: number;
  original: { checkIn: string; checkOut: string; roomIds: string[]; total: number | null };
  checkIn: string;
  checkOut: string;
  roomIds: string[];
  total: string;
  confirmed: boolean;
  allowOverpayment: boolean;
};

export function OrderAmendment({ data, booking, onSaved, onPendingChange, externalLocked }: {
  data: WorkspaceView;
  booking: BookingView;
  onSaved: (data: WorkspaceView) => void;
  onPendingChange: (pending: boolean) => void;
  externalLocked: boolean;
}) {
  const command = useCommand(`/api/customer-workspaces/${data.slug}/operations`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState("");
  const pending = command.busy || command.uncertain;
  const locked = pending || externalLocked;
  useEffect(() => {
    onPendingChange(pending);
    return () => onPendingChange(false);
  }, [pending, onPendingChange]);
  const property = data.properties.find(p => p.id === booking.propertyId);
  const stays = staysOf(booking);
  const canAmend = data.features?.holds && ["owner", "admin"].includes(data.role) &&
    booking.platform === "Official Website" && booking.entry === "os" &&
    booking.hold?.scope === "platform_only" && ["held", "confirmed"].includes(booking.status) &&
    property?.sourceMode === "native" && (!property.setup || property.setup.mode === "empty") &&
    !data.readiness?.[property.id]?.connected && data.readiness?.[property.id]?.complete !== false &&
    stays.length === 1;

  function open() {
    const stay = stays[0];
    setDraft({ version: data.version, bookingVersion: booking.version,
      original: { ...stay, roomIds: [...stay.roomIds], total: booking.total },
      ...stay, roomIds: [...stay.roomIds], total: booking.total === null ? "" : String(booking.total),
      confirmed: false, allowOverpayment: false });
    setNotice("");
    command.setError("");
  }
  function change(values: Partial<Draft>) {
    setDraft(current => current ? { ...current, ...values, confirmed: false } : null);
  }
  async function save() {
    if (command.busy || externalLocked || !draft) return;
    if (!command.uncertain && (!draft.confirmed || !draft.roomIds.length || !draft.checkIn ||
      draft.checkOut <= draft.checkIn || draft.total.trim() === "" ||
      !Number.isFinite(Number(draft.total)) || Number(draft.total) <= 0)) {
      command.setError("請核對入住、退房日期，至少選一間房，填入整筆總額並勾選確認。");
      return;
    }
    const result = await command.execute<{ workspace: WorkspaceView }>(command.uncertain ? {} : {
      action: "website-amend", bookingId: booking.id, version: draft.version,
      bookingVersion: draft.bookingVersion, checkIn: draft.checkIn, checkOut: draft.checkOut,
      roomIds: draft.roomIds, total: Number(draft.total), confirmed: draft.confirmed,
      allowOverpayment: draft.allowOverpayment,
    });
    if (result) {
      onSaved(result.data.workspace);
      setDraft(null);
      setNotice("已更新並重新查回同一筆訂單。官網通知已排入寄送佇列，實際送達仍待確認。");
    }
  }
  if (!canAmend || !property) return null;
  const roomNames = (ids: string[]) => property.rooms.filter(room => ids.includes(room.id)).map(room => room.name).join("、");
  return <section className="mt-5 rounded-2xl border bg-white p-5">
    <h2 className="text-lg font-semibold">官網訂單改期與換房</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">更新同一筆訂單的住宿與應收總額，已登記的實收款項保持不變。新房間是否可用會在儲存時核對。</p>
    {notice && <p role="status" className="mt-3 rounded-xl bg-teal-50 p-3">{notice}</p>}
    {!draft && <button type="button" className={`${secondary} mt-4`} disabled={locked} onClick={open}>改期／換房與總額</button>}
    {draft && <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="rounded-xl bg-stone-50 p-4 text-sm leading-6">
        <h3 className="font-semibold">變更前</h3>
        <p>{draft.original.checkIn} 入住 → {draft.original.checkOut} 退房</p>
        <p>房間：{roomNames(draft.original.roomIds)}</p>
        <p>整筆應收：{formatMoney(draft.original.total)}</p>
      </div>
      <fieldset disabled={locked} className="space-y-4">
        <legend className="mb-3 font-semibold">變更後</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">新入住日期<input type="date" required min="2000-01-01" max="2100-12-30" className={field} value={draft.checkIn} onChange={event => change({ checkIn: event.target.value })} /></label>
          <label className="block">新退房日期<input type="date" required min={draft.checkIn || "2000-01-02"} max="2100-12-31" className={field} value={draft.checkOut} onChange={event => change({ checkOut: event.target.value })} /></label>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-2">新房間（{property.name}，至少選一間）</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {property.rooms.map(room => <label key={room.id} className="flex min-h-11 items-center gap-3 rounded-xl border p-3">
              <input type="checkbox" checked={draft.roomIds.includes(room.id)} onChange={event => change({ roomIds: event.target.checked ? [...draft.roomIds, room.id] : draft.roomIds.filter(id => id !== room.id) })} />
              {room.name}
            </label>)}
          </div>
        </fieldset>
        <label className="block">新整筆應收總額<input type="number" min="0.01" max="100000000" step="0.01" required className={field} value={draft.total} onChange={event => change({ total: event.target.value })} /></label>
        <p className="text-sm leading-6 text-slate-600">請填全部房間與全部晚數合計的總額。改期或換房不會自動計價，原報價與逐晚價格不代表本次新價格。</p>
        <label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1" checked={draft.allowOverpayment} onChange={event => change({ allowOverpayment: event.target.checked })} />若新總額低於已實收，我已核對並確認保留溢收金額</label>
        <p className="rounded-xl bg-amber-50 p-3 text-sm leading-6">{booking.status === "held" ? "原 24 小時保留期限不因改期或換房重置；已延長的期限也保持不變。" : "此訂單維持正式訂單，不會重新建立 24 小時保留期限。"}官網通知會排入寄送佇列，實際送達仍待確認。外部通路庫存仍需另外核對。</p>
        <label className="flex items-start gap-2 leading-6"><input type="checkbox" required className="mt-1" checked={draft.confirmed} onChange={event => setDraft({ ...draft, confirmed: event.target.checked })} />我已核對新日期、房間與整筆總額，確認更新同一筆訂單</label>
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={!draft.confirmed || !draft.roomIds.length}>確認改期／換房並核對</button>
          <button type="button" className={secondary} onClick={() => { setDraft(null); command.setError(""); }}>取消變更</button>
        </div>
      </fieldset>
    </form>}
    {command.error && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3">{command.error}</p>}
    {command.uncertain ? <div className="mt-3 rounded-xl bg-amber-50 p-3">
      <p className="text-sm">結果暫時無法確認，原日期、房間與總額操作已保留；請重試核對結果。</p>
      <button type="button" className={`${button} mt-3`} disabled={command.busy} onClick={() => void save()}>重試相同改期／換房操作</button>
    </div> : command.error && <button type="button" className={`${secondary} mt-3`} disabled={locked} onClick={async () => {
      try {
        onSaved(await api<WorkspaceView>(`/api/customer-workspaces/${data.slug}`));
        setDraft(null); command.setError(""); setNotice("已重新載入，請重新選擇並核對日期、房間與整筆總額。");
      } catch (error) { command.setError((error as Error).message); }
    }}>重新載入最新資料</button>}
  </section>;
}
