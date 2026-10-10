import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { localRedis } from './helpers/redis-command.mjs';
import { fixture } from './helpers/calendar-fixture.mjs';
import { RedisCustomerStore } from '../src/lib/customer-workspaces/store.ts';
import { POST } from '../src/app/api/integration/arrival-reminders/v1/route.ts';

// Explicit opt-in: both repositories and a disposable localhost Redis are required.
const integration = process.env.CALENDAR_TEST_REDIS_PORT && process.env.ARRIVAL_TEST_LINE_REPO && process.env.ARRIVAL_TEST_PYTHON ? test : test.skip;
integration('Python sender -> HTTP Next route -> real Redis -> fake LINE: lost ACK recovers next day without re-send', async t => {
  const token = 'synthetic-cross-service-arrival-token-2026';
  const bindingId = randomUUID(), { workspace } = fixture();
  workspace.properties[0].setup = undefined;
  workspace.bookings = [{ id: randomUUID(), propertyId: 'property', guestName: 'Synthetic guest', checkIn: '2026-10-10', checkOut: '2026-10-12', roomIds: ['101'], notes: 'Synthetic cot request', status: 'confirmed' }];
  process.env.CUSTOMER_WORKSPACE_NAMESPACE = 'arrival-cross-test:' + randomUUID();
  process.env.UPSTASH_REDIS_REST_URL = 'https://arrival-redis.test.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  process.env.ARRIVAL_REMINDERS_ENABLED = 'true';
  process.env.ARRIVAL_REMINDER_WORKERS = JSON.stringify([{ id: 'synthetic', token_sha256: createHash('sha256').update(token).digest('hex'), targets: [{ id: 'synthetic-inn', kind: 'workspace', bindingId }] }]);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-10T01:00:00Z') });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, process.env.UPSTASH_REDIS_REST_URL);
    return Response.json({ result: await localRedis(JSON.parse(options.body)) });
  });
  const store = new RedisCustomerStore();
  await store.commit([
    { key: `slug:${workspace.slug}`, before: null, after: workspace.id },
    { key: `workspace:${workspace.id}`, before: null, after: workspace },
    { key: `website:binding:${bindingId}`, before: null, after: { id: bindingId, enabled: true, workspaceId: workspace.id, slug: workspace.slug, propertyId: 'property', ownerAccountId: 'calendar-owner', ownerLine: { recipientId: 'U' + 'a'.repeat(32), verifiedAt: '2026-10-01T00:00:00Z', verifiedBy: 'synthetic-pairing' } } },
  ]);
  let pushes = 0, lostAck = false;
  const operations = [];
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const part of req) body += part;
      if (req.url === '/line') {
        const payload = JSON.parse(body); pushes++;
        assert.equal(payload.to, 'U' + 'a'.repeat(32));
        assert.match(payload.messages[0].text, /Synthetic cot request/);
        assert.equal(payload.messages[0].quickReply, undefined);
        res.writeHead(200, { 'X-Line-Request-Id': 'synthetic-provider-proof' }); res.end('{}'); return;
      }
      const input = JSON.parse(body); operations.push(input.action);
      const response = await POST(new NextRequest('https://app.test/api/integration/arrival-reminders/v1', { method: 'POST', headers: req.headers, body }));
      const output = await response.text();
      if (input.action === 'ack' && !lostAck) {
        assert.equal(response.status, 200); lostAck = true;
        t.mock.timers.setTime(new Date('2026-10-11T04:00:00Z').getTime());
        res.destroy(); return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(output);
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const code = `
import json, os, sys, requests
sys.path.insert(0, os.environ['ARRIVAL_TEST_LINE_REPO'])
from src.arrival_reminders.client import ArrivalClient
from src.arrival_reminders.worker import ArrivalWorker
from src.website_booking.client import LinePush
from tests.test_website_line_notifications import Journal
port = sys.argv[1]
def os_post(url, **kwargs):
    assert url == 'https://app.test/api/integration/arrival-reminders/v1'
    return requests.post('http://127.0.0.1:'+port+'/os', **kwargs)
def line_post(url, **kwargs):
    assert url == 'https://api.line.me/v2/bot/message/push'
    return requests.post('http://127.0.0.1:'+port+'/line', **kwargs)
journal = Journal()
clock = [1791594000]
def worker():
    return ArrivalWorker(ArrivalClient('https://app.test', '${token}', post=os_post), journal, LinePush('synthetic-line-token-'*3, post=line_post), lambda: clock[0])
first = worker().poll()
assert first['needsReview'] == 1, first
clock[0] = 1791691200
second = worker().poll()
assert second['sent'] == 1, second
third = worker().poll()
assert third['outsideWindow'] == 1, third
saved = json.dumps(journal.rows)
assert 'Synthetic cot request' not in saved and ('U'+'a'*32) not in saved
print(json.dumps({'first': first, 'second': second, 'third': third}))
`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.env.ARRIVAL_TEST_PYTHON, ['-c', code, String(server.address().port)], { env: process.env });
    let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    child.on('error', reject); child.on('exit', status => status === 0 ? resolve(JSON.parse(out)) : reject(Error(err)));
  });
  assert.equal(result.second.sent, 1); assert.equal(pushes, 1);
  assert.deepEqual(operations, ['targets', 'claim', 'claim', 'ack', 'targets', 'ack', 'status', 'targets']);
});
