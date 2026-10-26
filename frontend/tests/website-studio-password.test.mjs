import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { studioAuthOperation } from '../src/lib/website-booking/studio-auth.ts';
import { runStudioPasswordMail } from '../src/lib/website-booking/studio-password.ts';
import { accountKey, sessionFor } from '../src/lib/customer-workspaces/auth.ts';
import { newPasswordlessCredential } from '../src/lib/customer-workspaces/identity.ts';
import { createPasswordCredential } from '../src/lib/owner-password.ts';
import { memoryStore, testEnvironment } from './helpers/website-booking-fixture.mjs';

const password = 'a long and private passphrase 27';
const nextPassword = 'another private passphrase 28';
function fixture() {
  testEnvironment();
  const store = memoryStore(), mail = [], deferred = [];
  const client = { id: 'studio-password-test', allow_new_sites: true, site_ids: [], editor_origin: 'https://studio.example.invalid' };
  const send = async (to, subject, text) => { mail.push({ to, subject, text }); return 'provider:' + mail.length; };
  const call = (input, overrides = {}) => studioAuthOperation(store, overrides.client ?? client,
    { origin: client.editor_origin, ...input }, overrides.send ?? send, overrides.defer);
  const request = (email = 'owner@example.invalid', purpose = 'setup', extra = {}) => ({ action: 'password-request', email, purpose,
    requestKey: randomUUID(), proof: randomBytes(32).toString('base64url'), returnTo: '/studio/batch/?batch=synthetic', ...extra });
  const token = (index = 0) => new URL(mail[index].text.match(/https:\/\/\S+/)[0]).hash.slice(1);
  const reset = (tokenValue = token(), value = password) => call({ action: 'password-reset', token: tokenValue, password: value, confirmation: value });
  return { store, client, mail, deferred, send, call, request, token, reset };
}

test('verified setup creates an account only when its single-use link sets a password; normal login sends no mail', async () => {
  const f = fixture(), input = f.request();
  const response = await f.call(input);
  assert.equal(response.status, 'accepted');
  assert.equal((await f.store.read(accountKey(input.email))).value, null);
  const token = f.token();
  const info = await f.call({ action: 'password-inspect', token });
  assert.deepEqual(Object.keys(info).sort(), ['email', 'expiresAt', 'purpose', 'returnTo']);
  assert.equal(info.purpose, 'setup');
  assert.equal(new URL(f.mail[0].text.match(/https:\/\/\S+/)[0]).origin, f.client.editor_origin);
  const done = await f.reset(token);
  assert.deepEqual(done, { status: 'completed', returnTo: input.returnTo });
  assert.equal('session' in done, false);
  const account = (await f.store.read(accountKey(input.email))).value;
  assert(account.emailVerifiedAt); assert.equal(account.credential.kind, 'password');
  assert.equal(JSON.stringify([...f.store.values]).includes(password), false);
  assert.equal(f.mail.length, 2); assert.match(f.mail[1].subject, /已變更/);
  const result = await f.call({ action: 'password-login', email: ' OWNER@example.invalid ', password });
  assert.equal(result.id, account.id); assert.equal(result.expiresIn, 7 * 86400);
  assert.equal((await f.call({ action: 'session', session: result.session })).id, account.id);
  assert.equal(f.mail.length, 2);
  await assert.rejects(f.call({ action: 'password-login', email: input.email, password: 'wrong' }), /STUDIO_LOGIN_INVALID/);
  await assert.rejects(f.reset(token), /PASSWORD_LINK_INVALID/);
});

test('first password preserves the existing Email identity and workspaces, and revokes every old session', async () => {
  const f = fixture(), input = f.request(), account = { id: randomUUID(), email: input.email,
    credential: newPasswordlessCredential(), workspaces: ['workspace-kept'], emailVerifiedAt: '2026-10-01T00:00:00Z' };
  await f.store.commit([{ key: accountKey(account.email), before: null, after: account }]);
  const oldSessions = [sessionFor(account), sessionFor(account, Date.now() - 60_000)];
  await f.call(input); await f.reset();
  const updated = (await f.store.read(accountKey(account.email))).value;
  assert.equal(updated.id, account.id); assert.deepEqual(updated.workspaces, account.workspaces);
  assert.equal(updated.emailVerifiedAt, account.emailVerifiedAt);
  for (const session of oldSessions) await assert.rejects(f.call({ action: 'session', session }), /UNAUTHORIZED/);
  assert.equal((await f.call({ action: 'password-login', email: input.email, password })).id, account.id);
});

