import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { NextRequest } from 'next/server';
import * as Recovery from '../src/app/api/calendar-password-recovery/handler.ts';
import { createPasswordCredential, credentialMatches } from '../src/lib/owner-password.ts';
import { sealMailPassword } from '../src/lib/workspace-auth/mail.ts';

test('legacy recovery route sends only to an eligible member and consumes the link once', async t => {
  process.env.CALENDAR_OWNER_SESSION_SECRET = 'b'.repeat(64);
  process.env.CALENDAR_OWNER_CODE_HASH = createHash('sha256').update('a'.repeat(32)).digest('hex');
  process.env.KV_REST_API_URL = 'https://redis.invalid';
  process.env.KV_REST_API_TOKEN = 'synthetic';
  const password = 'Synthetic old member phrase!';
  const member = {
    id: 'c'.repeat(32), displayName: 'Synthetic member', email: 'member@example.test', phone: null,
    role: 'god', status: 'active', allProperties: true, propertyIds: ['sweetfun', 'offland'],
    invitedAt: '', acceptedAt: null, lastActiveAt: null,
    credential: await createPasswordCredential(password), invitation: null, version: 1,
  };
  const memberKey = 'sweetfun-os:workspace-auth:v1:members';
  const data = new Map([
    [memberKey, JSON.stringify({ version: 1, members: [member] })],
    ['sweetfun-os:workspace-auth:v1:mail', JSON.stringify({ secret: sealMailPassword('abcdefghijklmnop') })],
  ]);
  const mails = [];
  const scheduled = [];
  const post = request => Recovery.handleRecovery(request, task => { scheduled.push(task); });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const command = JSON.parse(options.body);
    let result = null;
    if (command[0] === 'GET') result = data.get(command[1]) ?? null;
    if (command[0] === 'EVAL') {
      if (command[1].includes('local old')) {
        result = (data.get(command[3]) ?? '') === command[4] ? 1 : 0;
        if (result) data.set(command[3], command[5]);
      } else result = 1;
    }
    return Response.json({ result });
  });
  t.mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async mail => { mails.push(mail); return { accepted: [mail.to], messageId: 'synthetic-mail-id' }; },
    close: () => {},
  }));
  const request = (action, body, origin = 'https://sweetfun-test-sweetfuns-projects.vercel.app') => new NextRequest('https://sweetfun-test-sweetfuns-projects.vercel.app/api/calendar-password-recovery', {
    method: 'POST',
    headers: { host: 'sweetfun-test-sweetfuns-projects.vercel.app', origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });

  assert.equal((await post(request('request', { email: member.email }, 'https://evil.test'))).status, 403);
  const absent = await post(request('request', { email: 'missing@example.test' }));
  assert.equal(absent.status, 200);
  assert.equal(mails.length, 0);
  const issued = await post(request('request', { email: member.email }));
  assert.equal(issued.status, 200);
  assert.deepEqual(await issued.json(), await absent.json(), 'responses do not reveal account existence');
  assert.equal(mails.length, 0, 'mail is sent after the generic response');
  assert.equal(scheduled.length, 1);
  await scheduled[0]();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, member.email);
  const token = mails[0].text.match(/\/recover-calendar-password#([^\s]+)/)[1];
  assert.match(mails[0].text, /https:\/\/sweetfun-test-sweetfuns-projects\.vercel\.app\/recover-calendar-password#/);
  assert.equal(data.get(memberKey).includes(token.split('.')[1]), false);
  assert.equal((await post(request('inspect', { token }))).status, 200);
  const nextPassword = 'Synthetic new member phrase!';
  assert.equal((await post(request('consume', { token, password: nextPassword, confirmPassword: nextPassword }))).status, 200);
  assert.equal(mails.length, 2, 'successful reset sends a notification without the password');
  assert.equal(mails[1].to, member.email);
  assert.equal(mails[1].text.includes(nextPassword), false);
  const updated = JSON.parse(data.get(memberKey)).members[0];
  assert.equal(await credentialMatches(password, updated.credential), false);
  assert.equal(await credentialMatches(nextPassword, updated.credential), true);
  assert.equal((await post(request('consume', { token, password: nextPassword, confirmPassword: nextPassword }))).status, 400);
});
