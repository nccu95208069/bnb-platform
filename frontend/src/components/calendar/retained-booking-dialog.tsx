"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { stayNights, twdCents } from "@/lib/booking-sources/manual-booking-form";
import type { RetainedBookingDetail, RetainedBookingPreview, RetainedBookingRequestResult, RetainedStay } from "@/lib/booking-sources/retained-booking-contract";
import { clearPendingRetainedOrder, savePendingRetainedOrder, type PendingRetainedOrder, type RetainedOrderAction, type RetainedCommand } from "./retained-order-pending";

const BASE = "/api/v1/bookings/retained";
const ERROR_TEXT: Record<string, string> = {
  ROOM_CONFLICT: "新日期已有訂單或封房，請重新選擇；保留訂單尚未變動。",
  VERSION_CONFLICT: "訂單或房況已變更，請重新載入後再次預覽。",
  MANUAL_VERSION_CONFLICT: "訂單或房況已變更，請重新載入後再次預覽。",
  BOOKING_VERSION_CONFLICT: "訂單已變更，請重新載入後再次預覽。",
  INVENTORY_VERSION_CONFLICT: "房況已變更，請重新載入後再次檢查。",
  FORBIDDEN: "目前沒有操作這張訂單的權限。",
  MANUAL_FORBIDDEN: "目前沒有操作這張訂單的權限。",
  MANUAL_UNAUTHORIZED: "登入已過期，請重新登入後再確認結果。",
  NOT_FOUND: "目前無法找到這張訂單，請回到清單重新查詢。",
  RETENTION_NOT_ALLOWED: "這張訂單目前不能轉為保留，請重新載入確認狀態。",
  RESCHEDULE_NOT_ALLOWED: "這張訂單目前不能安排入住，請重新載入確認狀態。",
  SOURCE_AMEND_REQUIRES_REVIEW: "這張訂單的來源或房晚仍需核對，請先處理這張訂單的差異。",
};
export const retainedErrorText = (code: unknown) => typeof code === "string" && ERROR_TEXT[code] || "暫時無法完成操作，請重新載入確認；原款項紀錄不會因此變動。";
export const retainedMoney = (amount: number | null | undefined) => amount === null || amount === undefined
  ? "待核對" : `NT$ ${(amount / 100).toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;
export function retainedChannelText(state: string | null | undefined) {
  return ({ not_required: "外部房況：無需同步", not_integrated: "外部房況：尚未串接，請另行確認", verified: "外部房況：已回讀驗證",
    pending: "外部房況：同步中，尚未驗證", sync_pending: "外部房況：同步中，尚未驗證",
    action_required: "外部房況：待人工處理", awaiting_manual_sync: "外部房況：尚待同步",
    review_required: "外部房況：需核對", manually_confirmed: "外部房況：已人工確認" } as Record<string, string>)[state ?? ""] ?? "外部房況：尚未確認";
}
export function RetainedStayList({ stays, label }: { stays: RetainedStay[]; label: string }) {
  return <section className="space-y-2 text-sm" aria-label={label}><h3 className="font-semibold">{label}</h3>
    {stays.length ? <ul className="space-y-1 rounded-lg border p-3">{stays.map((stay, index) =>
      <li key={`${stay.checkIn}:${stay.checkOut}:${index}`} className="break-words">
        {stay.roomNumbers.join("、")} · {stay.checkIn} 入住 → {stay.checkOut} 退房
      </li>)}</ul> : <p className="text-muted-foreground">尚未安排住宿日期</p>}</section>;
}

export async function retainedFetch(path: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(path, { ...options, cache: "no-store", signal: controller.signal });
    const value = await response.json().catch(() => ({}));
    return { response, value };
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}
type FormStay = { key: string; checkIn: string; checkOut: string };
type Props = { bookingId: string; action: RetainedOrderAction; storageScope: string;
  canWrite: boolean; viewPrices: boolean; pendingRequest?: PendingRetainedOrder | null;
  onClose: () => void; onVerified: () => void };

export function RetainedBookingDialog({ bookingId, action, storageScope, canWrite, viewPrices,
  pendingRequest = null, onClose, onVerified }: Props) {
  const [detail, setDetail] = useState<RetainedBookingDetail | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState(action === "retain" ? "旅客改期，新日期未定" : "旅客已確認新住宿日期");
  const [segments, setSegments] = useState<FormStay[]>([{ key: "first", checkIn: "", checkOut: "" }]);
  const [nightPrices, setNightPrices] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<RetainedBookingPreview | null>(null);
  const [previewFor, setPreviewFor] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [pending, setPending] = useState<PendingRetainedOrder | null>(pendingRequest);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [result, setResult] = useState<RetainedBookingRequestResult | null>(null);
  const verifiedCallback = useRef(onVerified);
  useEffect(() => { verifiedCallback.current = onVerified; }, [onVerified]);
  const completeRequest = useCallback((value: RetainedBookingRequestResult, request: PendingRetainedOrder) => {
    if (!["applied", "not_applied"].includes(value.outcome) || value.readbackVerified !== true ||
      value.bookingId !== request.bookingId || value.requestKey !== request.requestKey) return false;
    clearPendingRetainedOrder(window.localStorage, storageScope, request.requestKey);
    setPending(null); setError("");
    if (value.outcome === "not_applied") {
      setResult(null); setPreview(null); setPreviewFor(""); setLoadRevision(revision => revision + 1);
      setNotice("已確認原操作未套用，並停止這次操作。請依最新訂單重新預覽。");
    } else setResult(value);
    verifiedCallback.current();
    return true;
  }, [storageScope]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setPreview(null); setPreviewFor("");
    retainedFetch(`${BASE}/${encodeURIComponent(bookingId)}`, { signal: controller.signal }).then(({ response, value }) => {
      if (!response.ok) throw Error(String(value.code ?? ""));
      if (value.bookingId !== bookingId || !Array.isArray(value.stays) || !Array.isArray(value.originalStays)) throw Error("INVALID_RESPONSE");
      setDetail(value as RetainedBookingDetail);
    }).catch(error => {
      if (!controller.signal.aborted) { setDetail(null); setError(retainedErrorText(error.message)); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [bookingId, loadRevision]);

  useEffect(() => {
    if (!pending || busy || recoveryAttempt >= 3) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      retainedFetch(`${BASE}/requests/${encodeURIComponent(pending.requestKey)}`, { signal: controller.signal })
        .then(({ response, value }) => {
          if (!response.ok || !completeRequest(value as RetainedBookingRequestResult, pending)) throw Error("RECOVERY_PENDING");
        }).catch(() => {
          if (!controller.signal.aborted) setRecoveryAttempt(attempt => attempt + 1);
        });
    }, recoveryAttempt === 0 ? 0 : recoveryAttempt * 1200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [pending, busy, recoveryAttempt, completeRequest]);

  const stays: RetainedStay[] = segments.map(segment => ({ checkIn: segment.checkIn, checkOut: segment.checkOut, roomNumbers: ["包棟"] }));
  const nights = stays.flatMap(stay => stayNights(stay.checkIn, stay.checkOut));
  const roomNightPrices = nights.map(date => ({ roomNumber: "包棟", date, amountCents: twdCents(nightPrices[date] ?? "") }));
  const totalCents = roomNightPrices.every(row => row.amountCents !== null) && roomNightPrices.length
    ? roomNightPrices.reduce((sum, row) => sum + (row.amountCents ?? 0), 0) : null;
  const payload = { reason: reason.trim(), ...(action === "reschedule" ? { stays, totalCents, roomNightPrices } : {}) };
  const fingerprint = JSON.stringify([detail?.version, payload]);
  const validPreview = preview && previewFor === fingerprint;
  const eligible = action === "retain" ? detail?.retentionEligible : detail?.rescheduleEligible;
  const pricesVisible = viewPrices && detail?.priceHidden !== true;
  const editable = canWrite && pricesVisible && eligible === true && !pending && !result && !busy;
  const originalStays = preview?.previousStays ?? (action === "retain" ? detail?.stays : detail?.originalStays) ?? [];
  const receivedCents = validPreview ? preview.netReceivedCents : detail?.netReceivedCents;
  const moneyUnknown = (validPreview ? preview.retainedAmountReviewRequired : detail?.retainedAmountReviewRequired) !== false || receivedCents === null || receivedCents === undefined;
  const displayStatus = result?.currentStatus ?? detail?.status;

  async function submit() {
    if (inFlight.current || !editable || !detail) return;
    setError(""); setNotice("");
    if (!reason.trim()) { setError("請填寫這次操作的原因。"); return; }
    if (action === "reschedule") {
      if (stays.some(stay => !stayNights(stay.checkIn, stay.checkOut).length)) { setError("請填寫每一段的入住與退房日期；退房必須晚於入住。"); return; }
      if (nights.length > 120) { setError("一次最多安排 120 個房晚，請縮短住宿日期。"); return; }
      if (new Set(nights).size !== nights.length) { setError("包棟的住宿日期不能重複，請調整住宿段。"); return; }
      if (totalCents === null) { setError("請填妥每晚房費，再檢查房況。"); return; }
    }
    inFlight.current = true; setBusy(true);
    try {
      if (!validPreview) {
        const { response, value } = await retainedFetch(`${BASE}/${bookingId}/${action}-preview`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
        });
        if (!response.ok) throw Error(String(value.code ?? ""));
        if (value.bookingId !== bookingId || !Number.isSafeInteger(value.bookingVersion) || !Number.isSafeInteger(value.inventoryVersion)) throw Error("INVALID_RESPONSE");
        setPreview(value as RetainedBookingPreview); setPreviewFor(fingerprint);
        return;
      }
      const command = { ...payload, expectedBookingVersion: preview.bookingVersion, expectedInventoryVersion: preview.inventoryVersion } as RetainedCommand;
      const request: PendingRetainedOrder = { schema: 1, requestKey: crypto.randomUUID(), bookingId, action, createdAt: Date.now(), payload: command };
      try { savePendingRetainedOrder(window.localStorage, storageScope, request); }
      catch { setError("無法安全保存這次操作，或仍有尚未確認的操作。請先關閉表單，回待改期清單確認結果後再試。"); return; }
      try {
        const { response, value } = await retainedFetch(`${BASE}/${bookingId}/${action}`, { method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": request.requestKey },
          body: JSON.stringify(request.payload),
        });
        if (response.ok && completeRequest(value as RetainedBookingRequestResult, request)) {
          // The final readback, including a durable non-application receipt, owns the result.
        } else if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          clearPendingRetainedOrder(window.localStorage, storageScope, request.requestKey);
          setPreview(null); setPreviewFor(""); setError(retainedErrorText(value.code));
        } else { setPending(request); setRecoveryAttempt(0); }
      } catch { setPending(request); setRecoveryAttempt(0); }
    } catch (error) { setPreview(null); setPreviewFor(""); setError(retainedErrorText(error instanceof Error ? error.message : "")); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function resendPending() {
    if (!pending || inFlight.current || !canWrite || !pricesVisible) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const { response, value } = await retainedFetch(`${BASE}/${pending.bookingId}/${pending.action}`, {
        method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": pending.requestKey },
        body: JSON.stringify(pending.payload),
      });
      if (response.ok && completeRequest(value as RetainedBookingRequestResult, pending)) {
        // Exact replay completed or was conclusively stopped.
      } else if (!response.ok && response.status < 500 && response.status !== 408 && response.status !== 429) {
        setError(`${retainedErrorText(value.code)}系統仍保留原操作，會再次確認結果。`);
      }
    } catch { /* Keep the exact command until authoritative readback succeeds. */ }
    finally { setRecoveryAttempt(0); inFlight.current = false; setBusy(false); }
  }

  async function abandonPending() {
    if (!pending || inFlight.current || !canWrite || !pricesVisible) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const { response, value } = await retainedFetch(`${BASE}/${pending.bookingId}/abandon`, {
        method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": pending.requestKey },
        body: JSON.stringify({ action: pending.action, input: pending.payload }),
      });
      if (!response.ok || !completeRequest(value as RetainedBookingRequestResult, pending))
        setError("還無法確認原操作是否停止。系統會保留原操作並繼續確認，請勿另建訂單。");
    } catch { setError("尚未確認原操作是否停止，請稍後再確認結果。"); }
    finally { setRecoveryAttempt(0); inFlight.current = false; setBusy(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy} className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
      <DialogHeader className="shrink-0 border-b px-5 py-4 text-left"><DialogTitle>
        {!canWrite ? "保留訂單詳情" : action === "retain" ? "轉為保留訂單" : "重新安排入住"}</DialogTitle>
        <DialogDescription>{!canWrite ? "查看原住宿與保留狀態。完成權限與最新狀態確認後才能變更訂單。" : action === "retain" ? "保留原訂單與款項紀錄，釋放原住宿安排；新日期確定後再安排入住。" : "使用原訂單安排新日期，確認房況與房費後才會占用新房晚。"}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
        {loading && <p role="status">讀取訂單中…</p>}
        {detail && <>
          <div className="space-y-1"><p className="font-semibold">{detail.guestName || "未填旅客姓名"}</p><p className="text-sm text-muted-foreground">遺忘無際 · {displayStatus === "retained" ? "保留訂單・待安排入住" : displayStatus === "cancelled" ? "已取消" : "正式訂單"}</p>
            {detail.contact && <p className="break-words text-sm">聯絡方式：{detail.contact}</p>}
            {(detail.externalOrderNo || detail.sourceOrderRef) && <p className="break-words text-sm">原訂單編號：{detail.externalOrderNo || detail.sourceOrderRef}</p>}
            {detail.retainedAt && <p className="text-sm text-muted-foreground">轉保留：{new Date(detail.retainedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}</p>}
            {detail.reason && <p className="whitespace-pre-wrap break-words text-sm">保留原因：{detail.reason}</p>}
          </div>
          <RetainedStayList stays={originalStays} label={action === "retain" && !result ? "將釋放的原住宿" : "原住宿紀錄"} />
          <div className="space-y-1 rounded-lg border p-3 text-sm">
            <p>{pricesVisible ? moneyUnknown ? "原款項紀錄保留，金額待核對" : `已確認保留款：${retainedMoney(receivedCents)}` : "款項金額已隱藏"}</p>
            <p className="text-muted-foreground">此操作不會新增收款、退款或自動結算差額。</p>
            <p>{retainedChannelText(preview?.externalRoomStatus ?? preview?.channelSyncState ?? detail.externalRoomStatus ?? detail.channelSyncState)}</p>
          </div>
          {action === "retain" && <p className="text-sm">新住宿日期：尚未決定，目前不保留房間。保留期限：未設定。</p>}
          {!eligible && !result && !pending && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">這張訂單目前不能{action === "retain" ? "轉為保留" : "重新安排入住"}，請重新載入確認訂單及相關房況。</p>}
          {action === "reschedule" && pricesVisible && canWrite && !result && !pending && <fieldset disabled={!editable} className="min-w-0 space-y-4">
            <legend className="mb-2 font-semibold">新住宿安排</legend>
            {nights.length > 120 && <p role="alert" className="text-sm text-red-700">一次最多安排 120 個房晚，請縮短住宿日期。</p>}
            {segments.map((segment, index) => <section key={segment.key} className="min-w-0 space-y-3 rounded-lg border p-3" aria-label={`第 ${index + 1} 段新住宿`}>
              <div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">第 {index + 1} 段 · 包棟</p>
                {segments.length > 1 && <Button variant="ghost" size="sm" onClick={() => setSegments(current => current.filter(item => item.key !== segment.key))}>移除第 {index + 1} 段</Button>}</div>
              <div className="grid min-w-0 grid-cols-2 gap-3">{(["checkIn", "checkOut"] as const).map(field => <div key={field} className="min-w-0 space-y-1">
                <Label htmlFor={`retained-${segment.key}-${field}`}>{field === "checkIn" ? "入住日期" : "退房日期"}</Label>
                <Input id={`retained-${segment.key}-${field}`} type="date" className="min-w-0 max-w-full text-base" value={segment[field]} aria-label={`第 ${index + 1} 段${field === "checkIn" ? "入住" : "退房"}日期`}
                  min={field === "checkOut" && segment.checkIn ? segment.checkIn : undefined}
                  onChange={event => setSegments(current => current.map(item => item.key === segment.key ? { ...item, [field]: event.target.value } : item))} />
              </div>)}</div>
              {nights.length <= 120 && stayNights(segment.checkIn, segment.checkOut).map(date => <div key={date} className="grid min-w-0 grid-cols-[minmax(0,1fr)_8rem] items-center gap-3">
                <Label htmlFor={`retained-price-${segment.key}-${date}`}>{date} 房費</Label>
                <Input id={`retained-price-${segment.key}-${date}`} aria-label={`${date} 房費`} inputMode="numeric" className="min-w-0 text-base" placeholder="台幣" value={nightPrices[date] ?? ""}
                  onChange={event => setNightPrices(current => ({ ...current, [date]: event.target.value }))} />
              </div>)}
            </section>)}
            <Button variant="outline" disabled={!editable || segments.length >= 32} onClick={() => setSegments(current => [...current, { key: crypto.randomUUID(), checkIn: "", checkOut: "" }])}>新增住宿段</Button>
            <p className="flex items-center justify-between gap-2 rounded-lg bg-muted p-3 text-sm"><span>新訂單總額</span><output aria-label="新訂單總額">{totalCents === null ? "待填房費" : retainedMoney(totalCents)}</output></p>
          </fieldset>}
          {canWrite && pricesVisible && !result && !pending && <div className="space-y-1"><Label htmlFor="retained-reason">{action === "retain" ? "保留原因" : "安排入住原因"}</Label>
            <Textarea id="retained-reason" value={reason} disabled={!editable} maxLength={500} onChange={event => setReason(event.target.value)} /></div>}
        </>}
        {validPreview && !result && !pending && <section role="status" className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100">
          <p className="font-semibold">{action === "retain" ? "請確認：整張訂單轉保留，原住宿房晚將釋放。" : "新房晚已檢查，請確認新住宿安排與差額。"}</p>
          {action === "reschedule" && <RetainedStayList stays={preview.proposedStays} label="本次安排" />}
          {action === "reschedule" && pricesVisible && <p>{moneyUnknown ? "保留款項待核對，本次安排不會將訂單標為付清。" : preview.creditCents !== null && preview.creditCents > 0
            ? `已收超過新房費 ${retainedMoney(preview.creditCents)}，差額待處理；本次不會退款。` : `尚待收款：${retainedMoney(preview.remainingCents)}`}</p>}
          {preview.externalRoomActionRequired && <p>外部平台房況需要另行處理。{action === "retain" ? "原日期的 OS 占房會釋放，外部平台尚未確認開放。" : "新日期的 OS 占房會建立，外部平台尚未確認關房。"}</p>}
        </section>}
        {pending && <div role="status" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <p>{recoveryAttempt < 3 ? "正在確認這次操作是否完成，請勿重複提交…" : "暫時無法確認結果。你可以先關閉，稍後再確認；系統已保存這次操作，避免重複執行。"}</p>
          {recoveryAttempt >= 3 && <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setRecoveryAttempt(0)}>再次確認結果</Button>
            {canWrite && pricesVisible && <Button disabled={busy} onClick={() => void resendPending()}>{busy ? "確認中…" : "重送原操作並確認"}</Button>}
            {canWrite && pricesVisible && <Button variant="outline" disabled={busy} onClick={() => void abandonPending()}>放棄未完成操作，重新預覽</Button>}
          </div>}
        </div>}
        {result && <div role="status" className="space-y-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">
          <p>{result.currentStatus === "retained" ? "已轉為保留訂單，原 OS 房晚已釋放。可從「待改期」清單重新安排入住。" : result.currentStatus === "confirmed" ? "訂單目前已確認安排入住，可回日曆查看新住宿。" : "這次操作已確認完成；訂單之後已有其他變更，請重新載入最新狀態。"}</p>
          <p>原訂單與款項紀錄已保留。</p><p>{retainedChannelText(result.externalRoomStatus ?? result.channelSyncState)}</p>
        </div>}
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
        {notice && <p role="status" className="text-sm text-emerald-800 dark:text-emerald-300">{notice}</p>}
        {error && !pending && !busy && <Button variant="outline" onClick={() => setLoadRevision(value => value + 1)}>重新載入訂單</Button>}
      </div>
      <DialogFooter className="shrink-0 border-t bg-background px-5 py-4">
        <Button variant="outline" onClick={onClose} disabled={busy}>關閉</Button>
        {!loading && detail && !pending && !result && canWrite && pricesVisible && eligible && <Button onClick={() => void submit()} disabled={busy}>
          {busy ? "處理中…" : validPreview ? action === "retain" ? "確認轉為保留訂單" : "確認安排入住" : action === "retain" ? "預覽保留訂單" : "檢查房況與差額"}
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