test('reset changes only credentials and rejects the old password, old login, and consumed link', async () => {
  const f = fixture(), input = f.request(); await f.call(input); await f.reset();
  const login = await f.call({ action: 'password-login', email: input.email, password });
  await f.call(f.request(input.email, 'reset')); const token = f.token(2);
  await f.reset(token, nextPassword);
  await assert.rejects(f.call({ action: 'session', session: login.session }), /UNAUTHORIZED/);
  await assert.rejects(f.call({ action: 'password-login', email: input.email, password }), /STUDIO_LOGIN_INVALID/);
  assert.equal((await f.call({ action: 'password-login', email: input.email, password: nextPassword })).id, login.id);
  await assert.rejects(f.call({ action: 'password-inspect', token }), /PASSWORD_LINK_INVALID/);
});

test('known and unknown recovery requests return the same deferred response without awaiting a mail provider', async () => {
  const f = fixture(), email = 'known@example.invalid';
  await f.store.commit([{ key: accountKey(email), before: null, after: { id: randomUUID(), email, credential: newPasswordlessCredential(), workspaces: [] } }]);
  const results = [];
  for (const address of [email, 'unknown@example.invalid']) {
    results.push(await f.call(f.request(address, 'reset'), { defer: work => f.deferred.push(work) }));
  }
  assert.equal(f.mail.length, 0); assert.equal(f.deferred.length, 2);
  assert.deepEqual(Object.keys(results[0]), Object.keys(results[1]));
  assert.equal(results[0].status, results[1].status);
  for (const work of f.deferred) await work();
  assert.equal(f.mail.length, 1); assert.equal(f.mail[0].to, email);
  assert.equal((await f.store.read(accountKey('unknown@example.invalid'))).value, null);
});

test('unknown, passwordless, unverified and wrong-password accounts have the same login failure', async () => {
  const f = fixture();
  for (const [email, credential, verified] of [
    ['passwordless@example.invalid', newPasswordlessCredential(), true],
    ['unverified@example.invalid', await createPasswordCredential(password), false],
    ['wrong@example.invalid', await createPasswordCredential(nextPassword), true],
  ]) await f.store.commit([{ key: accountKey(email), before: null, after: { id: randomUUID(), email, credential, workspaces: [], ...(verified ? { emailVerifiedAt: '2026-10-01T00:00:00Z' } : {}) } }]);
  for (const email of ['missing@example.invalid', 'passwordless@example.invalid', 'unverified@example.invalid', 'wrong@example.invalid'])
    await assert.rejects(f.call({ action: 'password-login', email, password }), /STUDIO_LOGIN_INVALID/);
  assert.equal(f.mail.length, 0);
});

test('request retry sends once, binds purpose/proof/return path, and a new request invalidates the older link', async () => {
  const f = fixture(), input = f.request(); await f.call(input); const old = f.token();
  await f.call(input); assert.equal(f.mail.length, 1);
  for (const change of [{ email: 'other@example.invalid' }, { purpose: 'reset' }, { proof: randomBytes(32).toString('base64url') }, { returnTo: '/build/' }])
    await assert.rejects(f.call({ ...input, ...change }), /IDEMPOTENCY_CONFLICT/);
  await f.call(f.request());
  await assert.rejects(f.reset(old), /PASSWORD_LINK_INVALID/);
  await f.reset(f.token(1));
});

