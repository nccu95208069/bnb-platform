import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CustomerStore } from '../customer-workspaces/store.ts';
import type { Membership, Workspace } from '../customer-workspaces/types.ts';
import { loadWorkspace, validSlug } from '../customer-workspaces/service.ts';

export type ArrivalRecipientSetting = {
  schema: 1; workspaceId: string; slug: string; propertyId: string;
  recipientAccountId: string; enabled: boolean; includeUnconfirmed: boolean;
  generation: number; updatedAt: string; updatedBy: string;
  line?: { recipientId: string; verifiedAt: string; verifiedBy: string };
};
type IndexedTarget = { id: string; workspaceId: string; slug: string; propertyId: string };
type Pairing = { id: string; workspaceId: string; propertyId: string; recipientAccountId: string;
  generation: number; secretHash: string; expiresAt: string; recipientId?: string; consumedBy?: string };
const indexKey = 'arrival:tenant-targets';
const settingKey = (workspaceId: string, propertyId: string) => `arrival:recipient:${workspaceId}:${propertyId}`;
const pairingKey = (id: string) => `arrival:recipient-pair:${id}`;
const lineId = /^U[a-f0-9]{32}$/i;

export function tenantTargetId(workspaceId: string, propertyId: string) {
  return 'tenant-' + createHash('sha256').update(`${workspaceId}:${propertyId}`).digest('hex').slice(0, 48);
}
function allowedRecipient(member: Membership | undefined, propertyId: string) {
  return Boolean(member?.active && ['owner', 'admin', 'housekeeper'].includes(member.role) &&
    (member.allProperties || member.propertyIds.includes(propertyId)));
}
export async function recipientSetting(store: CustomerStore, workspaceId: string, propertyId: string) {
  return store.read<ArrivalRecipientSetting>(settingKey(workspaceId, propertyId));
}
export async function targetIndex(store: CustomerStore): Promise<IndexedTarget[]> {
  const rows = (await store.read<IndexedTarget[]>(indexKey)).value ?? [];
  if (!Array.isArray(rows) || rows.length > 48 || rows.some(row => !row || row.id !== tenantTargetId(row.workspaceId, row.propertyId))) throw Error('ARRIVAL_TARGET_CONFIG');
  return rows;
}
export async function targetSetting(store: CustomerStore, id: string) {
  const target = (await targetIndex(store)).find(row => row.id === id);
  if (!target) return null;
  const setting = (await recipientSetting(store, target.workspaceId, target.propertyId)).value;
  if (!setting || setting.workspaceId !== target.workspaceId || setting.slug !== target.slug || setting.propertyId !== target.propertyId) throw Error('ARRIVAL_TARGET_CONFIG');
  return setting;
}
export async function settingView(store: CustomerStore, actor: string, slug: string, propertyId: string) {
  const { workspace, member } = await loadWorkspace(store, actor, validSlug(slug));
  if (!workspace.properties.some(p => p.id === propertyId) || !allowedRecipient(member, propertyId)) throw Error('FORBIDDEN');
  const setting = (await recipientSetting(store, workspace.id, propertyId)).value;
  const selected = workspace.members.find(m => m.accountId === setting?.recipientAccountId);
  const canManage = member.role === 'owner' && (member.allProperties || member.propertyIds.includes(propertyId));
  const canPair = setting?.recipientAccountId === actor && allowedRecipient(member, propertyId);
  if (!canManage && !canPair) throw Error('FORBIDDEN');
  return {
    propertyName: workspace.properties.find(p => p.id === propertyId)!.name,
    enabled: setting?.enabled === true, includeUnconfirmed: setting?.includeUnconfirmed === true,
    selectedAccountId: setting?.recipientAccountId ?? null,
    selectedEmail: selected?.email ?? null,
    lineConnected: Boolean(setting?.line?.verifiedAt && selected && allowedRecipient(selected, propertyId)),
    lineVerifiedAt: setting?.line?.verifiedAt ?? null,
    canManage, canPair,
    members: canManage ? workspace.members.filter(m => allowedRecipient(m, propertyId)).map(m => ({ accountId: m.accountId, email: m.email, role: m.role })) : [],
  };
}
export async function saveRecipientSetting(store: CustomerStore, actor: string, slug: string, propertyId: string, input: Record<string, unknown>, now = new Date()) {
  const { workspace, member } = await loadWorkspace(store, actor, validSlug(slug));
  if (member.role !== 'owner' || !workspace.properties.some(p => p.id === propertyId) ||
      (!member.allProperties && !member.propertyIds.includes(propertyId))) throw Error('FORBIDDEN');
  if (typeof input.enabled !== 'boolean' || typeof input.includeUnconfirmed !== 'boolean' ||
      typeof input.recipientAccountId !== 'string') throw Error('INVALID_INPUT');
  const recipient = workspace.members.find(m => m.accountId === input.recipientAccountId);
  if (!allowedRecipient(recipient, propertyId)) throw Error('FORBIDDEN');
  const key = settingKey(workspace.id, propertyId), saved = await store.read<ArrivalRecipientSetting>(key);
  const indexed = await store.read<IndexedTarget[]>(indexKey), rows = indexed.value ?? [];
  if (!Array.isArray(rows) || rows.length > 48) throw Error('ARRIVAL_TARGET_CONFIG');
  const id = tenantTargetId(workspace.id, propertyId);
  if (!rows.some(row => row.id === id) && rows.length === 48) throw Error('LIMIT_REACHED');
  const next: ArrivalRecipientSetting = {
    schema: 1, workspaceId: workspace.id, slug, propertyId,
    recipientAccountId: recipient!.accountId, enabled: input.enabled,
    includeUnconfirmed: input.includeUnconfirmed, updatedAt: now.toISOString(), updatedBy: actor,
    generation: (saved.value?.generation ?? 0) + 1,
    ...(saved.value?.recipientAccountId === recipient!.accountId && saved.value.line ? { line: saved.value.line } : {}),
  };
  await store.commit([
    { key, before: saved.raw, after: next },
    { key: indexKey, before: indexed.raw, after: rows.some(row => row.id === id) ? rows : [...rows, { id, workspaceId: workspace.id, slug, propertyId }] },
  ]);
  const confirmed = (await store.read<ArrivalRecipientSetting>(key)).value;
  if (confirmed?.generation !== next.generation || confirmed.recipientAccountId !== next.recipientAccountId || confirmed.enabled !== next.enabled) throw Error('WRITE_UNCONFIRMED');
  return settingView(store, actor, slug, propertyId);
}
export async function prepareRecipientPairing(store: CustomerStore, actor: string, slug: string, propertyId: string, now = new Date()) {
  const { workspace, member } = await loadWorkspace(store, actor, validSlug(slug));
  if (!allowedRecipient(member, propertyId)) throw Error('FORBIDDEN');
  const setting = (await recipientSetting(store, workspace.id, propertyId)).value;
  if (!setting || setting.recipientAccountId !== actor) throw Error('FORBIDDEN');
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
  if (!setting || setting.recipientAccountId !== pair.recipientAccountId || setting.generation !== pair.generation) throw Error('PAIRING_EXPIRED');
  const workspace = (await store.read<Workspace>(`workspace:${pair.workspaceId}`)).value;
  if (!workspace || workspace.slug !== setting.slug || !workspace.properties.some(p => p.id === pair.propertyId) ||
      !allowedRecipient(workspace.members.find(m => m.accountId === pair.recipientAccountId), pair.propertyId)) throw Error('FORBIDDEN');
  if (pair.recipientId) {
    if (pair.recipientId !== recipientId || pair.consumedBy !== workerId || setting.line?.recipientId !== recipientId) throw Error('IDEMPOTENCY_CONFLICT');
    return { state: 'connected' };
  }
  if (Date.parse(pair.expiresAt) <= now.getTime()) throw Error('PAIRING_EXPIRED');
  if (!workspace.members.some(m => m.active && m.role === 'owner' && (m.allProperties || m.propertyIds.includes(pair.propertyId)))) throw Error('FORBIDDEN');
  await store.commit([
    { key, before: current.raw, after: { ...setting, line: { recipientId, verifiedAt: now.toISOString(), verifiedBy: workerId } } },
    { key: pairingKey(pair.id), before: saved.raw, after: { ...pair, recipientId, consumedBy: workerId }, ttlSeconds: 86400 },
  ]);
  const confirmed = (await store.read<ArrivalRecipientSetting>(key)).value;
  if (confirmed?.line?.recipientId !== recipientId || confirmed.line.verifiedBy !== workerId) throw Error('WRITE_UNCONFIRMED');
  return { state: 'connected' };
}
export async function activeTenantRecipient(store: CustomerStore, setting: ArrivalRecipientSetting) {
  if (!setting.enabled || !setting.line || !lineId.test(setting.line.recipientId) ||
      !setting.line.verifiedBy || !Number.isFinite(Date.parse(setting.line.verifiedAt))) return null;
  const workspace = (await store.read<Workspace>(`workspace:${setting.workspaceId}`)).value;
  if (!workspace || workspace.slug !== setting.slug || !workspace.properties.some(p => p.id === setting.propertyId) ||
      !allowedRecipient(workspace.members.find(m => m.accountId === setting.recipientAccountId), setting.propertyId)) return null;
  const owner = workspace.members.find(m => allowedRecipient(m, setting.propertyId) && m.role === 'owner');
  if (!owner) return null;
  return { recipient: setting.line.recipientId, ownerAccountId: owner.accountId };
}
