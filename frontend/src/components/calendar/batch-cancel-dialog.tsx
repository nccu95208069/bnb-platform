"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, LoaderCircle, Trash2 } from "lucide-react";

import type { CalendarBooking, CalendarProperty } from "./calendar-types";
import { addDays } from "./calendar-utils";
import { apiClient } from "@/lib/api-client";
import { useT } from "@/components/i18n/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type PreviewRow = { id: string; date: string; room: string; guest: string; orderNumber: string | null; sourceLinked: boolean; sourcePaid: boolean };
type Preview = { digest: string; rows: PreviewRow[]; omitted: PreviewRow[]; roomNightCount: number;
  distinctOrderCount: number; formalOrderCount: number; unlinkedRoomNightCount: number;
  paidRoomNightCount: number; financialBlockCount: number; canConfirm: boolean };

export function BatchCancelDialog({ open, onOpenChange, bookings, properties, initialStart, initialEnd, onVerified }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookings: CalendarBooking[];
  properties: CalendarProperty[];
  initialStart: string;
  initialEnd: string;
  onVerified: (ids: string[]) => void;
}) {
  const t = useT();
  return <Dialog open={open} onOpenChange={onOpenChange}>
    {open && <DialogContent className="max-h-[90dvh] w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t("批次刪除已售訂單")}</DialogTitle>
        <DialogDescription>{t("先選房晚，再核對完整訂單範圍。主表刪除經確認後，日曆同步可能稍後才完成；此操作不會自動退款或取消 OTA 訂單。")}</DialogDescription>
      </DialogHeader>
      <BatchCancelForm bookings={bookings} properties={properties} initialStart={initialStart}
        initialEnd={initialEnd} onOpenChange={onOpenChange} onVerified={onVerified} />
    </DialogContent>}
  </Dialog>;
}

