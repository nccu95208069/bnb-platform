"use client";

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clearPendingManualPayment, readPendingManualPayment,
  savePendingManualPayment, type PendingManualPayment } from
  '@/lib/booking-sources/manual-payment-request-identity';

type Event = { id: string; kind: 'received' | 'refunded'; amountCents: number;
  evidenceRef: string; occurredAt: string; recordedAt: string };
type Detail = { bookingId: string; version: number; status: string;
  totalCents: number | null; receivedCents: number; refundedCents: number;
  netReceivedCents: number; events: Event[] };
const labels: Record<string, string> = {
  VERSION_CONFLICT: '訂單或收款紀錄已變更，請重新載入再確認。',
  REFUND_EXCEEDS_RECEIVED: '退款金額超過這張訂單已登記的淨收款。',
  PAYMENT_EVENT_LIMIT: '這張訂單的收付款紀錄已達上限，請聯絡管理員。',
  PAYMENT_EVIDENCE_EXISTS: '這張訂單已登記相同的收付憑證編號，請先核對原紀錄。',
  MANUAL_PENDING_REQUEST: '有一筆收付款結果尚未確認，請先查詢原請求。',
  MANUAL_PENDING_REQUEST_INVALID: '瀏覽器保存的請求資料無法辨識，請先人工核對。',
  MANUAL_STORAGE_UNAVAILABLE: '瀏覽器無法安全保存請求鍵，暫時不能登記。',
};
const money = (cents: number) => new Intl.NumberFormat('zh-TW', {
  style: 'currency', currency: 'TWD', maximumFractionDigits: 2,
}).format(cents / 100);
const nowTaipei = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 16);
async function json(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => null);
  return value && typeof value === 'object' && !Array.isArray(value) ?
    value as Record<string, unknown> : {};
}

