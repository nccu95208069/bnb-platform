import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HEALTH_SCRIPT, recordCalendarHealth } from '../src/lib/booking-sources/calendar-diagnostics.ts';
import { localRedis } from './helpers/redis-command.mjs';

test('real Redis health transitions retain errors/recovery, alert on third failure, ignore old completions, and bound history', async t => {
  const prefix = `calendar-synthetic-test:${randomUUID()}`, stateKey = `${prefix}:state`, historyKey = `${prefix}:history`;
  t.after(async () => { await localRedis(['DEL', stateKey, historyKey]); });
  const run = async (at, status = 'error') => JSON.parse(await localRedis(['EVAL', HEALTH_SCRIPT, 2, stateKey, historyKey, JSON.stringify([{ property_id: 'synthetic', phase: 'guest_details', started_at: at, status, code: status === 'error' ? 'MONITOR_GOOGLE_READ' : null, http_status: status === 'error' ? 429 : null, request_id: `synthetic-${at}` }])]));
  assert.deepEqual(await run(10), []); assert.deepEqual(await run(20), []); assert.deepEqual(await run(30), ['synthetic:guest_details']);
  assert.deepEqual(await run(40), []);
  await run(50, 'ok'); await run(45);
  let health = JSON.parse(await localRedis(['HGET', stateKey, 'synthetic:guest_details']));
  assert.equal(health.started_at, 50); assert.equal(health.consecutive_failures, 0); assert.equal(health.recovered, true);
  const event = JSON.parse((await localRedis(['LRANGE', historyKey, 0, 0]))[0]); assert.equal(event.recovered, true);
  assert.ok(await localRedis(['TTL', stateKey]) > 0);
  for (let i = 60; i < 270; i++) await run(i);
  assert.equal(await localRedis(['LLEN', historyKey]), 200);
  health = JSON.parse(await localRedis(['HGET', stateKey, 'synthetic:guest_details'])); assert.equal(health.started_at, 269);
});
test('diagnostics failure never rejects the calendar or logs private provider errors', async t => {
  process.env.KV_REST_API_URL = 'https://fixture.invalid'; process.env.KV_REST_API_TOKEN = 'synthetic';
  const warnings = []; t.mock.method(console, 'warn', message => warnings.push(message));
  t.mock.method(globalThis, 'fetch', async () => { throw Error('PRIVATE PROVIDER BODY'); });
  await recordCalendarHealth([{ property_id: 'synthetic', phase: 'snapshot', status: 'ok', code: null, http_status: null, duration_ms: 1 }], 'request-synthetic', 1);
  assert.equal(warnings.length, 1); assert.equal(warnings[0].includes('PRIVATE'), false);
});
