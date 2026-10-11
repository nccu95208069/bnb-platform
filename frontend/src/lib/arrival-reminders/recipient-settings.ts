import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CustomerStore } from '../customer-workspaces/store.ts';
import type { Membership, Workspace } from '../customer-workspaces/types.ts';
import { loadWorkspace, validSlug } from '../customer-workspaces/service.ts';

type Recipient = { accountId: string; slot: 0 | 1 | 2; line?: { recipientId: string; verifiedAt: string; verifiedBy: string } };
export type ArrivalRecipientSetting = {
  schema: 2; workspaceId: string; slug: string; propertyId: string;
  recipients: Recipient[]; enabled: boolean; includeUnconfirmed: boolean;
  generation: number; updatedAt: string; updatedBy: string;
};
export type IndexedTarget = { id: string; workspaceId: string; slug: string; propertyId: string };
type Pairing = { id: string; workspaceId: string; propertyId: string; recipientAccountId: string;
  generation: number; secretHash: string; expiresAt: string; recipientId?: string; consumedBy?: string };
const indexKey = 'arrival:tenant-targets';
const settingKey = (workspaceId: string, propertyId: string) => `arrival:recipient:${workspaceId}:${propertyId}`;
const pairingKey = (id: string) => `arrival:recipient-pair:${id}`;
const lineId = /^U[a-f0-9]{32}$/i;
export const maxTenantProperties = 16; // 16 properties × 3 recipients + 2 static targets = 50.

