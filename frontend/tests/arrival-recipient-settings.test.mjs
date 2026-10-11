import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers/calendar-fixture.mjs';
import { activeTenantRecipient, consumeRecipientPairing, prepareRecipientPairing, saveRecipientSetting, settingView, targetIndex, tenantTargetId } from '../src/lib/arrival-reminders/recipient-settings.ts';
import { workerOperation } from '../src/lib/arrival-reminders/worker.ts';

const now = new Date('2026-10-10T01:00:00Z');
const recipient = 'U' + 'b'.repeat(32);
function setup() {
  const f = fixture();
  f.workspace.members.push({ accountId: 'steward', email: 'steward@example.test', role: 'housekeeper', active: true, allProperties: false, propertyIds: ['property'] });
  f.workspace.properties[0].setup = undefined;
  f.workspace.bookings = [{ id: randomUUID(), propertyId: 'property', status: 'confirmed', guestName: 'Synthetic Guest', checkIn: '2026-10-10', checkOut: '2026-10-11', roomIds: ['101'], notes: '需要嬰兒床' }];
  void f.put(f.workspace);
  return f;
}

test('owner chooses a steward; only that logged-in steward can prepare a short-lived LINE command', async () => {
  const f = setup();
  await assert.rejects(() => saveRecipientSetting(f.store, 'steward', f.workspace.slug, 'property', { recipientAccountId: 'steward', enabled: true, includeUnconfirmed: false }, now), /FORBIDDEN/);
  const view = await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountId: 'steward', enabled: true, includeUnconfirmed: false }, now);
  assert.equal(view.selectedEmail, 'steward@example.test');
  assert.equal(view.lineConnected, false);
  assert.deepEqual((await targetIndex(f.store)).map(row => row.id), [tenantTargetId(f.workspace.id, 'property')]);
  await assert.rejects(() => prepareRecipientPairing(f.store, 'calendar-owner', f.workspace.slug, 'property', now), /FORBIDDEN/);
  const pair = await prepareRecipientPairing(f.store, 'steward', f.workspace.slug, 'property', now);
  assert.match(pair.command, /^接收入住 [a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal((await settingView(f.store, 'steward', f.workspace.slug, 'property')).canPair, true);
  assert.equal(JSON.stringify(f.store.data).includes(pair.command), false);
  await assert.rejects(() => consumeRecipientPairing(f.store, 'line-worker', pair.command.split(' ')[1], recipient, new Date(now.getTime() + 600001)), /PAIRING_EXPIRED/);
});

test('verified private LINE sender becomes the sole recipient; revoking membership or toggling off stops new dispatch', async () => {
  const f = setup();
  await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountId: 'steward', enabled: true, includeUnconfirmed: false }, now);
  const pair = await prepareRecipientPairing(f.store, 'steward', f.workspace.slug, 'property', now);
  const token = pair.command.split(' ')[1];
  await assert.rejects(() => consumeRecipientPairing(f.store, 'line-worker', token + 'wrong', recipient, now), /INVALID_INPUT/);
  assert.equal((await consumeRecipientPairing(f.store, 'line-worker', token, recipient, now)).state, 'connected');
  assert.equal((await consumeRecipientPairing(f.store, 'line-worker', token, recipient, now)).state, 'connected');
  await assert.rejects(() => consumeRecipientPairing(f.store, 'line-worker', token, 'U' + 'c'.repeat(32), now), /IDEMPOTENCY_CONFLICT/);
  const target = tenantTargetId(f.workspace.id, 'property'), worker = { id: 'line-worker', targets: [] };
  assert.deepEqual((await workerOperation(f.store, worker, { action: 'targets' }, now)).targets, [target]);
  const sent = await workerOperation(f.store, worker, { action: 'claim', targetId: target, day: '2026-10-10', attemptId: randomUUID() }, now);
  assert.equal(sent.jobs.length, 1); assert.equal(sent.jobs[0].recipient, recipient);
  assert.match(sent.jobs[0].text, /需要嬰兒床/);
  const previous = await f.current(); previous.members[1].active = false; await f.put(previous);
  assert.equal(await activeTenantRecipient(f.store, (await f.store.read(`arrival:recipient:${f.workspace.id}:property`)).value), null);
  assert.equal((await workerOperation(f.store, worker, { action: 'claim', targetId: target, day: '2026-10-10', attemptId: randomUUID() }, now)).status, 'disabled');
  previous.members[1].active = true; await f.put(previous);
  await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountId: 'steward', enabled: false, includeUnconfirmed: false }, now);
  assert.equal((await workerOperation(f.store, worker, { action: 'claim', targetId: target, day: '2026-10-10', attemptId: randomUUID() }, now)).status, 'disabled');
});

test('switching to another member invalidates the old LINE and an unconsumed pairing token', async () => {
  const f = setup();
  f.workspace.members.push({ accountId: 'other', email: 'other@example.test', role: 'housekeeper', active: true, allProperties: true, propertyIds: [] });
  await f.put(f.workspace);
  await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountId: 'steward', enabled: true, includeUnconfirmed: false }, now);
  const pair = await prepareRecipientPairing(f.store, 'steward', f.workspace.slug, 'property', now);
  const next = await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountId: 'other', enabled: true, includeUnconfirmed: false }, now);
  assert.equal(next.lineConnected, false);
  await assert.rejects(() => consumeRecipientPairing(f.store, 'line-worker', pair.command.split(' ')[1], recipient, now), /PAIRING_EXPIRED/);
});