test('scoping rejects wrong client/origin, arbitrary fields and unsafe return destinations', async () => {
  const f = fixture(), input = f.request();
  await assert.rejects(f.call({ ...input, origin: 'https://attacker.example.invalid' }), /FORBIDDEN/);
  await assert.rejects(f.call(input, { client: { ...f.client, allow_new_sites: false } }), /FORBIDDEN/);
  await assert.rejects(f.call({ ...input, mode: 'register' }), /INVALID_INPUT/);
  for (const returnTo of ['//attacker.invalid', 'https://attacker.invalid', '/studio/../../auth/login', '/build/../../../evil', '/studio/\\attacker.invalid'])
    await assert.rejects(f.call({ ...input, returnTo }), /INVALID_INPUT/);
  await assert.rejects(f.call({ ...input, proof: 'invalid' }), /LOGIN_BROWSER_REQUIRED/);
  await f.call(input);
  await assert.rejects(f.call({ action: 'password-inspect', token: f.token() }, { client: { ...f.client, id: 'other-studio' } }), /PASSWORD_LINK_INVALID/);
  await assert.rejects(f.call({ action: 'password-reset', token: f.token(), password, confirmation: password, email: 'attacker@example.invalid' }), /INVALID_INPUT/);
});

test('expiry, tampering, credential changes and short or mismatched passwords cannot consume a link', async () => {
  const f = fixture(); await f.call(f.request()); const token = f.token();
  await assert.rejects(f.call({ action: 'password-inspect', token: token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a') }), /PASSWORD_LINK_INVALID/);
  await assert.rejects(f.reset(token, 'short'), /STUDIO_PASSWORD_INVALID/);
  await assert.rejects(f.call({ action: 'password-reset', token, password, confirmation: nextPassword }), /STUDIO_PASSWORD_INVALID/);
  const key = 'studio-password:link:' + token.split('.')[1], saved = await f.store.read(key);
  await f.store.commit([{ key, before: saved.raw, after: { ...saved.value, expiresAt: Date.now() - 1 } }]);
  await assert.rejects(f.reset(token), /PASSWORD_LINK_INVALID/);
  assert.equal((await f.store.read(accountKey('owner@example.invalid'))).value, null);
});

test('two simultaneous resets permit one atomic credential change and one notification', async () => {
  const f = fixture(); await f.call(f.request()); const token = f.token();
  const results = await Promise.allSettled([f.reset(token, password), f.reset(token, nextPassword)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.mail.filter(message => /已變更/.test(message.subject)).length, 1);
  const winner = results[0].status === 'fulfilled' ? password : nextPassword;
  assert((await f.call({ action: 'password-login', email: 'owner@example.invalid', password: winner })).session);
});

test('the scheduler recovers a request whose post-response task did not run, without duplicate delivery', async () => {
  const f = fixture(); await f.call(f.request(), { defer: work => f.deferred.push(work) });
  assert.equal(f.mail.length, 0);
  assert.equal((await runStudioPasswordMail(f.store, f.send)).processed, 1);
  assert.equal(f.mail.length, 1);
  await f.deferred[0](); await runStudioPasswordMail(f.store, f.send);
  assert.equal(f.mail.length, 1);
});

test('provider failure does not reveal account existence, retry a possibly sent message, or create an account', async () => {
  const f = fixture(), input = f.request(); let calls = 0;
  const send = async () => { calls++; throw Error('provider unavailable'); };
  assert.equal((await f.call(input, { send })).status, 'accepted');
  assert.equal((await f.call(input, { send })).status, 'accepted');
  assert.equal(calls, 1); assert.equal((await f.store.read(accountKey(input.email))).value, null);
  assert.equal(JSON.stringify([...f.store.values]).includes('provider unavailable'), false);
});

test('rate limits are applied to known and unknown email requests and login attempts', async () => {
  const f = fixture(), seen = [];
  f.store.limit = async (key, max) => { seen.push({ key, max }); if (key.startsWith('studio-password:email:')) throw Error('RATE_LIMITED'); };
  await assert.rejects(f.call(f.request()), /RATE_LIMITED/); assert.equal(f.mail.length, 0);
  assert(seen.some(row => row.max === 5));
  f.store.limit = async (key, max) => { seen.push({ key, max }); if (key.startsWith('identity:')) throw Error('RATE_LIMITED'); };
  await assert.rejects(f.call({ action: 'password-login', email: 'unknown@example.invalid', password }), /RATE_LIMITED/);
  assert(seen.some(row => row.max === 15));
});
