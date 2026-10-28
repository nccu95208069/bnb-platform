"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { RetainedBookingDetail, RetainedBookingsResponse } from "@/lib/booking-sources/retained-booking-contract";
import { RetainedBookingDialog, RetainedStayList, retainedChannelText, retainedErrorText, retainedFetch, retainedMoney } from "./retained-booking-dialog";
import { readPendingRetainedOrder, type PendingRetainedOrder, type RetainedOrderAction } from "./retained-order-pending";

export type RetainedOrderTarget = { bookingId: string; action: RetainedOrderAction; pendingRequest?: PendingRetainedOrder | null };
type Props = { canWrite: boolean; viewPrices: boolean; storageScope: string; reload: number;
  target: RetainedOrderTarget | null; onTargetHandled: () => void; onChanged: () => void };

function matchesOrder(booking: RetainedBookingDetail, query: string) {
  const normalized = query.normalize("NFKC").trim().toLocaleLowerCase("zh-TW");
  return !normalized || [booking.guestName, booking.contact, booking.bookingId, booking.externalOrderNo,
    booking.sourceOrderRef, booking.reason].some(value => value?.normalize("NFKC").toLocaleLowerCase("zh-TW").includes(normalized));
}

export function RetainedOrdersControl({ canWrite, viewPrices, storageScope, reload, target, onTargetHandled, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<RetainedOrderTarget | null>(null);
  const [data, setData] = useState<RetainedBookingsResponse | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const selectTarget = useCallback((requested: RetainedOrderTarget | null) => {
    try {
      const pending = readPendingRetainedOrder(window.localStorage, storageScope);
      if (pending) { setSelection({ bookingId: pending.bookingId, action: pending.action, pendingRequest: pending }); setOpen(false); }
      else if (requested) { setSelection(requested); setOpen(false); }
      setStorageError("");
    } catch { setStorageError("這台裝置保存的操作狀態無法確認。請先核對訂單結果，再重新操作。"); }
  }, [storageScope]);

  useEffect(() => {
    let active = true;
    const restore = () => { if (active) selectTarget(null); };
    // This synchronizes browser-only durable recovery state after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    restore();
    window.addEventListener("storage", restore);
    return () => { active = false; window.removeEventListener("storage", restore); };
  }, [selectTarget]);
  const requestKey = `${storageScope}:${reload}:${revision}`;
  const loading = loadedKey !== requestKey;
  useEffect(() => {
    const controller = new AbortController();
    retainedFetch("/api/v1/bookings/retained?property=offland", { signal: controller.signal }).then(({ response, value }) => {
      if (!response.ok || !Array.isArray(value.bookings)) throw Error(String(value.code ?? ""));
      setData(value as RetainedBookingsResponse); setError("");
    }).catch(error => {
      if (!controller.signal.aborted) { setData(null); setError(retainedErrorText(error.message)); }
    }).finally(() => { if (!controller.signal.aborted) setLoadedKey(requestKey); });
    return () => controller.abort();
  }, [requestKey]);

  const writeEnabled = canWrite && viewPrices && data?.canWrite === true && !data.priceHidden && !storageError;
  const pricesVisible = viewPrices && data?.priceHidden !== true;
  const bookings = data?.bookings.filter(booking => matchesOrder(booking, query)) ?? [];
  const activeSelection = selection?.pendingRequest ? selection : target ?? selection;
  const verified = useCallback(() => { refresh(); onChanged(); }, [refresh, onChanged]);
  return <>
    <div className="mx-2 flex flex-wrap items-center gap-2 md:mx-0">
      <Button variant="outline" onClick={() => { setOpen(true); refresh(); }}>
        遺忘無際待改期{loading ? " · 載入中" : error ? " · 尚未確認" : ` · ${data?.bookings.length ?? 0}`}
      </Button>
      {storageError && <p role="alert" className="text-sm text-amber-800">{storageError}</p>}
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 text-left"><DialogTitle>遺忘無際待改期</DialogTitle>
          <DialogDescription>所有保留訂單，不限日曆月份。保留訂單不占用住宿日期。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
          <Input aria-label="搜尋保留訂單" placeholder="搜尋姓名、聯絡方式或訂單編號" value={query} onChange={event => setQuery(event.target.value)} />
          {loading && <p role="status">讀取所有待改期訂單中…</p>}
          {error && <div role="alert" className="space-y-2 text-sm text-red-700"><p>{error}</p><Button variant="outline" onClick={refresh}>重新載入清單</Button></div>}
          {!loading && !error && !bookings.length && <p className="py-6 text-center text-sm text-muted-foreground">{query.trim() ? "沒有符合的保留訂單。" : "目前沒有待改期訂單。"}</p>}
          {!loading && !error && bookings.map(booking => <article key={booking.bookingId} className="space-y-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="min-w-0 break-words font-semibold">{booking.guestName || "未填旅客姓名"}</h3>
              <span className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-950">保留訂單・待安排入住</span></div>
            <p className="text-sm">尚未安排入住，不占房</p>
            {booking.contact && <p className="break-words text-sm text-muted-foreground">聯絡方式：{booking.contact}</p>}
            {(booking.externalOrderNo || booking.sourceOrderRef) && <p className="break-words text-sm text-muted-foreground">原訂單編號：{booking.externalOrderNo || booking.sourceOrderRef}</p>}
            <RetainedStayList stays={booking.originalStays} label="原住宿紀錄" />
            <p className="text-sm">{pricesVisible && !booking.priceHidden ? booking.retainedAmountReviewRequired || booking.netReceivedCents === null
              ? "原款項紀錄保留，金額待核對" : `已確認保留款：${retainedMoney(booking.netReceivedCents)}` : "款項金額已隱藏"}</p>
            <p className="text-sm text-muted-foreground">{booking.retainedAt ? `轉保留：${new Date(booking.retainedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}` : "轉保留時間待確認"}</p>
            {booking.reason && <p className="whitespace-pre-wrap break-words text-sm">原因：{booking.reason}</p>}
            <p className="text-sm">{retainedChannelText(booking.externalRoomStatus ?? booking.channelSyncState)}</p>
            <Button variant={writeEnabled && booking.rescheduleEligible ? "default" : "outline"}
              onClick={() => selectTarget({ bookingId: booking.bookingId, action: "reschedule" })}>
              {writeEnabled && booking.rescheduleEligible ? "安排入住" : "查看訂單"}
            </Button>
          </article>)}
          {data?.verifiedAt && !loading && !error && <p className="text-xs text-muted-foreground">確認時間：{new Date(data.verifiedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}</p>}
        </div>
        <DialogFooter className="shrink-0 border-t px-5 py-4"><Button variant="outline" onClick={() => setOpen(false)}>關閉</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {activeSelection && <RetainedBookingDialog key={`${storageScope}:${activeSelection.action}:${activeSelection.bookingId}:${activeSelection.pendingRequest?.requestKey ?? "new"}`}
      {...activeSelection} storageScope={storageScope} canWrite={writeEnabled} viewPrices={pricesVisible}
      onClose={() => { setSelection(null); onTargetHandled(); setOpen(true); refresh(); }} onVerified={verified} />}
  </>;
}
