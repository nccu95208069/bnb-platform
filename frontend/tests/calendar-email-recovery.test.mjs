import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPasswordCredential, credentialMatches } from '../src/lib/owner-password.ts';
import { createMemberSession, validMemberSession } from '../src/lib/workspace-auth/session.ts';
import {
  checkedEmailRecovery,
  consumeEmailRecovery,
  emailRecoveryUrl,
  inspectEmailRecovery,
  requestEmailRecovery,
  RECOVERY_LIFETIME_MS,
} from '../src/lib/workspace-auth/email-recovery.ts';

process.env.CALENDAR_OWNER_SESSION_SECRET = 'b'.repeat(64);
process.env.CALENDAR_OWNER_CODE_HASH = createHash('sha256').update('a'.repeat(32)).digest('hex');

class MemoryWorkspaceStore {
  constructor(members) { this.raw = JSON.stringify({ version: 1, members }); }
  async read() { return { raw: this.raw, value: JSON.parse(this.raw) }; }
  async replace(expected, value) {
    if (expected !== this.raw) throw Error('VERSION_CONFLICT');
    this.raw = JSON.stringify(value);
  }
  async limit() {}
}

async function fixture(overrides = {}) {
  const oldPassword = 'Synthetic old member phrase!';
  const member = {
    id: 'c'.repeat(32), displayName: 'Synthetic member', email: 'member@example.test', phone: null,
    role: 'viewer', status: 'active', allProperties: false, propertyIds: ['offland'],
    invitedAt: '', acceptedAt: null, lastActiveAt: null,
    credential: await createPasswordCredential(oldPassword), invitation: null, version: 1,
    ...overrides,
  };
  return { member, oldPassword, store: new MemoryWorkspaceStore([member]) };
}

