import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { GET, POST, DELETE } from '../src/app/api/calendar-session/route.ts';
import { proxy } from '../src/proxy.ts';
import { PREVIEW_OWNER_COOKIE, validPreviewOwnerSession } from '../src/lib/iron-gate-preview-owner.ts';

test('fixed-snapshot preview permits only the owner code and read-only routes', async t => {
  const before = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; Object.assign(process.env, before); });
  const code = 'a'.repeat(32);
  Object.assign(process.env, { VERCEL_ENV: 'preview', IRON_GATE_PREVIEW_OWNER_ONLY: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_PREVIEW_ENABLED: 'true',
    IRON_GATE_PREVIEW_OWNER_CODE_HASH: createHash('sha256').update(code).digest('hex'),
    IRON_GATE_PREVIEW_OWNER_SESSION_SECRET: 'b'.repeat(64) });
  const url = 'https://private-preview.example/api/calendar-session';
  const request = (method, body) => new NextRequest(url, { method, headers: {
    origin: 'https://private-preview.example', host: 'private-preview.example',
    'content-type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }) });
  const anonymous = await GET(request('GET'));
  assert.equal(anonymous.status, 200);
  assert.equal((await anonymous.json()).authenticated, false);
  const wrong = await POST(request('POST', { email: 'other@example.com', code }));
  assert.equal(wrong.status, 401);
  const login = await POST(request('POST', { email: 'sweetfuntw@gmail.com', code }));
  assert.equal(login.status, 200);
  const cookie = login.cookies.get(PREVIEW_OWNER_COOKIE)?.value;
  assert.ok(cookie);
  assert.equal(validPreviewOwnerSession(cookie), true);
  const loggedIn = await GET(new NextRequest(url, { headers: { cookie: `${PREVIEW_OWNER_COOKIE}=${cookie}` } }));
  assert.equal((await loggedIn.json()).membership.role, 'viewer_no_price');
  assert.equal((await DELETE(request('DELETE'))).cookies.get(PREVIEW_OWNER_COOKIE)?.value, '');
  assert.equal(proxy(new NextRequest('https://private-preview.example/api/v1/bookings/calendar')).status, 200);
  assert.equal(proxy(new NextRequest('https://private-preview.example/api/v1/bookings', { method: 'POST' })).status, 404);
  assert.equal(proxy(new NextRequest('https://private-preview.example/revenue')).status, 404);
  process.env.IRON_GATE_PREVIEW_OWNER_SESSION_SECRET = 'c'.repeat(64);
  assert.equal(validPreviewOwnerSession(cookie), false);
});
