import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOwnerSession } from '../src/lib/calendar-owner-session.ts';
import { createPasswordCredential, credentialMatches, credentialSessionValid, parseCredential } from '../src/lib/owner-password.ts';
import { ADMIN_EMAIL } from '../src/lib/workspace-auth/types.ts';
import {
  consumeOwnerEmailRecovery, inspectOwnerEmailRecovery, requestOwnerEmailRecovery,
} from '../src/lib/workspace-auth/owner-email-recovery.ts';

process.env.CALENDAR_OWNER_SESSION_SECRET = 'b'.repeat(64);
process.env.CALENDAR_OWNER_CODE_HASH = createHash('sha256').update('a'.repeat(32)).digest('hex');

class MemoryOwnerStore {
  constructor(credential) {
    this.credential = JSON.stringify(credential);
    this.recovery = null;
  }
  async read() { return parseCredential(this.credential); }
  async replace(expected, next) {
    if (expected !== this.credential) return false;
    this.credential = JSON.stringify(next);
    return true;
  }
  async consumeAttempt() { return true; }
  async readRecovery() { return this.recovery; }
  async saveRecovery(raw) { this.recovery = raw; }
  async replaceForRecovery(expectedCredential, expectedRecovery, next) {
    if (this.credential !== expectedCredential || this.recovery !== expectedRecovery) return false;
    this.credential = JSON.stringify(next);
    this.recovery = null;
    return true;
  }
}

test('owner can recover a custom password once and prior sessions are revoked', async () => {
  const priorPassword = 'Synthetic owner prior phrase!';
  const store = new MemoryOwnerStore(await createPasswordCredential(priorPassword));
  const oldSession = createOwnerSession(Date.now(), (await store.read()).value.revision);
  const sent = [];
  const now = Date.now();
  assert.deepEqual(await requestOwnerEmailRecovery(store, async (to, url) => sent.push({ to, url }), now),
    { eligible: true, delivered: true });
  assert.equal(sent[0].to, ADMIN_EMAIL);
  const token = sent[0].url.split('#')[1];
  assert.match(token, /^owner\.[A-Za-z0-9_-]{43}$/);
  assert.equal(store.recovery.includes(token.split('.')[1]), false);
  assert.equal((await inspectOwnerEmailRecovery(store, token, now)).valid, true);
  assert.equal(credentialSessionValid(oldSession, (await store.read()).value), true);
  const nextPassword = 'Synthetic owner replacement phrase!';
  assert.deepEqual(await consumeOwnerEmailRecovery(store, token, nextPassword, nextPassword, now),
    { reset: true, email: ADMIN_EMAIL });
  assert.equal(await credentialMatches(priorPassword, (await store.read()).value), false);
  assert.equal(await credentialMatches(nextPassword, (await store.read()).value), true);
  assert.equal(credentialSessionValid(oldSession, (await store.read()).value), false);
  assert.equal(store.recovery, null);
  await assert.rejects(inspectOwnerEmailRecovery(store, token, now), /RECOVERY_INVALID/);
  await assert.rejects(consumeOwnerEmailRecovery(store, token, nextPassword, nextPassword, now), /RECOVERY_INVALID/);
});

test('bootstrap owner can recover without the original code', async () => {
  const store = new MemoryOwnerStore({ schema: 1, kind: 'bootstrap', hash: process.env.CALENDAR_OWNER_CODE_HASH });
  const links = [];
  await requestOwnerEmailRecovery(store, async (_to, url) => links.push(url));
  const nextPassword = 'Synthetic bootstrap replacement!';
  await consumeOwnerEmailRecovery(store, links[0].split('#')[1], nextPassword, nextPassword);
  assert.equal((await store.read()).value.kind, 'password');
  assert.equal(await credentialMatches(nextPassword, (await store.read()).value), true);
});

test('new owner link replaces the old; expiration and credential changes invalidate links', async () => {
  const store = new MemoryOwnerStore(await createPasswordCredential('Synthetic original owner phrase!'));
  const links = [];
  const now = Date.now();
  await requestOwnerEmailRecovery(store, async (_to, url) => links.push(url.split('#')[1]), now);
  await requestOwnerEmailRecovery(store, async (_to, url) => links.push(url.split('#')[1]), now + 1);
  await assert.rejects(inspectOwnerEmailRecovery(store, links[0], now + 2), /RECOVERY_INVALID/);
  await assert.rejects(inspectOwnerEmailRecovery(store, links[1], now + 30 * 60 * 1000 + 1), /RECOVERY_INVALID/);
  assert.equal((await inspectOwnerEmailRecovery(store, links[1], now + 2)).valid, true);
  store.credential = JSON.stringify(await createPasswordCredential('Synthetic changed credential phrase!'));
  await assert.rejects(inspectOwnerEmailRecovery(store, links[1], now + 2), /RECOVERY_INVALID/);
});

test('a newer link issued during completion prevents the older link from changing the credential', async () => {
  const store = new MemoryOwnerStore(await createPasswordCredential('Synthetic concurrent owner phrase!'));
  const links = [];
  await requestOwnerEmailRecovery(store, async (_to, url) => links.push(url.split('#')[1]));
  const replace = store.replaceForRecovery.bind(store);
  store.replaceForRecovery = async (credential, recovery, next) => {
    await requestOwnerEmailRecovery(store, async (_to, url) => links.push(url.split('#')[1]));
    return replace(credential, recovery, next);
  };
  const attempted = 'Synthetic stale replacement phrase!';
  await assert.rejects(consumeOwnerEmailRecovery(store, links[0], attempted, attempted), /RECOVERY_INVALID/);
  assert.equal(await credentialMatches(attempted, (await store.read()).value), false);
  assert.equal((await inspectOwnerEmailRecovery(store, links[1])).valid, true);
});
