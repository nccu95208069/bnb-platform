import { createHash, timingSafeEqual } from 'node:crypto';
import type { CustomerStore } from '../customer-workspaces/store.ts';
import type { WebsiteBinding } from '../website-booking/types.ts';
import { loadWorkspace } from '../customer-workspaces/service.ts';
import { customerList, legacyList } from './source.ts';
import { taipeiDay } from './domain.ts';
import { acknowledgeReminder, claimReminder, reminderStatus } from './service.ts';
import { activeTenantRecipient, consumeRecipientPairing, targetIndex, targetSetting } from './recipient-settings.ts';

type LegacyTarget = { includeUnconfirmed?: boolean; id: string; kind: 'legacy'; propertyId: 'sweetfun' | 'offland'; recipientId: string; verifiedAt: string; verifiedBy: string };
type NativeTarget = { includeUnconfirmed?: boolean; id: string; kind: 'workspace'; bindingId: string };
type TenantTarget = { includeUnconfirmed: boolean; id: string; kind: 'tenant'; workspaceId: string; slug: string; propertyId: string };
type Target = LegacyTarget | NativeTarget | TenantTarget;
export type ReminderWorker = { id: string; token_sha256: string; targets: Target[] };

// Separate explicit capability: a price/change or guest-site token cannot read notes.
export function reminderWorker(authorization: string | null, configuration = process.env.ARRIVAL_REMINDER_WORKERS || '[]', now = new Date()): ReminderWorker {
  const token = authorization?.match(/^Bearer ([\x21-\x7e]{32,512})$/)?.[1];
  if (!token) throw Error('UNAUTHORIZED');
  let rows: ReminderWorker[];
  try {
    rows = JSON.parse(configuration);
    if (!Array.isArray(rows) || rows.length > 20) throw Error();
    const ids = new Set(), tokens = new Set(), targets = new Set();
    for (const worker of rows) {
      if (!/^[\w-]{1,80}$/.test(worker.id) || !/^[a-f0-9]{64}$/.test(worker.token_sha256) || ids.has(worker.id) || tokens.has(worker.token_sha256) || !Array.isArray(worker.targets) || !worker.targets.length || worker.targets.length > 50) throw Error();
      ids.add(worker.id); tokens.add(worker.token_sha256);
      for (const t of worker.targets) {
        if (typeof t.id !== 'string' || !/^[\w-]{1,80}$/.test(t.id) || targets.has(t.id)) throw Error(); targets.add(t.id);
        if (t.includeUnconfirmed !== undefined && typeof t.includeUnconfirmed !== 'boolean') throw Error();
        if (t.kind === 'legacy') {
          if (!['sweetfun', 'offland'].includes(t.propertyId) || !/^U[a-f0-9]{32}$/i.test(t.recipientId) || !t.verifiedBy?.trim() || !Number.isFinite(Date.parse(t.verifiedAt)) || Date.parse(t.verifiedAt) > now.getTime()) throw Error();
        } else if (t.kind !== 'workspace' || !/^[a-f0-9-]{36}$/i.test(t.bindingId)) throw Error();
      }
    }
  } catch { throw Error('ARRIVAL_WORKER_CONFIG'); }
  const fingerprint = createHash('sha256').update(token).digest('hex');
  const worker = rows.find(w => timingSafeEqual(Buffer.from(w.token_sha256), Buffer.from(fingerprint)));
  if (!worker) throw Error('UNAUTHORIZED');
  return worker;
}
export async function targetList(store: CustomerStore, target: Target, now = new Date()) {
  if (target.kind === 'legacy') return { list: await legacyList(target.propertyId, now), recipient: target.recipientId };
  if (target.kind === 'tenant') {
    const setting = await targetSetting(store, target.id);
    if (!setting || setting.workspaceId !== target.workspaceId || setting.propertyId !== target.propertyId) throw Error('FORBIDDEN');
    const active = await activeTenantRecipient(store, setting);
    if (!active) throw Error('FORBIDDEN');
    return { list: await customerList(store, active.ownerAccountId, setting.slug, setting.propertyId, now), recipient: active.recipient };
  }
  const binding = (await store.read<WebsiteBinding>(`website:binding:${target.bindingId}`)).value;
  if (!binding || binding.id !== target.bindingId || !binding.enabled || !binding.ownerLine || !/^U[a-f0-9]{32}$/i.test(binding.ownerLine.recipientId) || !binding.ownerLine.verifiedBy || !Number.isFinite(Date.parse(binding.ownerLine.verifiedAt)) || Date.parse(binding.ownerLine.verifiedAt) > now.getTime()) throw Error('FORBIDDEN');
  // Re-check the current owner's active membership/property grant on every dispatch.
  const current = await loadWorkspace(store, binding.ownerAccountId, binding.slug);
  if (current.workspace.id !== binding.workspaceId || current.member.role !== "owner") throw Error("FORBIDDEN");
  const list = await customerList(store, binding.ownerAccountId, binding.slug, binding.propertyId, now);
  return { list, recipient: binding.ownerLine.recipientId };
}
export async function workerOperation(store: CustomerStore, worker: ReminderWorker, input: Record<string, unknown>, now = new Date(), load = targetList) {
  if (input.action === 'pair') {
    const result = await consumeRecipientPairing(store, worker.id, input.pairingToken, input.recipientId, now);
    return { ...result };
  }
  const tenantRows = await targetIndex(store);
  const tenantTargets: TenantTarget[] = tenantRows.map(row => ({ ...row, kind: 'tenant', includeUnconfirmed: false }));
  const allTargets: Target[] = [...worker.targets, ...tenantTargets];
  if (allTargets.length > 50 || new Set(allTargets.map(t => t.id)).size !== allTargets.length) throw Error('ARRIVAL_TARGET_CONFIG');
  if (input.action === 'targets') return { targets: allTargets.map(t => t.id), day: taipeiDay(now), scheduledHour: 9, timezone: 'Asia/Taipei' };
  const target = allTargets.find(t => t.id === input.targetId);
  if (!target) throw Error('FORBIDDEN');
  if (typeof input.attemptId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.attemptId)) throw Error('INVALID_INPUT');
  await store.limit(`arrival-worker:${worker.id}:${target.id}`, 300);
  if (input.action === 'ack' || input.action === 'status') {
    if (typeof input.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.day) || typeof input.jobId !== 'string' || !/^[a-f0-9]{64}$/.test(input.jobId) || !Number.isFinite(Date.parse(input.day)) || new Date(input.day).toISOString().slice(0, 10) !== input.day) throw Error('INVALID_INPUT');
    if (input.action === 'status') return reminderStatus(store, worker.id, target.id, input.day, input.attemptId, input.jobId);
    return acknowledgeReminder(store, worker.id, target.id, input.day, input.attemptId, input.jobId, input.outcome as 'sent' | 'failed' | 'unknown', input.providerReceipt as string | undefined, now);
  }
  if (input.action !== 'claim') throw Error('INVALID_INPUT');
  // Bind a persisted attempt to its original Taipei day; an overnight retry must
  // never silently claim tomorrow's notes using yesterday's send identity.
  if (input.day !== taipeiDay(now)) return { day: taipeiDay(now), jobs: [], results: [], status: 'outside_window' };
  const hour = new Date(now.getTime() + 8 * 3600_000).getUTCHours();
  if (hour !== 9) return { day: taipeiDay(now), jobs: [], results: [], status: 'outside_window' };
  if (target.kind === 'tenant') {
    const setting = await targetSetting(store, target.id);
    if (!setting) throw Error('ARRIVAL_TARGET_CONFIG');
    if (!await activeTenantRecipient(store, setting)) return { day: taipeiDay(now), jobs: [], results: [], status: 'disabled' };
    target.includeUnconfirmed = setting.includeUnconfirmed;
  }
  const { list, recipient } = await load(store, target, now);
  return { day: list.day, ...await claimReminder(store, worker.id, target.id, recipient, input.attemptId, list, now, target.includeUnconfirmed === true) };
}
