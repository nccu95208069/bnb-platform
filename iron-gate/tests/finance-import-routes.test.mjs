import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/http.ts';

const propertyId = '11111111-1111-4111-8111-111111111111';
const principal = { origin: 'finance', propertyIds: [propertyId],
  actions: ['finance:import'], subjectId: 'synthetic-importer' };
const baseUrl = `http://local/v1/properties/${propertyId}/finance/imports`;

test('each non-money import route forwards the original body and key as a shadow import', async () => {
  const calls = [];
  const finance = {};
  const routes = [
    ['status-commands', 'statusCommand'],
    ['recurring-rules', 'recurringRule'],
    ['payout-rules', 'payoutRule'],
    ['accounts', 'accountCommand'],
    ['categories', 'categoryCommand'],
  ];
  for (const [, method] of routes) {
    finance[method] = async (...args) => {
      calls.push({ method, args });
      return { receipt_status: 'accepted', request_key: args[3] };
    };
  }
  const handle = createHandler({}, async () => principal, undefined, finance);
  for (const [path, method] of routes) {
    const key = `import-${path}`;
    const body = { request_key: key, origin_request_hash: 'b'.repeat(64),
      origin_source_version:'redis:2026:42',
      source_actor_ref: `os_actor:${'a'.repeat(64)}`,
      source_recorded_at: '2026-10-28T00:00:00Z', marker: path };
    const response = await handle(new Request(`${baseUrl}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify(body),
    }));
    assert.equal(response.status, 201, method);
    assert.deepEqual(await response.json(), { receipt_status: 'accepted', request_key: key });
    assert.deepEqual(calls.at(-1), {
      method, args: [principal, propertyId, body, key, true],
    });
  }
  assert.equal(calls.length, routes.length);
});

test('catalog route forwards parsed cursor, bounded limit and watermark', async () => {
  const calls = [];
  const finance = { importCatalog: async (...args) => {
    calls.push(args);
    return { entries: [], next_cursor: null, as_of_change_seq: args[2].as_of_change_seq };
  } };
  const handle = createHandler({}, async () => principal, undefined, finance);
  const cursor = '22222222-2222-4222-8222-222222222222';
  const response = await handle(new Request(
    `${baseUrl}/catalog?cursor=${cursor}&limit=100&as_of_change_seq=42`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(),
    { entries: [], next_cursor: null, as_of_change_seq: 42 });
  assert.deepEqual(calls[0], [principal, propertyId,
    { cursor, limit: 100, as_of_change_seq: 42 }]);

  const defaultResponse = await handle(new Request(`${baseUrl}/catalog`));
  assert.equal(defaultResponse.status, 200);
  assert.deepEqual(calls[1], [principal, propertyId,
    { cursor: null, limit: 50, as_of_change_seq: null }]);
});