export function tenantTargetId(workspaceId: string, propertyId: string, slot: number) {
  if (![0, 1, 2].includes(slot)) throw Error('ARRIVAL_TARGET_CONFIG');
  return 'tenant-' + createHash('sha256').update(JSON.stringify([workspaceId, propertyId, slot])).digest('hex').slice(0, 48);
}
function indexId(workspaceId: string, propertyId: string) {
  return 'property-' + createHash('sha256').update(JSON.stringify([workspaceId, propertyId])).digest('hex').slice(0, 48);
}
function allowedRecipient(member: Membership | undefined, propertyId: string) {
  return Boolean(member?.active && ['owner', 'admin', 'housekeeper'].includes(member.role) &&
    (member.allProperties || member.propertyIds.includes(propertyId)));
}
function validRecipients(value: unknown): value is Recipient[] {
  return Array.isArray(value) && value.length <= 3 && value.every(row => row && typeof row.accountId === 'string' && row.accountId.length > 0 && [0, 1, 2].includes(row.slot)) &&
    new Set(value.map(row => row.accountId)).size === value.length && new Set(value.map(row => row.slot)).size === value.length;
}
export async function recipientSetting(store: CustomerStore, workspaceId: string, propertyId: string) {
  return store.read<ArrivalRecipientSetting>(settingKey(workspaceId, propertyId));
}
export async function targetIndex(store: CustomerStore): Promise<IndexedTarget[]> {
  const rows = (await store.read<IndexedTarget[]>(indexKey)).value ?? [];
  if (!Array.isArray(rows) || rows.length > maxTenantProperties || rows.some(row => !row || row.id !== indexId(row.workspaceId, row.propertyId))) throw Error('ARRIVAL_TARGET_CONFIG');
  return rows;
}
export async function tenantTargets(store: CustomerStore) {
  const rows = await targetIndex(store);
  const result: { id: string; workspaceId: string; slug: string; propertyId: string; slot: number }[] = [];
  for (const row of rows) {
    const setting = (await recipientSetting(store, row.workspaceId, row.propertyId)).value;
    if (!setting || setting.workspaceId !== row.workspaceId || setting.slug !== row.slug || setting.propertyId !== row.propertyId || !validRecipients(setting.recipients)) throw Error('ARRIVAL_TARGET_CONFIG');
    for (const slot of [0, 1, 2]) result.push({ ...row, id: tenantTargetId(row.workspaceId, row.propertyId, slot), slot });
  }
  return result;
}
export async function targetSetting(store: CustomerStore, id: string) {
  const target = (await tenantTargets(store)).find(row => row.id === id);
  if (!target) return null;
  const setting = (await recipientSetting(store, target.workspaceId, target.propertyId)).value;
  if (!setting) throw Error('ARRIVAL_TARGET_CONFIG');
  return { setting, slot: target.slot, accountId: setting.recipients.find(r => r.slot === target.slot)?.accountId ?? null };
}
export async function settingView(store: CustomerStore, actor: string, slug: string, propertyId: string) {
  const { workspace, member } = await loadWorkspace(store, actor, validSlug(slug));
  if (!workspace.properties.some(p => p.id === propertyId) || !allowedRecipient(member, propertyId)) throw Error('FORBIDDEN');
  const setting = (await recipientSetting(store, workspace.id, propertyId)).value;
  const canManage = member.role === 'owner' && (member.allProperties || member.propertyIds.includes(propertyId));
  const canPair = Boolean(setting?.recipients.some(r => r.accountId === actor));
  if (!canManage && !canPair) throw Error('FORBIDDEN');
  return {
    propertyName: workspace.properties.find(p => p.id === propertyId)!.name,
    enabled: setting?.enabled === true, includeUnconfirmed: setting?.includeUnconfirmed === true,
    recipients: (setting?.recipients ?? []).filter(r => canManage || r.accountId === actor).map(r => ({
      accountId: r.accountId, email: workspace.members.find(m => m.accountId === r.accountId)?.email ?? null,
      lineConnected: Boolean(r.line && lineId.test(r.line.recipientId) && r.line.verifiedBy &&
        Number.isFinite(Date.parse(r.line.verifiedAt)) &&
        allowedRecipient(workspace.members.find(m => m.accountId === r.accountId), propertyId)),
      lineVerifiedAt: r.line?.verifiedAt ?? null,
    })),
    canManage, canPair,
    members: canManage ? workspace.members.filter(m => allowedRecipient(m, propertyId)).map(m => ({ accountId: m.accountId, email: m.email, role: m.role })) : [],
  };
}
export async function saveRecipientSetting(store: CustomerStore, actor: string, slug: string, propertyId: string, input: Record<string, unknown>, now = new Date()) {
  const { workspace, member } = await loadWorkspace(store, actor, validSlug(slug));
  if (member.role !== 'owner' || !workspace.properties.some(p => p.id === propertyId) ||
      (!member.allProperties && !member.propertyIds.includes(propertyId))) throw Error('FORBIDDEN');
  if (typeof input.enabled !== 'boolean' || typeof input.includeUnconfirmed !== 'boolean' ||
      !Array.isArray(input.recipientAccountIds) || input.recipientAccountIds.length > 3 ||
      input.recipientAccountIds.some(id => typeof id !== 'string') ||
      new Set(input.recipientAccountIds).size !== input.recipientAccountIds.length ||
      (input.enabled && !input.recipientAccountIds.length)) throw Error('INVALID_INPUT');
  const ids = input.recipientAccountIds as string[];
  if (ids.some(id => !allowedRecipient(workspace.members.find(m => m.accountId === id), propertyId))) throw Error('FORBIDDEN');
  const key = settingKey(workspace.id, propertyId), saved = await store.read<ArrivalRecipientSetting>(key);
  const indexed = await store.read<IndexedTarget[]>(indexKey), rows = indexed.value ?? [];
  if (!Array.isArray(rows) || rows.length > maxTenantProperties) throw Error('ARRIVAL_TARGET_CONFIG');
  const id = indexId(workspace.id, propertyId);
  if (!rows.some(row => row.id === id) && rows.length === maxTenantProperties) throw Error('LIMIT_REACHED');
  const usedSlots = new Set(ids.map(accountId => saved.value?.recipients.find(r => r.accountId === accountId)?.slot).filter((slot): slot is 0 | 1 | 2 => slot !== undefined));
  const next: ArrivalRecipientSetting = {
    schema: 2, workspaceId: workspace.id, slug, propertyId,
    recipients: ids.map(accountId => {
      const old = saved.value?.recipients.find(r => r.accountId === accountId);
      const assigned = old?.slot ?? [0, 1, 2].find(slot => !usedSlots.has(slot as 0 | 1 | 2));
      if (assigned === undefined) throw Error('ARRIVAL_TARGET_CONFIG');
      usedSlots.add(assigned as 0 | 1 | 2);
      return { accountId, slot: assigned as 0 | 1 | 2, ...(old?.line ? { line: old.line } : {}) };
    }),
    enabled: input.enabled, includeUnconfirmed: input.includeUnconfirmed, updatedAt: now.toISOString(), updatedBy: actor,
    generation: (saved.value?.generation ?? 0) + 1,
  };
  await store.commit([
    { key, before: saved.raw, after: next },
    { key: indexKey, before: indexed.raw, after: rows.some(row => row.id === id) ? rows : [...rows, { id, workspaceId: workspace.id, slug, propertyId }] },
  ]);
  const confirmed = (await store.read<ArrivalRecipientSetting>(key)).value;
  if (confirmed?.generation !== next.generation || JSON.stringify(confirmed.recipients) !== JSON.stringify(next.recipients) || confirmed.enabled !== next.enabled) throw Error('WRITE_UNCONFIRMED');
  return settingView(store, actor, slug, propertyId);
}
export async function prepareRecipientPairing(store: CustomerStore, actor: string, slug: string, propertyId: string, now = new Date()) {
  const { workspace, member } = await loadWorkspace(store, actor, validSlug(slug));
  if (!allowedRecipient(member, propertyId)) throw Error('FORBIDDEN');
  const setting = (await recipientSetting(store, workspace.id, propertyId)).value;
  if (!setting?.recipients.some(r => r.accountId === actor)) throw Error('FORBIDDEN');
  await store.limit(`arrival-recipient-pair:${actor}`, 10);
  const id = randomUUID(), secret = randomBytes(32).toString('base64url');
  const pair: Pairing = { id, workspaceId: workspace.id, propertyId, recipientAccountId: actor,
    generation: setting.generation, secretHash: createHash('sha256').update(secret).digest('hex'),
    expiresAt: new Date(now.getTime() + 10 * 60000).toISOString() };
  await store.commit([{ key: pairingKey(id), before: null, after: pair, ttlSeconds: 86400 }]);
  return { command: `接收入住 ${id}.${secret}`, expiresAt: pair.expiresAt };
}
// Called only with the userId from a signature-verified one-to-one LINE webhook.
export async function consumeRecipientPairing(store: CustomerStore, workerId: string, commandToken: unknown, recipientId: unknown, now = new Date()) {
  if (typeof commandToken !== 'string' || typeof recipientId !== 'string' || !lineId.test(recipientId)) throw Error('INVALID_INPUT');
  const match = commandToken.match(/^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/i);
  if (!match) throw Error('INVALID_INPUT');
  const saved = await store.read<Pairing>(pairingKey(match[1]));
  const pair = saved.value;
  if (!pair || pair.id !== match[1]) throw Error('PAIRING_EXPIRED');
  const proof = createHash('sha256').update(match[2]).digest('hex');
  if (!timingSafeEqual(Buffer.from(proof), Buffer.from(pair.secretHash))) throw Error('PAIRING_EXPIRED');
  const key = settingKey(pair.workspaceId, pair.propertyId), current = await store.read<ArrivalRecipientSetting>(key);
  const setting = current.value;
  const selected = setting?.recipients.find(r => r.accountId === pair.recipientAccountId);
  if (!setting || !selected || setting.generation !== pair.generation) throw Error('PAIRING_EXPIRED');
  const workspace = (await store.read<Workspace>(`workspace:${pair.workspaceId}`)).value;
  if (!workspace || workspace.slug !== setting.slug || !workspace.properties.some(p => p.id === pair.propertyId) ||
      !allowedRecipient(workspace.members.find(m => m.accountId === pair.recipientAccountId), pair.propertyId)) throw Error('FORBIDDEN');
  if (pair.recipientId) {
    if (pair.recipientId !== recipientId || pair.consumedBy !== workerId || selected.line?.recipientId !== recipientId) throw Error('IDEMPOTENCY_CONFLICT');
    return { state: 'connected' };
  }
  if (Date.parse(pair.expiresAt) <= now.getTime()) throw Error('PAIRING_EXPIRED');
  if (!workspace.members.some(m => m.active && m.role === 'owner' && (m.allProperties || m.propertyIds.includes(pair.propertyId)))) throw Error('FORBIDDEN');
  if (setting.recipients.some(r => r.accountId !== pair.recipientAccountId && r.line?.recipientId === recipientId)) throw Error('IDEMPOTENCY_CONFLICT');
  await store.commit([
    { key, before: current.raw, after: { ...setting, recipients: setting.recipients.map(r => r.accountId === pair.recipientAccountId ? { ...r, line: { recipientId, verifiedAt: now.toISOString(), verifiedBy: workerId } } : r) } },
    { key: pairingKey(pair.id), before: saved.raw, after: { ...pair, recipientId, consumedBy: workerId }, ttlSeconds: 86400 },
  ]);
  const confirmed = (await store.read<ArrivalRecipientSetting>(key)).value;
  const line = confirmed?.recipients.find(r => r.accountId === pair.recipientAccountId)?.line;
  if (line?.recipientId !== recipientId || line.verifiedBy !== workerId) throw Error('WRITE_UNCONFIRMED');
  return { state: 'connected' };
}
export async function activeTenantRecipient(store: CustomerStore, setting: ArrivalRecipientSetting, accountId: string) {
  const selected = setting.recipients.find(r => r.accountId === accountId);
  if (!setting.enabled || !selected?.line || !lineId.test(selected.line.recipientId) ||
      !selected.line.verifiedBy || !Number.isFinite(Date.parse(selected.line.verifiedAt))) return null;
  const workspace = (await store.read<Workspace>(`workspace:${setting.workspaceId}`)).value;
  if (!workspace || workspace.slug !== setting.slug || !workspace.properties.some(p => p.id === setting.propertyId) ||
      !allowedRecipient(workspace.members.find(m => m.accountId === accountId), setting.propertyId)) return null;
  const owner = workspace.members.find(m => allowedRecipient(m, setting.propertyId) && m.role === 'owner');
  if (!owner) return null;
  return { recipient: selected.line.recipientId, ownerAccountId: owner.accountId };
}
