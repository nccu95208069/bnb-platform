import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET } from '../src/app/api/cron/website-notifications/route.ts';
import { sealMailPassword } from '../src/lib/workspace-auth/mail.ts';
import { ADMIN_EMAIL } from '../src/lib/workspace-auth/types.ts';
import { emailFixture, fixtureNow } from './helpers/website-email-fixture.mjs';

test('cron is disabled by default, requires its own credential, and delivers existing emails while new website sales are off', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: fixtureNow });
  process.env.CUSTOMER_WORKSPACES_ENABLED = 'true';
  process.env.CUSTOMER_SESSION_SECRET = 'synthetic-email-cron-customer-session-secret';
  process.env.WEBSITE_BOOKING_ENABLED = 'false';
  process.env.CRON_SECRET = 'synthetic-email-cron-secret';
  process.env.CUSTOMER_WORKSPACE_NAMESPACE = 'synthetic-email-cron-customers';
  process.env.WORKSPACE_AUTH_NAMESPACE = 'synthetic-email-cron-mail';
  process.env.KV_REST_API_URL = 'https://email-redis.invalid';
  process.env.KV_REST_API_TOKEN = 'synthetic-redis-token';
  process.env.CALENDAR_OWNER_SESSION_SECRET = 'a'.repeat(64);
  delete process.env.WEBSITE_BOOKING_EMAIL_DELIVERY_ENABLED;
  process.env.WEBSITE_BOOKING_EMAIL_BINDINGS = '[]';
  process.env.WEBSITE_BOOKING_EMAIL_SITE_SCOPES = '[]';
  const values = new Map(); let storageCalls = 0, providerCalls = 0, transportFailure = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://email-redis.invalid') {
      storageCalls++; const command = JSON.parse(options.body); let result = null;
      if (command[0] === 'GET') result = values.get(command[1]) ?? null;
      if (command[0] === 'EVAL') {
        if (command[1].includes('INCR')) result = 1;
        else {
          const keys = command.slice(3, 3 + command[2]), args = command.slice(3 + command[2]);
          const width = command[1].includes('i*3') ? 3 : 2;
          result = keys.every((key, i) => (values.get(key) ?? '') === args[i * width]) ? 1 : 0;
          if (result) keys.forEach((key, i) => values.set(key, args[i * width + 1]));
        }
      }
      return Response.json({ result });
    }
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-gmail-access', scope: 'https://www.googleapis.com/auth/gmail.send' });
    if (url.endsWith('/profile')) return Response.json({ emailAddress: ADMIN_EMAIL });
    if (url.endsWith('/messages/send')) {
      providerCalls++;
      if (transportFailure) throw Error('SMTP response included guest-secret@example.invalid token=private-secret');
      return Response.json({ id: `gmail:synthetic-message-${providerCalls}` });
    }
    throw Error('Unexpected external request');
  });
  const request = (extra = {}) => new NextRequest('https://os.example.invalid/api/cron/website-notifications', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, ...extra } });
  for (const headers of [{ authorization: '' }, { authorization: 'Bearer guest-or-worker-token' }, { origin: 'https://os.example.invalid' }, { cookie: 'bnb_customer_session=synthetic' }]) {
    assert.equal((await GET(request(headers))).status, 401);
  }
  const disabled = await GET(request());
  assert.deepEqual(await disabled.json(), { schemaVersion: 1, enabled: false }); assert.equal(storageCalls, 0); assert.equal(providerCalls, 0);
  process.env.WEBSITE_BOOKING_EMAIL_DELIVERY_ENABLED = 'true';
  process.env.WEBSITE_BOOKING_EMAIL_SITE_SCOPES = '[{"client_id":"*","site_id":"synthetic"}]';
  assert.equal((await GET(request())).status, 503);
  assert.equal(storageCalls, 0);
  const f = await emailFixture();
  for (const [key, value] of f.store.values) values.set(`${process.env.CUSTOMER_WORKSPACE_NAMESPACE}:${key}`, value);
  values.set(`${process.env.WORKSPACE_AUTH_NAMESPACE}:mail`, JSON.stringify({ method: 'gmail_oauth', secret: sealMailPassword(JSON.stringify({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' })) }));
  process.env.WEBSITE_BOOKING_EMAIL_SITE_SCOPES = JSON.stringify([{ client_id: f.binding.clientId, site_id: f.binding.siteId }]);
  const delivered = await GET(request());
  assert.equal(delivered.status, 200); assert.equal(delivered.headers.get('cache-control'), 'private, no-store');
  const body = await delivered.json(); assert.equal(body.enabled, true); assert.equal(body.sent, 2); assert.equal(providerCalls, 2);
  assert(!JSON.stringify(body).includes('@'));
  assert.equal((await GET(request())).status, 200); assert.equal(providerCalls, 2);
  const other = await emailFixture({ bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', siteId: 'synthetic-failure-site' });
  for (const [key, value] of other.store.values) values.set(`${process.env.CUSTOMER_WORKSPACE_NAMESPACE}:${key}`, value);
  process.env.WEBSITE_BOOKING_EMAIL_SITE_SCOPES = JSON.stringify([{ client_id: other.binding.clientId, site_id: other.binding.siteId }]);
  transportFailure = true;
  const uncertain = await GET(request()), uncertainBody = await uncertain.json();
  assert.equal(uncertainBody.sent, 0); assert.equal(uncertainBody.unknown, 2);
  assert(!JSON.stringify(uncertainBody).includes('guest-secret') && !JSON.stringify(uncertainBody).includes('private-secret'));
  const before = providerCalls; await GET(request()); assert.equal(providerCalls, before);
  process.env.CUSTOMER_WORKSPACES_ENABLED = 'false';
  assert.deepEqual(await (await GET(request())).json(), { schemaVersion: 1, enabled: false });
});

test('expiry scheduler queues owner LINE reminders with SMTP disabled and never releases occupancy or duplicates the reminder', async t => {
  const later=new Date(fixtureNow.getTime()+86400001);t.mock.timers.enable({apis:['Date'],now:later});
  const f=await emailFixture();
  const {RedisCustomerStore}=await import('../src/lib/customer-workspaces/store.ts');
  for(const method of ['read','commit','limit'])t.mock.method(RedisCustomerStore.prototype,method,f.store[method].bind(f.store));
  let sends=0;t.mock.method(globalThis,'fetch',async()=>{sends++;throw Error('external request forbidden');});
  process.env.CUSTOMER_WORKSPACES_ENABLED='true';process.env.CUSTOMER_SESSION_SECRET='synthetic-expiry-cron-session-secret';process.env.CRON_SECRET='synthetic-expiry-cron-secret';
  process.env.WEBSITE_BOOKING_ENABLED='false';process.env.WEBSITE_BOOKING_EMAIL_DELIVERY_ENABLED='false';process.env.WEBSITE_BOOKING_EXPIRY_REMINDERS_ENABLED='true';
  process.env.WEBSITE_BOOKING_EMAIL_BINDINGS='[]';process.env.WEBSITE_BOOKING_EMAIL_SITE_SCOPES=JSON.stringify([{client_id:f.binding.clientId,site_id:f.binding.siteId}]);
  t.after(()=>delete process.env.WEBSITE_BOOKING_EXPIRY_REMINDERS_ENABLED);
  const request=()=>new NextRequest('https://os.example.invalid/api/cron/website-notifications',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}});
  const response=await GET(request());assert.equal(response.status,200);const result=await response.json();assert.equal(result.emailEnabled,false);assert.equal(result.expiry.queued,1);assert.equal(result.sent,0);assert.equal(sends,0);
  const jobs=[...f.store.values].filter(([key])=>key.startsWith('website:notification:')).map(([,value])=>JSON.parse(value));
  assert.equal(jobs.filter(j=>j.event==='hold_expired'&&j.channel==='ownerLine'&&j.state==='queued').length,1);
  assert.equal((await f.store.read('workspace:'+f.workspace.id)).value.bookings[0].status,'held');
  assert.equal((await(await GET(request())).json()).expiry.queued,0);assert.equal(sends,0);
});
