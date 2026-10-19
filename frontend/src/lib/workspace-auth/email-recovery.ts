import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { credentialBinding, createPasswordCredential, passwordProblem } from '../owner-password.ts';
import { nextWorkspace, normalizedEmail, validEmail, type Member } from './types.ts';
import type { WorkspaceStore } from './store.ts';

export const RECOVERY_LIFETIME_MS = 30 * 60 * 1000;
const tokenHash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const tokenPattern = /^([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/;

export function emailRecoveryUrl(token: string, requestOrigin?: string) {
  const url = new URL(process.env.WORKSPACE_RECOVERY_LINK_ORIGIN || requestOrigin || 'https://sweetfun-os.vercel.app');
  if (url.protocol !== 'https:' ||
    url.hostname !== 'sweetfun-os.vercel.app' && !/^sweetfun-[a-z0-9]+-sweetfuns-projects\.vercel\.app$/.test(url.hostname) ||
    url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.port)
    throw new Error('MAIL_NOT_CONFIGURED');
  return `${url.origin}/recover-calendar-password#${token}`;
}

function eligibleMember(members: Member[], email: string) {
  const matches = members.filter(member => member.email === email && member.status === 'active' &&
    member.role !== 'god' && member.credential);
  return matches.length === 1 ? matches[0] : null;
}

export async function requestEmailRecovery(
  store: WorkspaceStore,
  emailInput: unknown,
  send: (to: string, url: string) => Promise<unknown>,
  now = Date.now(),
  requestOrigin?: string,
) {
  const email = normalizedEmail(emailInput);
  if (!validEmail(email)) throw new Error('INVALID_INPUT');
  const state = await store.read();
  const member = eligibleMember(state.value.members, email);
  if (!member?.credential) return { eligible: false, delivered: false };
  const secret = randomBytes(32).toString('base64url');
  const recovery = {
    hash: tokenHash(secret),
    expires: now + RECOVERY_LIFETIME_MS,
    version: member.version + 1,
    credentialBinding: credentialBinding(member.credential),
  };
  const url = emailRecoveryUrl(`${member.id}.${secret}`, requestOrigin);
  const updated: Member = { ...member, passwordRecovery: recovery, version: recovery.version };
  await store.replace(state.raw, nextWorkspace(state.value,
    state.value.members.map(item => item.id === member.id ? updated : item),
    'password_recovery_requested', member.id, member.id));
  const check = (await store.read()).value.members.find(item => item.id === member.id);
  if (check?.passwordRecovery?.hash !== recovery.hash || check.version !== recovery.version)
    throw new Error('WRITE_UNCONFIRMED');
  try {
    await send(email, url);
    return { eligible: true, delivered: true };
  } catch {
    // The public request response must not reveal whether this email has an account.
    return { eligible: true, delivered: false };
  }
}

export function checkedEmailRecovery(token: unknown, members: Member[], now = Date.now()) {
  const match = typeof token === 'string' ? tokenPattern.exec(token) : null;
  if (!match) throw new Error('RECOVERY_INVALID');
  const member = members.find(item => item.id === match[1]);
  const recovery = member?.passwordRecovery;
  if (!member || !member.credential || member.status !== 'active' || member.role === 'god' ||
    !recovery || recovery.expires <= now || recovery.version !== member.version ||
    recovery.credentialBinding !== credentialBinding(member.credential) ||
    !/^[a-f0-9]{64}$/.test(recovery.hash) ||
    !timingSafeEqual(Buffer.from(recovery.hash, 'hex'), Buffer.from(tokenHash(match[2]), 'hex')))
    throw new Error('RECOVERY_INVALID');
  return member;
}

export async function inspectEmailRecovery(store: WorkspaceStore, token: unknown, now = Date.now()) {
  const member = checkedEmailRecovery(token, (await store.read()).value.members, now);
  return { valid: true, expiresAt: member.passwordRecovery!.expires };
}

export async function consumeEmailRecovery(
  store: WorkspaceStore,
  token: unknown,
  password: unknown,
  confirmPassword: unknown,
  now = Date.now(),
) {
  if (passwordProblem(password) || password !== confirmPassword) throw new Error('PASSWORD_INVALID');
  const state = await store.read();
  const member = checkedEmailRecovery(token, state.value.members, now);
  const credential = await createPasswordCredential(password as string);
  const updated: Member = {
    ...member,
    credential,
    mustResetPassword: false,
    invitation: null,
    passwordRecovery: null,
    version: member.version + 1,
  };
  await store.replace(state.raw, nextWorkspace(state.value,
    state.value.members.map(item => item.id === member.id ? updated : item),
    'password_recovered_by_email', member.id, member.id));
  const current = (await store.read()).value.members.find(item => item.id === member.id);
  if (current?.version !== updated.version || current.passwordRecovery ||
    credentialBinding(current.credential!) !== credentialBinding(credential))
    throw new Error('WRITE_UNCONFIRMED');
  return { reset: true, email: member.email };
}
