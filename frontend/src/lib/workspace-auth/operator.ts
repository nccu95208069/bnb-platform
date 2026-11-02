// Server-side provisioning only. Never expose this through member-management API.
import { randomBytes } from 'node:crypto';
import { hashToken } from './members.ts';
import { normalizedEmail, validEmail, ADMIN_EMAIL, PROPERTY_IDS, nextWorkspace, type Member } from './types.ts';
import type { WorkspaceStore } from './store.ts';

export async function provisionOperator(store: WorkspaceStore, emailInput: string, now = Date.now()) {
  const email = normalizedEmail(emailInput);
  if (!validEmail(email) || email === ADMIN_EMAIL) throw new Error('INVALID_INPUT');
  const state = await store.read();
  if (state.value.members.some(member => member.email === email || member.role === 'god')) throw new Error('EMAIL_EXISTS');
  const secret = randomBytes(32).toString('base64url');
  const member: Member = {
    id: randomBytes(16).toString('hex'), email, displayName: '系統商 God', phone: null,
    role: 'god', status: 'invited', allProperties: true, propertyIds: [...PROPERTY_IDS],
    invitedAt: new Date(now).toISOString(), acceptedAt: null, lastActiveAt: null,
    credential: null, invitation: { hash: hashToken(secret), expires: now + 86400000, sent: 'pending' }, version: 1,
  };
  await store.replace(state.raw, nextWorkspace(state.value, [...state.value.members, member], 'operator_provisioned', member.id, 'system-provisioning'));
  const confirmed = (await store.read()).value.members.find(item => item.id === member.id);
  if (confirmed?.role !== 'god' || confirmed.email !== email || confirmed.invitation?.hash !== member.invitation?.hash) throw new Error('WRITE_UNCONFIRMED');
  return { member, token: `${member.id}.${secret}` };
}
