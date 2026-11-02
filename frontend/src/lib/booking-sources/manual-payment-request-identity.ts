const STORAGE_KEY = 'sweetfun-manual-payment-request-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type ManualPaymentPayload = { expectedBookingVersion: number; kind: 'received' | 'refunded';
  amountCents: number; method: 'cash' | 'bank_transfer' | 'credit_card' | 'other';
  evidenceRef: string; occurredAt: string; refundOfEventId?: string };
export type PendingManualPayment = { requestKey: string; bookingId: string; createdAt: number;
  payload?: ManualPaymentPayload };

export function readPendingManualPayment(store: Store): PendingManualPayment | null {
  const raw = store.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingManualPayment;
    if (!UUID.test(value.requestKey) || !UUID.test(value.bookingId) ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 1) throw Error();
    // Older pending requests retain lookup support. New requests can safely retry
    // the original payload after a lost response, including after a page reload.
    if (value.payload !== undefined) {
      const p = value.payload;
      if (!p || typeof p !== 'object' || Array.isArray(p) ||
        Object.keys(p).some(key => !['expectedBookingVersion', 'kind', 'amountCents',
          'method', 'evidenceRef', 'occurredAt', 'refundOfEventId'].includes(key)) ||
        !Number.isSafeInteger(p.expectedBookingVersion) || p.expectedBookingVersion < 1 ||
        !Number.isSafeInteger(p.amountCents) || p.amountCents <= 0 ||
        !['received', 'refunded'].includes(p.kind) ||
        !['cash', 'bank_transfer', 'credit_card', 'other'].includes(p.method) ||
        typeof p.evidenceRef !== 'string' || !p.evidenceRef.trim() || p.evidenceRef.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(p.evidenceRef) || typeof p.occurredAt !== 'string' ||
        !Number.isFinite(Date.parse(p.occurredAt)) ||
        (p.kind === 'refunded' ? !UUID.test(p.refundOfEventId ?? '') : p.refundOfEventId !== undefined)) throw Error();
    }
    return value;
  } catch { throw Error('MANUAL_PENDING_REQUEST_INVALID'); }
}

export function savePendingManualPayment(store: Store, pending: PendingManualPayment): void {
  if (readPendingManualPayment(store)) throw Error('MANUAL_PENDING_REQUEST');
  store.setItem(STORAGE_KEY, JSON.stringify(pending));
  if (readPendingManualPayment(store)?.requestKey !== pending.requestKey)
    throw Error('MANUAL_STORAGE_UNAVAILABLE');
}

export function clearPendingManualPayment(store: Store, requestKey: string): void {
  if (readPendingManualPayment(store)?.requestKey === requestKey)
    store.removeItem(STORAGE_KEY);
}