export function BatchCancelForm({ bookings, properties, initialStart, initialEnd, onOpenChange, onVerified }: {
  bookings: CalendarBooking[];
  properties: CalendarProperty[];
  initialStart: string;
  initialEnd: string;
  onOpenChange: (open: boolean) => void;
  onVerified: (ids: string[]) => void;
}) {
  const t = useT();
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? "");
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(addDays(initialEnd, -1));
  const [guest, setGuest] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acknowledgePaid, setAcknowledgePaid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const candidates = useMemo(() => bookings
    .filter(booking => booking.property_id === propertyId && booking.source_read_only &&
      !booking.source_conflict && !booking.snapshot_only && booking.reservation_status === "confirmed" &&
      booking.check_in >= start && booking.check_in <= end &&
      (!guest.trim() || booking.guest_name.toLocaleLowerCase().includes(guest.trim().toLocaleLowerCase())))
    .sort((a, b) => a.check_in.localeCompare(b.check_in) || a.room_number.localeCompare(b.room_number) || a.id.localeCompare(b.id)),
    [bookings, propertyId, start, end, guest]);

  function choose(ids: string[]) {
    setSelected(ids);
    setPreview(null);
    setAcknowledgePaid(false);
    setError("");
  }

  async function showPreview() {
    if (!propertyId || selected.length < 1 || selected.length > 100) return;
    setBusy(true); setError("");
    try {
      const result = await apiClient.post<Preview>("/bookings/batch-cancel", { action: "preview", property_id: propertyId, ids: selected });
      setPreview(result);
    } catch (failure) { setPreview(null); setError(failure instanceof Error ? failure.message : "目前無法預覽，請稍後重試。"); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!preview?.canConfirm || (preview.paidRoomNightCount > 0 && !acknowledgePaid)) return;
    setBusy(true); setError("");
    try {
      const result = await apiClient.post<{ verified: boolean; deletedIds: string[] }>("/bookings/batch-cancel", {
        action: "confirm", property_id: propertyId, ids: selected, digest: preview.digest,
        acknowledge_paid: acknowledgePaid, request_id: crypto.randomUUID(),
      });
      if (!result.verified || result.deletedIds.length !== selected.length || result.deletedIds.some(id => !selectedSet.has(id))) throw Error("刪除結果無法確認，請重新載入核對。");
      onVerified(result.deletedIds);
      onOpenChange(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "目前無法刪除，請重新載入核對。"); }
    finally { setBusy(false); }
  }

  const allFilteredSelected = candidates.length > 0 && candidates.every(booking => selectedSet.has(booking.id));
  return <>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2"><Label htmlFor="batch-property">{t("旅宿")}</Label>
        <select id="batch-property" value={propertyId} disabled={busy} onChange={event => { setPropertyId(event.target.value); choose([]); }}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm">
          {properties.map(property => <option key={property.id} value={property.id}>{property.name}</option>)}
        </select>
      </div>
      <div className="space-y-1"><Label htmlFor="batch-start">{t("從住宿日期")}</Label><Input id="batch-start" type="date" value={start} disabled={busy} onChange={event => { setStart(event.target.value); choose(selected); }} /></div>
      <div className="space-y-1"><Label htmlFor="batch-end">{t("至住宿日期（含）")}</Label><Input id="batch-end" type="date" value={end} disabled={busy} onChange={event => { setEnd(event.target.value); choose(selected); }} /></div>
      <div className="space-y-1 sm:col-span-2"><Label htmlFor="batch-guest">{t("旅客姓名篩選")}</Label><Input id="batch-guest" value={guest} disabled={busy} onChange={event => { setGuest(event.target.value); choose(selected); }} placeholder={t("輸入姓名片段；仍需勾選每個房晚")} /></div>
    </div>
    <section aria-label={t("可選房晚")} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{t("符合條件：{0} 房晚；已選：{1} 房晚", [candidates.length, selected.length])}</span>
        <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={busy || !selected.length} onClick={() => choose([])}>{t("清除全部已選")}</Button>
        <Button size="sm" variant="outline" disabled={busy || candidates.length === 0 || candidates.length > 100}
          onClick={() => choose(allFilteredSelected ? selected.filter(id => !candidates.some(booking => booking.id === id)) : [...new Set([...selected, ...candidates.map(booking => booking.id)])])}>
          {t(allFilteredSelected ? "取消勾選篩選結果" : "勾選篩選結果")}
        </Button></div>
      </div>
      {candidates.length > 100 && <p className="text-xs text-amber-700">{t("範圍超過 100 房晚，請縮小日期或姓名後再選。")}</p>}
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
        {candidates.slice(0, 100).map(booking => <label key={booking.id} className="flex min-h-10 items-center gap-2 rounded px-2 text-sm hover:bg-muted">
          <input type="checkbox" checked={selectedSet.has(booking.id)} disabled={busy}
            onChange={event => choose(event.target.checked ? [...selected, booking.id] : selected.filter(id => id !== booking.id))} />
          <span className="min-w-0 flex-1 break-words">{booking.check_in} · {booking.room_number} · {booking.guest_name}</span>
          <span className="text-xs text-muted-foreground">{booking.source_order_linked && booking.owlnest_order_no || t("未提供正式編號")}</span>
        </label>)}
        {!candidates.length && <p className="px-2 py-3 text-sm text-muted-foreground">{t("此範圍沒有可選的已確認房晚。")}</p>}
      </div>
    </section>
    {preview && <section aria-label={t("刪除預覽")} className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><div>
        <p className="font-semibold">{t("將刪除 {0} 房晚，涉及 {1} 個獨立來源訂單／紀錄", [preview.roomNightCount, preview.distinctOrderCount])}</p>
        <p className="text-xs">{t("其中有正式編號的訂單 {0} 個；未提供正式編號的房晚 {1} 筆（逐列識別）。", [preview.formalOrderCount, preview.unlinkedRoomNightCount])}</p>
      </div></div>
      <ul className="max-h-40 space-y-1 overflow-y-auto">{preview.rows.map(row => <li key={row.id}>{row.date} · {row.room} · {row.guest} · {row.orderNumber || t("未提供正式編號")}</li>)}</ul>
      {preview.omitted.length > 0 && <div className="rounded-lg border border-red-300 bg-white p-2">
        <p className="font-semibold text-red-800">{t("部分原訂單還有其他日期；目前不能刪除。")}</p>
        <ul className="mt-1 space-y-1">{preview.omitted.map(row => <li key={row.id}>{row.date} · {row.room} · {row.guest} · {row.orderNumber || t("未提供正式編號")}</li>)}</ul>
        <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => choose([...new Set([...selected, ...preview.omitted.map(row => row.id)])])}>{t("加入上述房晚並重新預覽")}</Button>
      </div>}
      {preview.financialBlockCount > 0 && <p className="font-semibold text-red-800">{t("有 {0} 個訂單已有 OS 收款或財務紀錄。請先走取消與對帳流程。", [preview.financialBlockCount])}</p>}
      {preview.paidRoomNightCount > 0 && <label className="flex items-start gap-2 rounded-lg border bg-white p-2">
        <input type="checkbox" checked={acknowledgePaid} disabled={busy} onChange={event => setAcknowledgePaid(event.target.checked)} />
        <span>{t("其中 {0} 房晚在來源標記為已付；我知道刪除不會自動退款或更改 OTA 狀態。", [preview.paidRoomNightCount])}</span>
      </label>}
    </section>}
    {error && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p>}
    <DialogFooter className="gap-2">
      <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("關閉")}</Button>
      <Button variant="outline" disabled={busy || selected.length < 1 || selected.length > 100 || !propertyId || start > end} onClick={() => void showPreview()}>{t("預覽刪除範圍")}</Button>
      <Button variant="destructive" disabled={busy || !preview?.canConfirm || (preview.paidRoomNightCount > 0 && !acknowledgePaid)} onClick={() => void confirm()}>
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{t("確認刪除 {0} 房晚", [preview?.roomNightCount ?? 0])}
      </Button>
    </DialogFooter>
  </>;
}
