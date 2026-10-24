const STORAGE_KEY = 'sweetfun-manual-payment-request-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type PendingManualPayment = { requestKey: string; bookingId: string; createdAt: number };

export function readPendingManualPayment(store: Store): PendingManualPayment | null {
  const raw = store.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingManualPayment;
    if (!UUID.test(value.requestKey) || !UUID.test(value.bookingId) ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 1) throw Error();
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
