const STORAGE_KEY = 'sweetfun-manual-request-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PendingManualRequest = {
  requestKey: string;
  mode: 'create' | 'amend' | 'cancel' | 'sync' | 'manual-confirm';
  bookingId: string | null;
  createdAt: number;
};

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readPendingManualRequest(store: Store): PendingManualRequest | null {
  const raw = store.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingManualRequest;
    if (!UUID.test(value.requestKey) || !['create', 'amend', 'cancel', 'sync', 'manual-confirm'].includes(value.mode) ||
      (value.bookingId !== null && !UUID.test(value.bookingId)) ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 1) throw Error();
    return value;
  } catch { throw Error('MANUAL_PENDING_REQUEST_INVALID'); }
}

export function savePendingManualRequest(store: Store, pending: PendingManualRequest): void {
  if (readPendingManualRequest(store)) throw Error('MANUAL_PENDING_REQUEST');
  store.setItem(STORAGE_KEY, JSON.stringify(pending));
  if (readPendingManualRequest(store)?.requestKey !== pending.requestKey)
    throw Error('MANUAL_STORAGE_UNAVAILABLE');
}

export function clearPendingManualRequest(store: Store, requestKey: string): void {
  if (readPendingManualRequest(store)?.requestKey === requestKey)
    store.removeItem(STORAGE_KEY);
}