test('email recovery is one-time, account-bound and revokes old sessions', async () => {
  const { member, oldPassword, store } = await fixture();
  const oldSession = createMemberSession(member);
  const sent = [];
  const now = Date.now();
  assert.deepEqual(await requestEmailRecovery(store, ' MEMBER@example.test ', async (to, url) => sent.push({ to, url }), now), { eligible: true, delivered: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, member.email);
  assert.ok(sent[0].url.startsWith('https://sweetfun-os.vercel.app/recover-calendar-password#'));
  const token = sent[0].url.split('#')[1];
  assert.equal(store.raw.includes(token.split('.')[1]), false, 'only a token digest is stored');
  assert.equal((await inspectEmailRecovery(store, token, now)).expiresAt, now + RECOVERY_LIFETIME_MS);
  const updated = (await store.read()).value.members[0];
  assert.equal(validMemberSession(oldSession, updated), true, 'request alone must not revoke a login');

  const newPassword = 'Synthetic new member phrase!';
  assert.deepEqual(await consumeEmailRecovery(store, token, newPassword, newPassword, now), { reset: true, email: member.email });
  const recovered = (await store.read()).value.members[0];
  assert.equal(await credentialMatches(oldPassword, recovered.credential), false);
  assert.equal(await credentialMatches(newPassword, recovered.credential), true);
  assert.equal(validMemberSession(oldSession, recovered), false);
  assert.equal(recovered.passwordRecovery, null);
  await assert.rejects(inspectEmailRecovery(store, token, now), /RECOVERY_INVALID/);
  await assert.rejects(consumeEmailRecovery(store, token, newPassword, newPassword, now), /RECOVERY_INVALID/);
});

test('an active god member can recover their own credential and revoke the prior session', async () => {
  const { member, store } = await fixture({ role: 'god' });
  const oldSession = createMemberSession(member);
  const sent = [];
  await requestEmailRecovery(store, member.email, async (_to, url) => sent.push(url));
  assert.equal(sent.length, 1);
  const token = sent[0].split('#')[1];
  const password = 'Synthetic god replacement phrase!';
  await consumeEmailRecovery(store, token, password, password);
  const updated = (await store.read()).value.members[0];
  assert.equal(updated.role, 'god');
  assert.equal(await credentialMatches(password, updated.credential), true);
  assert.equal(validMemberSession(oldSession, updated), false);
});

test('new requests, expiration and member changes invalidate earlier links', async () => {
  const { member, store } = await fixture();
  const sent = [];
  const send = async (_to, url) => sent.push(url.split('#')[1]);
  const now = Date.now();
  await requestEmailRecovery(store, member.email, send, now);
  await requestEmailRecovery(store, member.email, send, now + 1);
  assert.equal(sent.length, 2);
  const members = (await store.read()).value.members;
  assert.throws(() => checkedEmailRecovery(sent[0], members, now + 2), /RECOVERY_INVALID/);
  assert.equal(checkedEmailRecovery(sent[1], members, now + 2).id, member.id);
  await assert.rejects(inspectEmailRecovery(store, sent[1], now + 1 + RECOVERY_LIFETIME_MS), /RECOVERY_INVALID/);
  const before = await store.read();
  before.value.members[0].version++;
  await store.replace(before.raw, before.value);
  await assert.rejects(inspectEmailRecovery(store, sent[1], now + 2), /RECOVERY_INVALID/);
});

test('unknown, suspended and ambiguous members receive no link', async () => {
  const { member, store } = await fixture();
  const sent = [];
  const send = async (...args) => sent.push(args);
  assert.deepEqual(await requestEmailRecovery(store, 'missing@example.test', send), { eligible: false, delivered: false });
  for (const change of [{ status: 'suspended' }]) {
    const blocked = new MemoryWorkspaceStore([{ ...member, ...change }]);
    assert.deepEqual(await requestEmailRecovery(blocked, member.email, send), { eligible: false, delivered: false });
  }
  const ambiguous = new MemoryWorkspaceStore([member, { ...member, id: 'd'.repeat(32) }]);
  assert.deepEqual(await requestEmailRecovery(ambiguous, member.email, send), { eligible: false, delivered: false });
  assert.equal(sent.length, 0);
  await assert.rejects(requestEmailRecovery(store, 'invalid-address', send), /INVALID_INPUT/);
});

test('recovery URLs use only the trusted production host or an approved staged host', () => {
  const token = `${'c'.repeat(32)}.${'a'.repeat(43)}`;
  const before = process.env.WORKSPACE_RECOVERY_LINK_ORIGIN;
  try {
    process.env.WORKSPACE_RECOVERY_LINK_ORIGIN = 'https://sweetfun-pszt2csii-sweetfuns-projects.vercel.app';
    assert.equal(emailRecoveryUrl(token), `https://sweetfun-pszt2csii-sweetfuns-projects.vercel.app/recover-calendar-password#${token}`);
    delete process.env.WORKSPACE_RECOVERY_LINK_ORIGIN;
    assert.equal(emailRecoveryUrl(token, 'https://sweetfun-mock-sweetfuns-projects.vercel.app'),
      `https://sweetfun-mock-sweetfuns-projects.vercel.app/recover-calendar-password#${token}`);
    assert.throws(() => emailRecoveryUrl(token, 'https://attacker.test'), /MAIL_NOT_CONFIGURED/);
    process.env.WORKSPACE_RECOVERY_LINK_ORIGIN = 'https://attacker.vercel.app';
    assert.throws(() => emailRecoveryUrl(token), /MAIL_NOT_CONFIGURED/);
    process.env.WORKSPACE_RECOVERY_LINK_ORIGIN = 'https://sweetfun-pszt2csii-sweetfuns-projects.vercel.app.evil.test';
    assert.throws(() => emailRecoveryUrl(token), /MAIL_NOT_CONFIGURED/);
  } finally {
    if (before === undefined) delete process.env.WORKSPACE_RECOVERY_LINK_ORIGIN;
    else process.env.WORKSPACE_RECOVERY_LINK_ORIGIN = before;
  }
});
