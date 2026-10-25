"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StayDateFields } from "./stay-date-fields";
import { dateAfter, stayNights, todayInTaipei, twdCents } from "@/lib/booking-sources/manual-booking-form";
import { clearPendingManualRequest, readPendingManualRequest,
  savePendingManualRequest } from "@/lib/booking-sources/manual-request-identity";

type Mode = "create" | "amend" | "cancel" | "sync";
type Detail = { bookingId: string; version: number; status: string; source: string;
  channelSyncState: string; sourceReviewRequired: boolean; guestName: string | null;
  contact: string | null; notes: string | null; totalCents: number | null;
  netReceivedCents: number | null; bookedAt: string | null;
  stays: { checkIn: string; checkOut: string; roomNumbers: string[] }[] };
type Preview = { inventoryVersion: number; roomNights: number;
  localRoomNightsAvailable: boolean; externalStockVerified: boolean };
const ROOMS = ["101", "102", "201", "202", "301", "302"];
const LABELS: Record<string, string> = {
  ROOM_CONFLICT: "這些日期的房間已有訂單或封房，請重新選擇。",
  MANUAL_VERSION_CONFLICT: "訂單或房況已變更，請重新載入再確認。",
  VERSION_CONFLICT: "訂單或房況已變更，請重新載入再確認。",
  CANCELLATION_REQUIRES_SETTLEMENT: "這張訂單有未結清的收款，請先處理退款或結算。",
  CHANNEL_AMENDMENT_NOT_READY: "房況同步尚未完成，暫時不能修改房間或日期。",
  CHANNEL_STOCK_NOT_OBSERVED: "這些日期不在已核對的 OwlNest 房況範圍內，暫時不能修改或取消已同步訂單。",
  CHANNEL_CANCELLATION_NOT_READY: "OwlNest 房況同步尚未完成，暫時不能取消訂單。",
  CHANNEL_SYNC_NOT_READY: "目前無法開始同步房況，請重新載入並確認 OwlNest 設定。",
  MANUAL_GUEST_NAME_REQUIRED: "請填寫旅客姓名。",
  MANUAL_PRICE_REQUIRED: "請填寫房費。",
  MANUAL_REASON_REQUIRED: "請填寫修改或取消原因。",
  MANUAL_DATE_RANGE_TOO_WIDE: "日期範圍過長，請分段處理。",
  MANUAL_PENDING_REQUEST: "系統正在確認上一筆訂單的儲存結果，請稍候。",
  MANUAL_PENDING_REQUEST_INVALID: "此瀏覽器保存的請求資料無法辨識，請先人工核對訂單。",
  MANUAL_STORAGE_UNAVAILABLE: "此瀏覽器無法安全保存請求鍵，暫時不能提交訂單。",
  SOURCE_AMEND_REQUIRES_REVIEW: "這張來源訂單目前不能修改此欄位，請重新載入確認。",
};

function dayAfter(value: string): string {
  return dateAfter(value);
}
function message(code: unknown): string {
  return typeof code === "string" ? LABELS[code] ?? "操作尚未完成，請重新載入並確認狀態。" :
    "操作尚未完成，請重新載入並確認狀態。";
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value) ?
    value as Record<string, unknown> : {};
}

