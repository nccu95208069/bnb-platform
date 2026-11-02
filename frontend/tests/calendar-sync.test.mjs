import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { createCalendarManifest, createCalendarDelta, applyCalendarDelta, validCalendarManifest } from '../src/lib/calendar-sync.ts';
import { POST } from '../src/app/api/v1/bookings/calendar/sync/route.ts';

const row = (id, changes = {}) => ({ id, order_id: id, property_id: 'sweetfun', room_id: 'room-101',
  guest_name: 'Synthetic Guest', check_in: '2026-11-04', check_out: '2026-11-06',
  payment_status: 'unknown', payments: [], notes: null, ...changes });
const data = (bookings = [row('one'), row('two')], changes = {}) => ({ period_start: '2026-11-01',
  period_end: '2026-12-01', properties: [{ id: 'sweetfun', name: 'Synthetic Property' }],
  rooms: [{ id: 'room-101', property_id: 'sweetfun' }], bookings,
  source: { private_snapshot_version: '7', observed_at: '2026-10-30T01:00:00Z' }, ...changes });

test('unchanged rows are omitted while fresh metadata is always delivered', async () => {
  const base = data(), fresh = data(undefined, { source: { ...base.source, observed_at: '2026-10-30T02:00:00Z' } });
  const manifest = await createCalendarManifest(base);
  assert.doesNotMatch(JSON.stringify(manifest), /Synthetic Guest|payment_status|notes/);
  const patch = await createCalendarDelta(manifest, fresh);
  assert.deepEqual(patch.upserts, []);
  assert.deepEqual(patch.removed, []);
  assert.deepEqual(await applyCalendarDelta(base, manifest, patch), fresh);
});

test('name, notes and receipts change without inventory version updates', async () => {
  const base = data();
  const fresh = data([row('one', { guest_name: 'Updated Synthetic', notes: 'Arrives late',
    payment_status: 'deposit', payments: [{ id: 'receipt', amount: 50, received_at: '2026-10-30' }] }), row('two')]);
  const manifest = await createCalendarManifest(base), patch = await createCalendarDelta(manifest, fresh);
  assert.deepEqual(patch.upserts.map(b => b.id), ['one']);
  assert.deepEqual(await applyCalendarDelta(base, manifest, patch), fresh);
});

test('rescheduled or cancelled rows leaving the range disappear and new rows join in authoritative order', async () => {
  const base = data(), fresh = data([row('new', { property_id: 'offland' }), row('two')]);
  const manifest = await createCalendarManifest(base), patch = await createCalendarDelta(manifest, fresh);
  assert.deepEqual(patch.removed, ['one']);
  assert.deepEqual(patch.upserts.map(b => b.id), ['new']);
  assert.deepEqual(await applyCalendarDelta(base, manifest, patch), fresh);
});

test('updated authorization removes out-of-scope rows and all formerly visible price fields', async () => {
  const base = data([row('one', { room_rate: 1200 }), row('two', { property_id: 'offland', room_rate: 9000 })]);
  const fresh = data([row('one', { room_rate: 0, price_hidden: true })], { price_hidden: true });
  const manifest = await createCalendarManifest(base), patch = await createCalendarDelta(manifest, fresh);
  assert.deepEqual(await applyCalendarDelta(base, manifest, patch), fresh);
  assert.doesNotMatch(JSON.stringify(await applyCalendarDelta(base, manifest, patch)), /1200|9000|offland/);
});

test('corrupt patches, changed in-flight bases and wrong ranges fail without accepting partial data', async () => {
  const base = data(), manifest = await createCalendarManifest(base);
  const patch = await createCalendarDelta(manifest, data([row('one')]));
  await assert.rejects(applyCalendarDelta(base, manifest, { ...patch, removed: [] }), /RESPONSE_INVALID/);
  await assert.rejects(applyCalendarDelta(base, manifest, { ...patch, digest: 'a'.repeat(64) }), /RESPONSE_INVALID/);
  await assert.rejects(applyCalendarDelta(data([row('changed')]), manifest, patch), /BASE_CHANGED/);
  await assert.rejects(createCalendarDelta(manifest, data(undefined, { period_end: '2027-01-01' })), /RANGE_MISMATCH/);
  await assert.rejects(createCalendarDelta({ ...manifest, digest: 'b'.repeat(64) }, base), /MANIFEST_INVALID/);
  assert.equal(validCalendarManifest({ ...manifest, rows: [manifest.rows[0], manifest.rows[0]] }), false);
  assert.equal(validCalendarManifest({ ...manifest, end: '2027-12-01' }), false);
});

test('sync transport still requires server authentication and bounds untrusted input', async t => {
  const before = process.env.CALENDAR_SOURCE;
  process.env.CALENDAR_SOURCE = 'sheet_snapshot';
  t.after(() => { if (before === undefined) delete process.env.CALENDAR_SOURCE; else process.env.CALENDAR_SOURCE = before; });
  const manifest = await createCalendarManifest(data());
  const request = body => new NextRequest('https://operations.test/api/v1/bookings/calendar/sync', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const denied = await POST(request({ manifest, properties: ['sweetfun'] }));
  assert.equal(denied.status, 401);
  assert.doesNotMatch(await denied.text(), /Synthetic Guest|bookings|upserts/);
  assert.equal((await POST(request({ manifest, properties: ['unknown'] }))).status, 400);
  assert.equal((await POST(new NextRequest('https://operations.test/api/v1/bookings/calendar/sync', {
    method: 'POST', body: '{}', headers: { 'Content-Length': '750001' } }))).status, 413);
});
