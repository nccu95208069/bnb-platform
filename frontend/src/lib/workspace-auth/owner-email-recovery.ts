import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { credentialBinding, createPasswordCredential, passwordProblem, type OwnerCredentialStore } from '../owner-password.ts';
import { ADMIN_EMAIL } from './types.ts';
import { emailRecoveryUrl, RECOVERY_LIFETIME_MS } from './email-recovery.ts';

type RecoveryRecord = { hash: string; expires: number; credentialBinding: string };
export interface OwnerEmailRecoveryStore extends OwnerCredentialStore {
  readRecovery(): Promise<string | null>;
  saveRecovery(value: string, seconds: number): Promise<void>;
  replaceForRecovery(expectedCredential: string, expectedRecovery: string, next: Awaited<ReturnType<typeof createPasswordCredential>>): Promise<boolean>;
}

const tokenPattern = /^owner\.([A-Za-z0-9_-]{43})$/;
const tokenHash = (secret: string) => createHash('sha256').update(secret).digest('hex');

function checkedRecord(token: unknown, raw: string | null, binding: string, now: number) {
  const match = typeof token === 'string' ? tokenPattern.exec(token) : null;
  if (!match || !raw) throw new Error('RECOVERY_INVALID');
  let value: RecoveryRecord;
  try { value = JSON.parse(raw); } catch { throw new Error('RECOVERY_INVALID'); }
  if (!value || typeof value.expires !== 'number' || value.expires <= now ||
    value.credentialBinding !== binding || typeof value.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    !timingSafeEqual(Buffer.from(value.hash, 'hex'), Buffer.from(tokenHash(match[1]), 'hex')))
    throw new Error('RECOVERY_INVALID');
  return value;
}

export async function requestOwnerEmailRecovery(
  store: OwnerEmailRecoveryStore,
  send: (to: string, url: string) => Promise<unknown>,
  now = Date.now(),
  requestOrigin?: string,
) {
  const previous = await store.read();
  const secret = randomBytes(32).toString('base64url');
  const recovery: RecoveryRecord = {
    hash: tokenHash(secret), expires: now + RECOVERY_LIFETIME_MS,
    credentialBinding: credentialBinding(previous.value),
  };
  const raw = JSON.stringify(recovery);
  const url = emailRecoveryUrl(`owner.${secret}`, requestOrigin);
  await store.saveRecovery(raw, Math.ceil(RECOVERY_LIFETIME_MS / 1000));
  if (await store.readRecovery() !== raw ||
    credentialBinding((await store.read()).value) !== recovery.credentialBinding)
    throw new Error('WRITE_UNCONFIRMED');
  try {
    await send(ADMIN_EMAIL, url);
    return { eligible: true, delivered: true };
  } catch {
    return { eligible: true, delivered: false };
  }
}

export async function inspectOwnerEmailRecovery(store: OwnerEmailRecoveryStore, token: unknown, now = Date.now()) {
  const credential = await store.read();
  const record = checkedRecord(token, await store.readRecovery(), credentialBinding(credential.value), now);
  return { valid: true, expiresAt: record.expires };
}

export async function consumeOwnerEmailRecovery(
  store: OwnerEmailRecoveryStore,
  token: unknown,
  password: unknown,
  confirmPassword: unknown,
  now = Date.now(),
) {
  if (passwordProblem(password) || password !== confirmPassword) throw new Error('PASSWORD_INVALID');
  const previous = await store.read();
  const raw = await store.readRecovery();
  checkedRecord(token, raw, credentialBinding(previous.value), now);
  const next = await createPasswordCredential(password as string);
  if (!raw || !await store.replaceForRecovery(previous.raw, raw, next)) throw new Error('RECOVERY_INVALID');
  const saved = await store.read();
  if (credentialBinding(saved.value) !== credentialBinding(next)) throw new Error('WRITE_UNCONFIRMED');
  return { reset: true, email: ADMIN_EMAIL };
}