export function ManualBookingDialog({ open, mode, bookingId, inventoryVersion,
  defaultDate, onClose, onDone }: { open: boolean; mode: Mode; bookingId?: string;
  inventoryVersion: number; defaultDate: string; onClose: () => void; onDone: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFor, setPreviewFor] = useState("");
  const [guestName, setGuestName] = useState("");
  const [contact, setContact] = useState("");
  const [notes, setNotes] = useState("");
  const [totalTwd, setTotalTwd] = useState("");
  const [bookedAt, setBookedAt] = useState("");
  const [checkIn, setCheckIn] = useState(defaultDate);
  const [checkOut, setCheckOut] = useState(dayAfter(defaultDate));
  const [roomNumbers, setRoomNumbers] = useState<string[]>([]);
  const [roomDates, setRoomDates] = useState<Record<string, { checkIn: string; checkOut: string }>>({});
  const [nightAmounts, setNightAmounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const sourceNameOnly = mode === "amend" && detail?.source === "external";
  const simpleStay = mode === "create" || detail?.stays.length === 1;
  const canMutate = mode === "create" || detail !== null &&
    detail.status === "confirmed" && !detail.sourceReviewRequired &&
    (mode === "sync" ? detail.source === "os" &&
      detail.channelSyncState === "awaiting_manual_sync" :
      (detail.source === "os" || sourceNameOnly) &&
      ["verified", "not_required", "awaiting_manual_sync"].includes(detail.channelSyncState));
  const stay = useMemo(() => mode === "create" ? [...roomNumbers].sort().map(number => ({
    ...(roomDates[number] ?? { checkIn, checkOut }), roomNumbers: [number],
  })) : [{ checkIn, checkOut, roomNumbers: [...roomNumbers].sort() }],
    [mode, checkIn, checkOut, roomNumbers, roomDates]);
  const priceRows = stay.flatMap(segment => segment.roomNumbers.flatMap(roomNumber =>
    stayNights(segment.checkIn, segment.checkOut).map(date => ({ roomNumber, date,
      amountCents: twdCents(nightAmounts[`${roomNumber}:${date}`] ?? "") }))));
  const priceComplete = priceRows.length > 0 && priceRows.every(row => row.amountCents !== null);
  const roomTotalCents = priceRows.reduce((sum, row) => sum + (row.amountCents ?? 0), 0);
  const fingerprint = JSON.stringify([stay, inventoryVersion, detail?.version]);

  useEffect(() => {
    if (!open) return;
    setDetail(null); setError(""); setResult(""); setRequestKey(null);
    setUnknown(false); setRecoveryAttempt(0);
    setPreview(null); setPreviewFor(""); setReason("");
    setGuestName(""); setContact(""); setNotes(""); setTotalTwd("");
    setBookedAt(mode === "create" ? todayInTaipei() : ""); setCheckIn(defaultDate); setCheckOut(dayAfter(defaultDate));
    setRoomNumbers([]); setRoomDates({}); setNightAmounts({});
    try {
      const pending = readPendingManualRequest(window.localStorage);
      if (pending) {
        setRequestKey(pending.requestKey);
        setUnknown(true);
        setResult("正在確認上一筆訂單的儲存結果…");
      }
    } catch { setError(message('MANUAL_PENDING_REQUEST_INVALID')); }
    if (mode === "create" || !bookingId) return;
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/v1/bookings/manual/${bookingId}`, { cache: "no-store",
      signal: controller.signal }).then(async response => {
      const value = await responseJson(response);
      if (!response.ok || !Array.isArray(value.stays)) throw Error(String(value.code ?? ""));
      return value as Detail;
    }).then(value => {
      setDetail(value); setGuestName(value.guestName ?? "");
      setContact(value.contact ?? ""); setNotes(value.notes ?? "");
      setTotalTwd(value.totalCents === null ? "" : String(value.totalCents / 100));
      setBookedAt(value.bookedAt ?? "");
      if (value.stays.length === 1) {
        setCheckIn(value.stays[0].checkIn); setCheckOut(value.stays[0].checkOut);
        setRoomNumbers(value.stays[0].roomNumbers);
      }
    }).catch(err => { if (!controller.signal.aborted) setError(message(err.message)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, mode, bookingId, defaultDate]);

  // Recovery only reads the original request. Never resend a booking after an
  // uncertain response, and keep its durable identity across closing/reloading.
  useEffect(() => {
    if (!open || !unknown || !requestKey || busy || recoveryAttempt >= 3) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`/api/v1/bookings/manual/requests/${requestKey}`,
          { cache: "no-store", signal: controller.signal });
        const value = await responseJson(response);
        if (!response.ok || typeof value.bookingId !== "string" ||
          value.requestKey !== requestKey || value.readbackVerified !== true) throw Error();
        if (!active) return;
        clearPendingManualRequest(window.localStorage, requestKey);
        setRequestKey(null); setUnknown(false); setError("");
        const channel = value.currentChannelSyncState;
        setResult(value.currentStatus === "cancelled" ? "訂單已取消，結果已確認。" :
          channel === "awaiting_manual_sync" ? "訂單已儲存並確認。請至訂單詳情按「同步房況」，更新 OwlNest。" :
          channel === "pending" ? "訂單已儲存，OwlNest 房況同步中。" :
          channel === "review_required" ? "訂單已儲存；房況同步仍需要核對，請查看訂單詳情。" :
          "訂單已儲存，結果已確認。");
        onDone();
      } catch {
        if (!active) return;
        setRecoveryAttempt(attempt => attempt + 1);
        if (recoveryAttempt >= 2) setResult("暫時無法確認儲存結果。你可以先關閉，稍後再確認；系統會保留這次提交，避免重複建立訂單。");
      } finally { clearTimeout(timeout); }
    }, [0, 1000, 2500][recoveryAttempt]);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [open, unknown, requestKey, busy, recoveryAttempt, onDone]);

  const toggleRoom = (number: string) => {
    setRoomNumbers(current => current.includes(number) ?
      current.filter(item => item !== number) : [...current, number]);
    setPreview(null);
  };
  const changeDates = (nextIn: string, nextOut: string) => {
    setCheckIn(nextIn); setCheckOut(nextOut); setPreview(null);
    // Main dates apply to every selected room. Individual cards can override them.
    setRoomDates({});
  };
  const beginConfirmation = () => {
    setUnknown(true); setRecoveryAttempt(0);
    setResult("正在確認訂單是否已儲存，請稍候…");
  };

  async function submit() {
    setError(""); setResult("");
    let submittedKey: string | null = null;
    if (unknown || busy) return;
    if (!canMutate) { setError("這張訂單目前不能執行此操作。"); return; }
    if (mode !== "cancel" && mode !== "sync" && !guestName.trim()) {
      setError("請填寫旅客姓名。"); return;
    }
    if (sourceNameOnly && guestName.trim() === detail?.guestName) {
      setError("旅客姓名尚未變更。"); return;
    }
    if (mode !== "cancel" && mode !== "sync" && !sourceNameOnly &&
      (!roomNumbers.length || stay.some(segment => !stayNights(segment.checkIn, segment.checkOut).length))) {
      setError("請填妥房間及正確的入住與退房日期。"); return;
    }
    if (mode !== "create" && mode !== "sync" && !reason.trim()) {
      setError("請填寫原因。"); return;
    }
    if (mode === "create" && (!priceComplete || !Number.isSafeInteger(roomTotalCents))) {
      setError("請填妥每個日期、每間房的房費。"); return;
    }
    if (mode === "create" && priceRows.length > 120) {
      setError("每筆訂單最多可填 120 個房晚，請縮短住宿日期。"); return;
    }
    if (mode !== "create" && mode !== "sync" && !sourceNameOnly && totalTwd && (!/^\d+$/.test(totalTwd) ||
      !Number.isSafeInteger(Number(totalTwd) * 100))) {
      setError("房價請填寫有效的台幣金額。"); return;
    }
    setBusy(true);
    try {
      if (mode !== "cancel" && mode !== "sync" && !sourceNameOnly &&
        (previewFor !== fingerprint || !preview)) {
        const path = mode === "create" ? "/api/v1/bookings/manual/preview" :
          `/api/v1/bookings/manual/${bookingId}/preview`;
        const body = mode === "create" ? { expectedInventoryVersion: inventoryVersion,
          stays: stay } : { expectedInventoryVersion: inventoryVersion,
          expectedBookingVersion: detail?.version, stays: stay };
        const response = await fetch(path, { method: "POST", cache: "no-store",
          headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const value = await responseJson(response);
        if (!response.ok) throw Error(String(value.code ?? ""));
        setPreview(value as Preview); setPreviewFor(fingerprint);
        return;
      }
      const key = crypto.randomUUID();
      const payload = mode === "sync" ? { expectedInventoryVersion: inventoryVersion,
        expectedBookingVersion: detail?.version } : mode === "create" ? { expectedInventoryVersion: inventoryVersion,
        stays: stay, guestName: guestName.trim(), contact: contact.trim() || null,
        notes: notes.trim() || null, totalCents: roomTotalCents,
        roomNightPrices: priceRows, bookedAt: bookedAt || null } : mode === "amend" && sourceNameOnly ? {
          expectedBookingVersion: detail?.version, expectedInventoryVersion: inventoryVersion,
          reason: reason.trim(), changes: { guestName: guestName.trim() },
        } : mode === "amend" ? {
          expectedBookingVersion: detail?.version, expectedInventoryVersion: inventoryVersion,
          reason: reason.trim(), changes: { stays: stay, guestName: guestName.trim(),
            contact: contact.trim() || null, notes: notes.trim() || null,
            totalCents: totalTwd ? Math.round(Number(totalTwd) * 100) : null },
        } : { expectedBookingVersion: detail?.version,
          expectedInventoryVersion: inventoryVersion, reason: reason.trim() };
      const path = mode === "create" ? "/api/v1/bookings/manual" : mode === "sync" ?
        `/api/v1/bookings/manual/${bookingId}/sync-room-status` : mode === "amend" ?
        `/api/v1/bookings/manual/${bookingId}` :
        `/api/v1/bookings/manual/${bookingId}/cancel`;
      try {
        savePendingManualRequest(window.localStorage, {
          requestKey: key, mode, bookingId: bookingId ?? null, createdAt: Date.now(),
        });
      } catch (storageError) {
        throw Error(storageError instanceof Error && storageError.message.startsWith('MANUAL_') ?
          storageError.message : 'MANUAL_STORAGE_UNAVAILABLE');
      }
      submittedKey = key;
      setRequestKey(key);
      const response = await fetch(path, { method: mode === "amend" ? "PATCH" : "POST",
        cache: "no-store", headers: { "content-type": "application/json",
          "idempotency-key": key }, body: JSON.stringify(payload) });
      const value = await responseJson(response);
      if (value.outcome === "unknown" || response.status >= 500 ||
        !response.ok && (typeof value.code !== "string" ||
          !/^[A-Z][A-Z0-9_]{1,80}$/.test(value.code)) ||
        response.ok && (typeof value.bookingId !== "string" || value.requestKey !== key)) {
        beginConfirmation();
        return;
      }
      if (!response.ok) {
        clearPendingManualRequest(window.localStorage, key);
        setRequestKey(null);
        setError(message(value.code));
        return;
      }
      clearPendingManualRequest(window.localStorage, key);
      setRequestKey(null);
      setResult(sourceNameOnly ? "旅客姓名已在 Sweetfun OS 更正並讀回確認；來源差異待核對。" :
        mode === "sync" ? value.channelSyncState === "verified" ?
          "OwlNest 房況已回讀驗證。" : value.channelSyncState === "review_required" ?
          "房況同步需要人工核對；請勿重複按同步，先確認 OwlNest 房況。" :
          "已開始同步房況；OwlNest 回讀驗證前仍顯示同步中。" :
        value.operationState === "awaiting_manual_sync" ?
        "訂單已儲存並確認。請至訂單詳情按「同步房況」，更新 OwlNest。" :
        value.operationState === "sync_pending" ?
        "訂單已記錄，OwlNest 房況同步中。" : "訂單已記錄並讀回確認。");
      onDone();
    } catch (err) {
      if (submittedKey) {
        beginConfirmation();
      } else {
        setRequestKey(null);
        setError(message(err instanceof Error ? err.message : ""));
      }
    }
    finally { setBusy(false); }
  }

  const confirming = unknown && recoveryAttempt < 3;
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy && !confirming) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto overflow-x-hidden p-4 sm:max-w-lg sm:p-6">
      <DialogHeader>
        <DialogTitle>{mode === "create" ? "新增水芳訂單" : mode === "amend" ?
          "修改水芳訂單" : mode === "sync" ? "同步 OwlNest 房況" : "取消水芳訂單"}</DialogTitle>
        <DialogDescription>{mode === "sync" ?
          "確認後才開始關閉這筆訂單的 OwlNest 房晚；回讀完成前不會顯示同步成功。" :
          mode === "create" ?
          "選擇住宿日期與房間，填寫各晚房費。儲存後可至訂單詳情同步 OwlNest 房況。" :
          sourceNameOnly ?
          "只更正 Sweetfun OS 的旅客姓名；不變動 OwlNest 訂單或房況，來源差異會標示待核。" :
          "訂單會記錄在 Iron Gate；OwlNest 房況需同步並回讀後才算驗證完成。"}</DialogDescription>
      </DialogHeader>
      {loading ? <p role="status">讀取訂單中…</p> : <div className="space-y-4">
        {mode !== "create" && !canMutate &&
          <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            此訂單的來源或房況仍需核對，暫時不能手動操作。</p>}
        {mode === "amend" && !sourceNameOnly && !simpleStay &&
          <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            這張訂單有多段住宿，請先在詳情確認全單；目前介面只支援單段住宿修改。</p>}
        {mode === "sync" && detail && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          Iron Gate 訂單已建立；目前 OwlNest 房況尚未同步。按下方按鈕才會開始關房。
        </p>}
        {mode !== "cancel" && mode !== "sync" && <fieldset disabled={busy || unknown || !!result} className="min-w-0 space-y-4">
          {mode === "create" && <div className="space-y-1"><p className="text-sm font-medium">館別</p>
            <div className="rounded-md border px-3 py-2 text-sm">水芳民宿</div></div>}
          <div className="space-y-1"><Label htmlFor="manual-guest">旅客姓名</Label>
            <Input id="manual-guest" value={guestName} onChange={e => setGuestName(e.target.value)} /></div>
          {!sourceNameOnly && <>
          <div className="space-y-1"><Label htmlFor="manual-contact">聯絡方式</Label>
            <Input id="manual-contact" value={contact} onChange={e => setContact(e.target.value)} /></div>
          <div><Label>房間</Label><div className="mt-2 grid grid-cols-3 gap-2">
            {ROOMS.map(number => <label key={number} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
              <input type="checkbox" checked={roomNumbers.includes(number)}
                onChange={() => toggleRoom(number)} />{number} 房</label>)}</div></div>
          <StayDateFields checkIn={checkIn} checkOut={checkOut} onChange={changeDates}
            disabled={busy || unknown || !!result} />
          {mode === "create" && <div className="space-y-3">
            {roomNumbers.length > 1 && <p className="text-xs text-muted-foreground">可在各房間分別調整入住、退房日；上方日期會套用全部房間。</p>}
            {stay.map(segment => {
              const number = segment.roomNumbers[0];
              return <section key={number} className="min-w-0 space-y-3 rounded-xl border p-3" aria-label={`${number} 房房費`}>
                <h3 className="text-sm font-medium">{number} 房</h3>
                {roomNumbers.length > 1 && <StayDateFields label={`${number} 房`} checkIn={segment.checkIn}
                  checkOut={segment.checkOut} disabled={busy || unknown || !!result} onChange={(nextIn, nextOut) => {
                    setRoomDates(current => ({ ...current, [number]: { checkIn: nextIn, checkOut: nextOut } }));
                    setPreview(null);
                  }} />}
                {stayNights(segment.checkIn, segment.checkOut).map(date => <div key={date} className="grid min-w-0 grid-cols-[minmax(0,1fr)_7rem] items-center gap-2">
                  <Label htmlFor={`manual-price-${number}-${date}`} className="text-sm leading-5">
                    {date.replaceAll("-", "/")} · {number} 房
                  </Label>
                  <div className="relative min-w-0"><span className="pointer-events-none absolute left-2 top-2.5 text-sm text-muted-foreground">$</span>
                    <Input id={`manual-price-${number}-${date}`} inputMode="numeric" className="min-w-0 pl-5 text-base"
                      placeholder="房費" value={nightAmounts[`${number}:${date}`] ?? ""}
                      onChange={event => setNightAmounts(current => ({ ...current, [`${number}:${date}`]: event.target.value }))} />
                  </div>
                </div>)}
              </section>;
            })}
            <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-3 text-sm">
              <span>訂單總額（台幣）</span><output aria-label="訂單總額" className="font-semibold">
                {priceComplete ? `NT$ ${new Intl.NumberFormat("zh-TW").format(roomTotalCents / 100)}` : "待填房費"}
              </output>
            </div>
          </div>}
          <div className={`grid min-w-0 gap-3 ${mode === "create" ? "grid-cols-1" : "grid-cols-2"}`}>
            {mode !== "create" &&
            <div className="space-y-1"><Label htmlFor="manual-total">訂單總額（台幣）</Label>
              <Input id="manual-total" inputMode="decimal" value={totalTwd}
                onChange={e => setTotalTwd(e.target.value)}
                placeholder="未知可留白" /></div>}
            <div className="min-w-0 space-y-1"><Label htmlFor="manual-booked">預訂日</Label>
              <Input id="manual-booked" type="date" className="min-w-0 max-w-full text-base" value={bookedAt}
                onChange={e => setBookedAt(e.target.value)} disabled={mode === "amend"} /></div>
          </div>
          <div className="space-y-1"><Label htmlFor="manual-notes">備註</Label>
            <Textarea id="manual-notes" value={notes} onChange={e => setNotes(e.target.value)} /></div>
          </>}
        </fieldset>}
        {mode !== "create" && mode !== "sync" && <div className="space-y-1"><Label htmlFor="manual-reason">
          {mode === "cancel" ? "取消原因" : "修改原因"}</Label>
          <Textarea id="manual-reason" value={reason} onChange={e => setReason(e.target.value)} /></div>}
        {mode === "cancel" && detail?.netReceivedCents !== null &&
          Number(detail?.netReceivedCents) > 0 &&
          <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            這張訂單仍有收款，請先完成退款或結算；取消不會自動退款。</p>}
        {preview && previewFor === fingerprint && mode !== "cancel" && mode !== "sync" && !sourceNameOnly &&
          <p role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
            已確認 {preview.roomNights} 個房晚可預訂。
            {mode === "create" || detail?.channelSyncState === "awaiting_manual_sync" ?
              "提交後會先儲存訂單；OwlNest 房況要另外按「同步房況」。" :
              "提交修改後會開始同步 OwlNest 房況，待回讀驗證。"}
          </p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {result && <p role="status" className="text-sm text-amber-800">{result}</p>}
        {unknown && !confirming && <Button variant="outline" onClick={() => {
          setError(""); setRecoveryAttempt(0); setResult("正在確認訂單是否已儲存，請稍候…");
        }}>再次確認儲存結果</Button>}
      </div>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy || confirming}>關閉</Button>
        {!loading && canMutate && !(mode === "amend" && !sourceNameOnly && !simpleStay) &&
          !(mode === "cancel" && Number(detail?.netReceivedCents) > 0) &&
          !result &&
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "處理中…" : mode === "cancel" ? "確認取消" :
              mode === "sync" ? "同步房況" :
              sourceNameOnly ? "確認修改姓名" :
              preview && previewFor === fingerprint ? "確認提交" : "檢查房晚"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