export function IronGateManualPaymentPanel({ bookingId, canRecord, onChange }: {
  bookingId: string; canRecord: boolean; onChange: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<PendingManualPayment | null>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [kind, setKind] = useState<'received' | 'refunded'>('received');
  const [amount, setAmount] = useState('');
  const [evidence, setEvidence] = useState('');
  const [occurred, setOccurred] = useState(nowTaipei);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try { setPending(readPendingManualPayment(window.localStorage)); }
    catch { setStorageBlocked(true); setError(labels.MANUAL_PENDING_REQUEST_INVALID); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/bookings/manual/${bookingId}/payments`, { cache: 'no-store',
      signal: controller.signal }).then(async response => {
      const value = await json(response);
      if (!response.ok || !Array.isArray(value.events))
        throw Error(typeof value.code === 'string' ? value.code : 'MANUAL_READ_UNAVAILABLE');
      return value as Detail;
    }).then(value => { setDetail(value); if (!storageBlocked) setError(''); })
      .catch(failure => { if (!controller.signal.aborted) {
        setDetail(null);
        setError(labels[failure.message] ?? '收付款紀錄暫時無法完整讀取，請重新載入。');
      } });
    return () => controller.abort();
  }, [bookingId, reload, storageBlocked]);

  async function submit() {
    if (!detail || !canRecord || pending || storageBlocked) return;
    const validAmount = /^\d+(?:\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : NaN;
    const occurredAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(occurred) ?
      new Date(`${occurred}:00+08:00`) : new Date(NaN);
    if (!Number.isSafeInteger(validAmount) || validAmount <= 0 ||
      !evidence.trim() || evidence.length > 256 || /[\u0000-\u001f\u007f]/.test(evidence) ||
      !Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now()) {
      setError('請填寫有效金額、收付時間與憑證編號或說明。'); return;
    }
    if (kind === 'refunded' && validAmount > detail.netReceivedCents) {
      setError(labels.REFUND_EXCEEDS_RECEIVED); return;
    }
    setBusy(true); setError(''); setResult('');
    let saved = false;
    try {
      const requestKey = crypto.randomUUID();
      const current = { requestKey, bookingId, createdAt: Date.now() };
      savePendingManualPayment(window.localStorage, current);
      saved = true; setPending(current);
      const response = await fetch(`/api/v1/bookings/manual/${bookingId}/payments`, {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'idempotency-key': requestKey },
        body: JSON.stringify({ expectedBookingVersion: detail.version, kind,
          amountCents: validAmount, evidenceRef: evidence.trim(),
          occurredAt: occurredAt.toISOString() }),
      });
      const value = await json(response);
      if (value.outcome === 'unknown' || response.status >= 500 ||
        response.ok && (value.paymentEventId !== requestKey || value.bookingId !== bookingId) ||
        !response.ok && typeof value.code !== 'string') {
        setResult('結果尚未確認。請用原請求鍵查詢，暫時不要再登記一次。');
        return;
      }
      if (!response.ok) {
        clearPendingManualPayment(window.localStorage, requestKey);
        setPending(null); setError(labels[String(value.code)] ?? '登記未完成，請重新載入確認。');
        return;
      }
      clearPendingManualPayment(window.localStorage, requestKey);
      setPending(null); setOpen(false); setAmount(''); setEvidence('');
      setResult('Iron Gate 已記錄並讀回確認；請依財務帳本核對實際入帳。');
      setReload(value => value + 1); onChange();
    } catch (failure) {
      if (saved) setResult('結果尚未確認。請用原請求鍵查詢，暫時不要再登記一次。');
      else setError(labels[(failure as Error).message] ?? labels.MANUAL_STORAGE_UNAVAILABLE);
    } finally { setBusy(false); }
  }

  async function recover() {
    if (!pending) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/v1/bookings/manual/payment-requests/${pending.requestKey}`,
        { cache: 'no-store' });
      const value = await json(response);
      if (!response.ok || value.paymentEventId !== pending.requestKey ||
        value.bookingId !== pending.bookingId) throw Error();
      clearPendingManualPayment(window.localStorage, pending.requestKey);
      setPending(null);
      setResult('原收付款已在 Iron Gate 留下紀錄，請核對帳本。');
      setReload(value => value + 1); onChange();
    } catch { setError('仍無法確認原請求。請保留請求鍵並人工核對，不要再登記一次。'); }
    finally { setBusy(false); }
  }

  return <section className="space-y-3 rounded-xl border p-3" aria-label="Iron Gate 收付款紀錄">
    <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">收付款紀錄</h3>
      {detail && canRecord && !pending && !storageBlocked && !open && <Button size="sm"
        onClick={() => { setError(''); setOpen(true); }}>登記收付</Button>}</div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {result && <p role="status" className="text-sm text-amber-800">{result}</p>}
    {pending && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
      <p>有一筆收付款結果尚未確認。請查詢原請求，避免重複登記。</p>
      <p className="mt-1 break-all text-xs">原請求鍵：{pending.requestKey}</p>
      {pending.bookingId !== bookingId && <p>這筆請求屬於另一張訂單，查詢後再繼續。</p>}
      <Button className="mt-2" variant="outline" disabled={busy}
        onClick={() => void recover()}>查詢原請求</Button></div>}
    {!detail && !error && <p className="text-sm">讀取收付款紀錄中…</p>}
    {!detail && error && <Button variant="outline"
      onClick={() => setReload(value => value + 1)}>重新載入</Button>}
    {detail && <>
      <p className="text-sm">訂單總額：{detail.totalCents === null ? '待核' : money(detail.totalCents)}
        {' · '}已登記收款：{money(detail.receivedCents)}{' · '}已登記退款：{money(detail.refundedCents)}
        {' · '}淨額：{money(detail.netReceivedCents)}</p>
      <p className="text-xs text-muted-foreground">這些是 Iron Gate 的收付憑證紀錄；實際銀行入帳與現行財務帳本仍須核對，請勿在兩處重複登記。</p>
      {open && !pending && <form className="space-y-3 border-t pt-3" onSubmit={event => {
        event.preventDefault(); void submit(); }}>
        <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
          <div className="grid grid-cols-2 gap-2"><label className="text-sm"><input type="radio"
            name="iron-gate-payment-kind" checked={kind === 'received'}
            onChange={() => setKind('received')} /> 登記收款</label><label className="text-sm"><input
              type="radio" name="iron-gate-payment-kind" checked={kind === 'refunded'}
              onChange={() => setKind('refunded')} /> 登記退款</label></div>
          <div className="space-y-1"><Label htmlFor="iron-gate-payment-amount">金額（台幣）</Label>
            <Input id="iron-gate-payment-amount" required type="number" min="0.01" step="0.01"
              value={amount} onChange={event => setAmount(event.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="iron-gate-payment-at">實際收付時間（台灣時間）</Label>
            <Input id="iron-gate-payment-at" required type="datetime-local" value={occurred}
              onChange={event => setOccurred(event.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="iron-gate-payment-evidence">唯一收付憑證編號</Label>
            <Input id="iron-gate-payment-evidence" required maxLength={256} value={evidence}
              onChange={event => setEvidence(event.target.value)} /></div>
        </fieldset>
        <div className="flex gap-2"><Button disabled={busy} type="submit">
          {busy ? '登記並核對中…' : kind === 'received' ? '確認登記收款' : '確認登記退款'}</Button>
          <Button disabled={busy} type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button></div>
      </form>}
      {!detail.events.length ? <p className="text-sm text-muted-foreground">尚無收付款紀錄。</p> :
        <ul className="divide-y">{[...detail.events].reverse().map(event => <li key={event.id}
          className="py-2 text-sm"><p className="font-medium">{event.kind === 'received' ? '收款' : '退款'}
            {' · '}{money(event.amountCents)}</p><p className="text-xs text-muted-foreground">
              {new Date(event.occurredAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
              {' · '}{event.evidenceRef}</p></li>)}</ul>}
    </>}
  </section>;
}
