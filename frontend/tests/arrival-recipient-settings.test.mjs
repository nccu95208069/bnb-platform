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
  await assert.rejects(() => saveRecipientSetting(f.store, 'steward', f.workspace.slug, 'property', { recipientAccountIds: ['steward'], enabled: true, includeUnconfirmed: false }, now), /FORBIDDEN/);
  const view = await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountIds: ['steward'], enabled: true, includeUnconfirmed: false }, now);
  assert.equal(view.recipients[0].email, 'steward@example.test');
  assert.equal(view.recipients[0].lineConnected, false);
  assert.equal((await targetIndex(f.store)).length, 1);
  await assert.rejects(() => prepareRecipientPairing(f.store, 'calendar-owner', f.workspace.slug, 'property', now), /FORBIDDEN/);
  const pair = await prepareRecipientPairing(f.store, 'steward', f.workspace.slug, 'property', now);
  assert.match(pair.command, /^接收入住 [a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal((await settingView(f.store, 'steward', f.workspace.slug, 'property')).canPair, true);
  assert.equal(JSON.stringify(f.store.data).includes(pair.command), false);
  await assert.rejects(() => consumeRecipientPairing(f.store, 'line-worker', pair.command.split(' ')[1], recipient, new Date(now.getTime() + 600001)), /PAIRING_EXPIRED/);
});

test('verified private LINE sender becomes the sole recipient; revoking membership or toggling off stops new dispatch', async () => {
  const f = setup();
  await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountIds: ['steward'], enabled: true, includeUnconfirmed: false }, now);
  const pair = await prepareRecipientPairing(f.store, 'steward', f.workspace.slug, 'property', now);
  const token = pair.command.split(' ')[1];
  await assert.rejects(() => consumeRecipientPairing(f.store, 'line-worker', token + 'wrong', recipient, now), /INVALID_INPUT/);
  assert.equal((await consumeRecipientPairing(f.store, 'line-worker', token, recipient, now)).state, 'connected');
  assert.equal((await consumeRecipientPairing(f.store, 'line-worker', token, recipient, now)).state, 'connected');
  await assert.rejects(() => consumeRecipientPairing(f.store, 'line-worker', token, 'U' + 'c'.repeat(32), now), /IDEMPOTENCY_CONFLICT/);
  const target = tenantTargetId(f.workspace.id, 'property', 0), worker = { id: 'line-worker', targets: [] };
  assert.deepEqual((await workerOperation(f.store, worker, { action: 'targets' }, now)).targets, [0, 1, 2].map(slot => tenantTargetId(f.workspace.id, 'property', slot)));
  const sent = await workerOperation(f.store, worker, { action: 'claim', targetId: target, day: '2026-10-10', attemptId: randomUUID() }, now);
  assert.equal(sent.jobs.length, 1); assert.equal(sent.jobs[0].recipient, recipient);
  assert.match(sent.jobs[0].text, /需要嬰兒床/);
  const previous = await f.current(); previous.members[1].active = false; await f.put(previous);
  assert.equal(await activeTenantRecipient(f.store, (await f.store.read(`arrival:recipient:${f.workspace.id}:property`)).value, 'steward'), null);
  assert.equal((await workerOperation(f.store, worker, { action: 'claim', targetId: target, day: '2026-10-10', attemptId: randomUUID() }, now)).status, 'disabled');
  previous.members[1].active = true; await f.put(previous);
  await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountIds: ['steward'], enabled: false, includeUnconfirmed: false }, now);
  assert.equal((await workerOperation(f.store, worker, { action: 'claim', targetId: target, day: '2026-10-10', attemptId: randomUUID() }, now)).status, 'disabled');
});

test('switching to another member invalidates the old LINE and an unconsumed pairing token', async () => {
  const f = setup();
  f.workspace.members.push({ accountId: 'other', email: 'other@example.test', role: 'housekeeper', active: true, allProperties: true, propertyIds: [] });
  await f.put(f.workspace);
  await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountIds: ['steward'], enabled: true, includeUnconfirmed: false }, now);
  const pair = await prepareRecipientPairing(f.store, 'steward', f.workspace.slug, 'property', now);
  const next = await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountIds: ['other'], enabled: true, includeUnconfirmed: false }, now);
  assert.equal(next.recipients[0].lineConnected, false);
  await assert.rejects(() => consumeRecipientPairing(f.store, 'line-worker', pair.command.split(' ')[1], recipient, now), /PAIRING_EXPIRED/);
});

