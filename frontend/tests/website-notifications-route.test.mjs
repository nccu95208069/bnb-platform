import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/integration/website-booking/v1/notifications/route.ts';
import { digest } from '../src/lib/customer-workspaces/auth.ts';

test('notification route is server-only, binding scoped, bounded, rate limited and PII-safe', async t => {
  process.env.WEBSITE_BOOKING_ENABLED = 'true';
  process.env.CUSTOMER_WORKSPACES_ENABLED = 'true';
  process.env.CUSTOMER_SESSION_SECRET = 'synthetic-notification-route-session-secret';
  process.env.KV_REST_API_URL = 'https://redis.invalid';
  process.env.KV_REST_API_TOKEN = 'synthetic';
  const token = 'synthetic-notification-route-token-1234567890';
  const bindingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  process.env.WEBSITE_BOOKING_WORKERS = JSON.stringify([{ id: 'route-worker', token_sha256: digest(token), binding_ids: [bindingId], actions: ['notifications'] }]);
  const values = new Map(); let count = 1, storeFailure = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (storeFailure) throw Error('provider failure guest@example.invalid secret-token');
    const command = JSON.parse(options.body); let result = null;
    if (command[0] === 'GET') result = values.get(command[1]) ?? null;
    if (command[0] === 'EVAL') {
      if (command[1].includes('INCR')) result = count;
      else {
        const keys = command.slice(3, 3 + command[2]), args = command.slice(3 + command[2]);
        result = keys.every((key, i) => (values.get(key) ?? '') === args[i * 2]) ? 1 : 0;
        if (result) keys.forEach((key, i) => values.set(key, args[i * 2 + 1]));
      }
    }
    return Response.json({ result });
  });
  const body = { schemaVersion: 1, action: 'claim', bindingId, attemptId: randomUUID() };
  const req = (input = body, extra = {}, raw = false) => new NextRequest('https://os.example.invalid/api/integration/website-booking/v1/notifications', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra }, body: raw ? input : JSON.stringify(input),
  });
  for (const headers of [{ authorization: '' }, { authorization: 'Bearer synthetic-guest-token-not-worker-123456' }, { cookie: 'bnb_customer_session=synthetic' }, { origin: 'https://os.example.invalid' }]) {
    const response = await POST(req(body, headers));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert(!response.headers.has('access-control-allow-origin'));
  }
  assert.equal((await POST(req({ ...body, bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }))).status, 403);
  assert.equal((await POST(req({ ...body, action: 'enqueue_expired', bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }))).status, 403);
  assert.equal((await POST(req('{"guest":"guest@example.invalid",', {}, true))).status, 400);
  assert.equal((await POST(req('x'.repeat(5000), {}, true))).status, 400);
  assert.equal((await POST(req(body, { 'content-type': 'text/plain' }))).status, 400);
  assert.equal((await POST(req({ ...body, recipient: 'guest@example.invalid' }))).status, 400);
  assert.equal((await POST(req(body))).status, 404);
  values.set(`bnb:customers:v1:website:binding:${bindingId}`, JSON.stringify({ id: bindingId, workspaceId: 'synthetic-workspace', propertyId: 'synthetic-property', ownerAccountId: 'synthetic-owner' }));
  values.set('bnb:customers:v1:workspace:synthetic-workspace', JSON.stringify({ id: 'synthetic-workspace', properties: [{ id: 'synthetic-property' }], members: [{ accountId: 'synthetic-owner', active: true, role: 'owner', allProperties: true, propertyIds: [] }], bookings: [] }));
  const empty = await POST(req(body));
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).jobs, []);
  assert.deepEqual((await (await POST(req(body))).json()).jobs, []);
  const expired = await POST(req({ ...body, action: 'enqueue_expired' }));
  assert.equal(expired.status, 200);
  assert.deepEqual(await expired.json(), { schemaVersion: 1, queued: 0 });
  count = 2000;
  assert.equal((await POST(req())).status, 429);
  count = 1; storeFailure = true;
  const failed = await POST(req());
  assert.equal(failed.status, 503);
  const text = await failed.text();
  assert(!text.includes('@') && !text.includes('token') && !text.includes('provider failure'));
  storeFailure = false;
  process.env.WEBSITE_BOOKING_ENABLED = 'false';
  assert.equal((await POST(req())).status, 200);
  process.env.CUSTOMER_WORKSPACES_ENABLED = 'false';
  assert.equal((await POST(req())).status, 503);
});
