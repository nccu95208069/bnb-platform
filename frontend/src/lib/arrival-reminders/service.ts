import type { CustomerStore } from '../customer-workspaces/store.ts';
import { hash, notificationCandidates, reminderText, type ArrivalList } from './domain.ts';

export const processedKey = (scope: string, id: string) => `arrival:handled:${hash([scope, id])}`;
type Handled = { fingerprint: string; at: string; actor: string };
type Receipt = { id: string; attempt: string; worker: string; fingerprint: string; state: 'sending' | 'sent' | 'failed' | 'unknown' | 'superseded'; expiresAt: string; completedAt?: string; providerReceipt?: string };
const lease = 5 * 60000;
const receiptKey = (target: string, day: string, id: string) => `arrival:delivery:${hash([target, day, id])}`;
const attemptKey = (worker: string, target: string, attempt: string) => `arrival:attempt:${hash([worker, target, attempt])}`;

export async function arrivalView(store: CustomerStore, list: ArrivalList) {
  return { ...list, arrivals: await Promise.all(list.arrivals.map(async item => {
    const handled = (await store.read<Handled>(processedKey(list.scope, item.id))).value;
    return { ...item, handledAt: handled?.fingerprint === item.fingerprint ? handled.at : null };
  })) };
}
export async function markHandled(store: CustomerStore, list: ArrivalList, actor: string, id: string, fingerprint: string, now = new Date()) {
  const item = list.arrivals.find(a => a.id === id);
  if (!item || item.fingerprint !== fingerprint) throw Error('VERSION_CONFLICT');
  const key = processedKey(list.scope, id), saved = await store.read<Handled>(key);
  if (saved.value?.fingerprint !== fingerprint) await store.commit([{ key, before: saved.raw, after: { fingerprint, actor, at: now.toISOString() }, ttlSeconds: 30 * 86400 }]);
  const confirmed = (await store.read<Handled>(key)).value;
  if (confirmed?.fingerprint !== fingerprint) throw Error('WRITE_UNCONFIRMED');
  return { handledAt: confirmed.at };
}

// Every target is server-configured and reauthorized by the adapter before this
// function. Records contain hashes and receipts only; original notes stay at source.
export async function claimReminder(store: CustomerStore, worker: string, target: string, recipient: string, attempt: string, list: ArrivalList, now = new Date(), includeUnconfirmed = false, recipientScope?: string) {
  if (!/^[a-f0-9-]{36}$/i.test(attempt) || !/^U[a-f0-9]{32}$/i.test(recipient)) throw Error('INVALID_INPUT');
  const pointerKey = attemptKey(worker, target, attempt), pointer = await store.read<string>(pointerKey);
  const view = await arrivalView(store, { ...list, arrivals: notificationCandidates(list, includeUnconfirmed) });
  const candidates = pointer.value ? [pointer.value] : view.arrivals.filter(a => !a.handledAt).map(a => a.id);
  for (const bookingId of candidates) {
    const key = receiptKey(target, list.day, bookingId), saved = await store.read<Receipt>(key), prior = saved.value;
    const item = view.arrivals.find(a => a.id === bookingId && !a.handledAt);
    const fingerprint = item ? hash([list.scope, item.fingerprint, recipient]) : '';
    if (prior) {
      if (prior.worker !== worker || prior.attempt !== attempt) continue;
      if (prior.state !== 'sending') return { jobs: [], results: [{ jobId: prior.id, state: prior.state }] };
      const state = Date.parse(prior.expiresAt) <= now.getTime() ? 'unknown' : !item || prior.fingerprint !== fingerprint ? 'superseded' : null;
      if (state) {
        await store.commit([{ key, before: saved.raw, after: { ...prior, state, completedAt: now.toISOString() }, ttlSeconds: 7 * 86400 }]);
        return { jobs: [], results: [{ jobId: prior.id, state }] };
      }
    } else {
      if (!item || pointer.value) return { jobs: [], results: [] };
      // Tenant recipients each get a separate delivery; legacy bindings retain
      // the original one-order/day guard. An uncertain delivery stays reserved.
      const deliveryGuard = `arrival:once:${hash([list.scope, list.day, bookingId, ...(recipientScope ? [recipientScope] : [])])}`;
      const receipt: Receipt = { id: hash([target, list.day, bookingId]), worker, attempt, fingerprint,
        state: 'sending', expiresAt: new Date(now.getTime() + lease).toISOString() };
      try { await store.commit([
        { key, before: null, after: receipt, ttlSeconds: 7 * 86400 },
        { key: pointerKey, before: null, after: bookingId, ttlSeconds: 7 * 86400 },
        { key: deliveryGuard, before: null, after: receipt.id, ttlSeconds: 7 * 86400 },
      ]); } catch (error) { if (error instanceof Error && error.message === 'VERSION_CONFLICT') continue; throw error; }
    }
    const confirmed = (await store.read<Receipt>(key)).value;
    if (!confirmed || !item || confirmed.state !== 'sending' || confirmed.worker !== worker || confirmed.attempt !== attempt || confirmed.fingerprint !== fingerprint) throw Error('WRITE_UNCONFIRMED');
    return { jobs: [{ id: confirmed.id, attemptId: attempt, bookingId, channel: 'ownerLine', recipient, text: reminderText(list, item), state: 'sending', claimExpiresAt: confirmed.expiresAt }], results: [] };
  }
  return { jobs: [], results: [] };
}
export async function acknowledgeReminder(store: CustomerStore, worker: string, target: string, day: string, attempt: string, jobId: string, outcome: 'sent' | 'failed' | 'unknown', providerReceipt?: string, now = new Date()) {
  if (!['sent', 'failed', 'unknown'].includes(outcome) || !/^[a-f0-9]{64}$/.test(jobId) || (outcome === 'sent' && (!providerReceipt || !/^[A-Za-z0-9][A-Za-z0-9_.:@/+=-]{0,199}$/.test(providerReceipt)))) throw Error('INVALID_INPUT');
  const bookingId = (await store.read<string>(attemptKey(worker, target, attempt))).value;
  if (!bookingId) throw Error('NOT_FOUND');
  const key = receiptKey(target, day, bookingId), saved = await store.read<Receipt>(key), prior = saved.value;
  if (!prior || prior.id !== jobId || prior.worker !== worker || prior.attempt !== attempt) throw Error('NOT_FOUND');
  if (prior.state !== 'sending') {
    if (prior.state !== outcome || prior.providerReceipt !== providerReceipt) throw Error('VERSION_CONFLICT');
  } else {
    await store.commit([{ key, before: saved.raw, after: { ...prior, state: outcome, providerReceipt, completedAt: now.toISOString() }, ttlSeconds: 7 * 86400 }]);
  }
  const result = (await store.read<Receipt>(key)).value;
  if (result?.state !== outcome || result.providerReceipt !== providerReceipt) throw Error('WRITE_UNCONFIRMED');
  return { jobId, state: outcome };
}


// Receipt recovery is independent of today's source and dispatch window. No PII.
export async function reminderStatus(store: CustomerStore, worker: string, target: string, day: string, attempt: string, jobId: string) {
  const bookingId = (await store.read<string>(attemptKey(worker, target, attempt))).value;
  if (!bookingId) throw Error('NOT_FOUND');
  const receipt = (await store.read<Receipt>(receiptKey(target, day, bookingId))).value;
  if (!receipt || receipt.id !== jobId || receipt.worker !== worker || receipt.attempt !== attempt) throw Error('NOT_FOUND');
  return { jobId, state: receipt.state, ...(receipt.providerReceipt ? { providerReceipt: receipt.providerReceipt } : {}) };
}