test('three selected stewards each receive the same eligible note once, with independent receipts', async () => {
  const f = setup();
  for (const id of ['second', 'third']) f.workspace.members.push({ accountId: id, email: id + '@example.test', role: 'housekeeper', active: true, allProperties: true, propertyIds: [] });
  await f.put(f.workspace);
  const ids = ['steward', 'second', 'third'];
  await assert.rejects(() => saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountIds: ['steward', 'second', 'third', 'calendar-owner'], enabled: true, includeUnconfirmed: false }, now), /INVALID_INPUT/);
  await assert.rejects(() => saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountIds: ['steward', 'steward'], enabled: true, includeUnconfirmed: false }, now), /INVALID_INPUT/);
  await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountIds: ids, enabled: true, includeUnconfirmed: false }, now);
  const lines = ids.map((_, index) => 'U' + String(index + 1).repeat(32));
  for (let index = 0; index < ids.length; index++) {
    const pair = await prepareRecipientPairing(f.store, ids[index], f.workspace.slug, 'property', now);
    await consumeRecipientPairing(f.store, 'line-worker', pair.command.split(' ')[1], lines[index], now);
  }
  const worker = { id: 'line-worker', targets: [] };
  assert.deepEqual((await workerOperation(f.store, worker, { action: 'targets' }, now)).targets.sort(), [0, 1, 2].map(slot => tenantTargetId(f.workspace.id, 'property', slot)).sort());
  for (let index = 0; index < ids.length; index++) {
    const target = tenantTargetId(f.workspace.id, 'property', index);
    const first = await workerOperation(f.store, worker, { action: 'claim', targetId: target, day: '2026-10-10', attemptId: randomUUID() }, now);
    assert.equal(first.jobs.length, 1);
    assert.equal(first.jobs[0].recipient, lines[index]);
    const duplicate = await workerOperation(f.store, worker, { action: 'claim', targetId: target, day: '2026-10-10', attemptId: randomUUID() }, now);
    assert.equal(duplicate.jobs.length, 0);
  }
  const view = await settingView(f.store, 'calendar-owner', f.workspace.slug, 'property');
  assert.equal(view.recipients.length, 3);
  assert.ok(view.recipients.every(r => r.lineConnected));
  const secondView = await settingView(f.store, 'second', f.workspace.slug, 'property');
  assert.deepEqual(secondView.recipients.map(r => r.accountId), ['second']);
});

test('one LINE account cannot be paired to two selected members', async () => {
  const f = setup();
  f.workspace.members.push({ accountId: 'second', email: 'second@example.test', role: 'housekeeper', active: true, allProperties: true, propertyIds: [] });
  await f.put(f.workspace);
  await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountIds: ['steward', 'second'], enabled: true, includeUnconfirmed: false }, now);
  const first = await prepareRecipientPairing(f.store, 'steward', f.workspace.slug, 'property', now);
  await consumeRecipientPairing(f.store, 'line-worker', first.command.split(' ')[1], recipient, now);
  const second = await prepareRecipientPairing(f.store, 'second', f.workspace.slug, 'property', now);
  await assert.rejects(() => consumeRecipientPairing(f.store, 'line-worker', second.command.split(' ')[1], recipient, now), /IDEMPOTENCY_CONFLICT/);
});

test('removing a recipient preserves the target long enough to acknowledge an in-flight delivery', async () => {
  const f = setup();
  f.workspace.members.push({ accountId: 'second', email: 'second@example.test', role: 'housekeeper', active: true, allProperties: true, propertyIds: [] });
  await f.put(f.workspace);
  await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountIds: ['steward', 'second'], enabled: true, includeUnconfirmed: false }, now);
  const pair = await prepareRecipientPairing(f.store, 'steward', f.workspace.slug, 'property', now);
  await consumeRecipientPairing(f.store, 'line-worker', pair.command.split(' ')[1], recipient, now);
  const worker = { id: 'line-worker', targets: [] }, target = tenantTargetId(f.workspace.id, 'property', 0), attemptId = randomUUID();
  const claim = await workerOperation(f.store, worker, { action: 'claim', targetId: target, day: '2026-10-10', attemptId }, now);
  assert.equal(claim.jobs.length, 1);
  await saveRecipientSetting(f.store, 'calendar-owner', f.workspace.slug, 'property', { recipientAccountIds: ['second'], enabled: true, includeUnconfirmed: false }, now);
  const ack = await workerOperation(f.store, worker, { action: 'ack', targetId: target, day: '2026-10-10', attemptId, jobId: claim.jobs[0].id, outcome: 'sent', providerReceipt: 'synthetic-receipt' }, now);
  assert.equal(ack.state, 'sent');
  assert.equal((await workerOperation(f.store, worker, { action: 'status', targetId: target, day: '2026-10-10', attemptId, jobId: claim.jobs[0].id }, now)).state, 'sent');
  assert.equal((await workerOperation(f.store, worker, { action: 'claim', targetId: target, day: '2026-10-10', attemptId: randomUUID() }, now)).status, 'disabled');
});
