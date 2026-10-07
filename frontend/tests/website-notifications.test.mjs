import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/lib/customer-workspaces/auth.ts';
import { authorizeWorkerBinding, discoverWorkerBindings, notificationFingerprint, notificationPlan, notificationStates, notificationWorker, notificationOperation } from '../src/lib/website-booking/notifications.ts';

const now = new Date('2026-10-07T04:00:00.000Z');
const token = 'synthetic-notification-worker-token-1234567890';
const bindingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherBinding = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const worker = { id: 'notification-worker', token_sha256: digest(token), binding_ids: [bindingId], actions: ['notifications'] };
function memory(values = new Map()) {
  return {
    values, commits: [], rates: [],
    async read(key) { const raw = values.get(key) ?? null; return { raw, value: raw === null ? null : JSON.parse(raw) }; },
    async commit(changes) {
      assert.equal(new Set(changes.map(c => c.key)).size, changes.length, 'No duplicate CAS keys');
      if (changes.some(c => (values.get(c.key) ?? null) !== c.before)) throw Error('VERSION_CONFLICT');
      for (const c of changes) { assert.equal(c.ttlSeconds, undefined, 'Receipts and jobs must not expire'); values.set(c.key, JSON.stringify(c.after)); }
      this.commits.push(changes);
    },
    async limit(key, max) { this.rates.push({ key, max }); },
  };
}
async function fixture({ line = false, persist = true } = {}) {
  const store = memory();
  const binding = {
    id: bindingId, clientId: 'editor', siteId: 'synthetic-site', siteName: 'Synthetic inn', ownerAccountId: 'synthetic-owner',
    ownerEmail: 'owner@example.invalid', workspaceId: 'synthetic-workspace', propertyId: 'synthetic-property', inventoryMode: 'platform_only', enabled: true,
    approvedAt: '2026-10-06T00:00:00.000Z',
    config: { transferInstructions: 'Contact the synthetic inn for test payment instructions.', cancellationPolicy: 'Synthetic cancellation policy.' },
    ...(line ? { ownerLine: { recipientId: `U${'a'.repeat(32)}`, verifiedAt: '2026-10-06T00:00:00.000Z', verifiedBy: 'synthetic-owner' } } : {}),
  };
  const booking = {
    id: 'synthetic-booking', version: 1, propertyId: binding.propertyId, platform: 'Official Website', guestName: 'Synthetic guest',
    checkIn: '2026-10-20', checkOut: '2026-10-22', roomIds: ['synthetic-room'], total: 1200,
    status: 'held', hold: { schema: 1, scope: 'platform_only', state: 'active', startedAt: now.toISOString(), expiresAt: '2026-10-08T04:00:00.000Z' },
    website: { bindingId, quoteId: randomUUID(), requestId: randomUUID(), reference: 'TEST-123', email: 'guest@example.invalid', phone: '0000000000', adults: 2, children: 0, notificationIds: {} },
  };
  const workspace = { id: binding.workspaceId, version: 1, bookings: [], properties: [{ id: binding.propertyId }], members: [{ accountId: binding.ownerAccountId, active: true, role: 'owner', allProperties: true, propertyIds: [] }] };
  store.values.set(`website:binding:${bindingId}`, JSON.stringify(binding));
  store.values.set(`workspace:${workspace.id}`, JSON.stringify(workspace));
  const plan = await notificationPlan(store, binding, booking, 'hold_created', now);
  booking.website.notificationIds = plan.notificationIds;
  workspace.bookings = [booking];
  const changes = [
    { key: `workspace:${workspace.id}`, before: store.values.get(`workspace:${workspace.id}`), after: workspace },
    { key: 'website:receipt:synthetic', before: null, after: { orderId: booking.id } },
    ...plan.changes,
  ];
  if (persist) await store.commit(changes);
  const operation = (body, at = now, useStore = store, useWorker = worker) => notificationOperation(useStore, useWorker, { schemaVersion: 1, bindingId, ...body }, at);
  const claim = (attemptId = randomUUID(), at = now, useStore = store) => operation({ action: 'claim', attemptId }, at, useStore);
  const ack = (job, extra = {}, at = now, useStore = store) => operation({ action: 'ack', jobId: job.id, attemptId: job.attemptId, outcome: 'sent', providerId: 'provider:synthetic-message-123', ...extra }, at, useStore);
  const mutate = (key, fn) => { const v = JSON.parse(store.values.get(key)); fn(v); store.values.set(key, JSON.stringify(v)); };
  return { store, binding, booking, workspace, plan, changes, operation, claim, ack, mutate };
}

test('notification plan is side-effect free and booking/receipt/outbox succeed or fail as one transaction', async () => {
  const f = await fixture({ persist: false });
  assert.equal(f.store.commits.length, 0);
  assert.equal([...f.store.values.keys()].filter(k => k.startsWith('website:notification')).length, 0);
  f.mutate(`workspace:${f.workspace.id}`, w => { w.version++; });
  await assert.rejects(f.store.commit(f.changes), /VERSION_CONFLICT/);
  assert.equal((await f.store.read(`workspace:${f.workspace.id}`)).value.bookings.length, 0);
  assert.equal((await f.store.read('website:receipt:synthetic')).value, null);
  assert.equal([...f.store.values.keys()].filter(k => k.startsWith('website:notification')).length, 0);
  f.changes[0].before = f.store.values.get(`workspace:${f.workspace.id}`);
  await f.store.commit(f.changes);
  assert.equal((await f.store.read(`workspace:${f.workspace.id}`)).value.bookings[0].id, f.booking.id);
  assert.equal((await f.store.read('website:receipt:synthetic')).value.orderId, f.booking.id);
  assert.deepEqual(await notificationStates(f.store, f.booking), { guestEmail: 'queued', ownerEmail: 'queued', ownerLine: 'failed' });
});

test('separate channels persist immutable payloads, unbound LINE is explicit, and guest projection contains only states', async () => {
  const f = await fixture();
  const jobs = await Promise.all(Object.values(f.plan.notificationIds).map(id => f.store.read(`website:notification:${id}`)));
  assert.equal(jobs[0].value.recipient, 'guest@example.invalid');
  assert.equal(jobs[1].value.recipient, 'owner@example.invalid');
  assert.equal(jobs[2].value.recipient, null);
  assert.equal(jobs[2].value.lastError, 'RECIPIENT_UNBOUND');
  assert.match(jobs[0].value.text, /保留期限到後仍待旅宿決定/);
  assert(!jobs[0].value.text.includes('owner@example.invalid'));
  const serialized = JSON.stringify(await notificationStates(f.store, f.booking));
  assert(!serialized.includes('@') && !serialized.includes('Synthetic') && !serialized.includes(f.booking.id));
  f.booking.website.notificationIds.guestEmail = 'missing-job';
  assert.equal((await notificationStates(f.store, f.booking)).guestEmail, 'unknown');
});

test('a repeated plan never resets sent, unknown, failed, payload or permanent claim state', async () => {
  const f = await fixture();
  const one = (await f.claim()).jobs[0];
  await f.ack(one);
  const two = (await f.claim()).jobs[0];
  await f.ack(two, { outcome: 'unknown', providerId: undefined, errorCode: 'PROVIDER_TIMEOUT' });
  const before = new Map(f.store.values);
  f.binding.ownerEmail = 'new-owner@example.invalid';
  const replay = await notificationPlan(f.store, f.binding, f.booking, 'hold_created', now);
  assert.deepEqual(replay.changes, []);
  assert.deepEqual(replay.notificationIds, f.plan.notificationIds);
  assert.deepEqual(f.store.values, before);
  assert.deepEqual(await notificationStates(f.store, f.booking), { guestEmail: 'sent', ownerEmail: 'unknown', ownerLine: 'failed' });
});

test('response loss and process restart recover the exact persisted claim without taking another job', async () => {
  const f = await fixture();
  const attemptId = randomUUID();
  const originalCommit = f.store.commit.bind(f.store);
  let lose = true;
  f.store.commit = async changes => { await originalCommit(changes); if (lose) { lose = false; throw Error('WRITE_UNCONFIRMED'); } };
  await assert.rejects(f.claim(attemptId), /WRITE_UNCONFIRMED/);
  const restarted = memory(f.store.values);
  const first = await f.claim(attemptId, now, restarted);
  const again = await f.claim(attemptId, now, memory(f.store.values));
  assert.equal(first.jobs.length, 1);
  assert.deepEqual(again.jobs, first.jobs);
  assert.equal(again.jobs[0].attemptId, attemptId);
  assert.equal((await notificationStates(restarted, f.booking)).ownerEmail, 'queued');
  await f.ack(first.jobs[0], {}, now, restarted);
  const afterAck = await f.claim(attemptId, now, restarted);
  assert.deepEqual(afterAck.jobs, []);
  assert.equal(afterAck.results[0].state, 'sent');
});

test('concurrent claims allocate distinct jobs and empty attempts remain empty after restart', async () => {
  const f = await fixture();
  const attempts = Array.from({ length: 4 }, () => randomUUID());
  const claims = await Promise.all(attempts.map(v => f.claim(v)));
  const jobs = claims.flatMap(v => v.jobs);
  assert.equal(jobs.length, 2);
  assert.equal(new Set(jobs.map(j => j.id)).size, 2);
  for (let i = 0; i < attempts.length; i++) {
    const again = await f.claim(attempts[i], now, memory(f.store.values));
    assert.deepEqual(again.jobs, claims[i].jobs);
  }
});

test('a timed out send becomes durable unknown and is never assigned again, while matching provider evidence can reconcile it', async () => {
  const f = await fixture();
  const attemptId = randomUUID(), first = (await f.claim(attemptId)).jobs[0];
  assert.equal((await notificationStates(f.store, f.booking)).guestEmail, 'unknown');
  const later = new Date(now.getTime() + 11 * 60_000);
  const next = await f.claim(randomUUID(), later);
  assert.equal(next.jobs[0].channel, 'ownerEmail');
  assert.deepEqual((await f.claim(attemptId, later)).jobs, []);
  const timedOut = (await f.store.read(`website:notification:${first.id}`)).value;
  assert.equal(timedOut.state, 'unknown'); assert.equal(timedOut.lastError, 'CLAIM_EXPIRED');
  await f.ack(first, { providerId: 'provider:late-reconciled-receipt' }, later);
  assert.equal((await notificationStates(f.store, f.booking)).guestEmail, 'sent');
});

test('worker credentials never accept guest/editor tokens or cross-binding access', async () => {
  process.env.WEBSITE_BOOKING_WORKERS = JSON.stringify([worker]);
  assert.equal(notificationWorker(token).id, worker.id);
  assert.throws(() => notificationWorker('synthetic-guest-binding-token-1234567890'), /UNAUTHORIZED/);
  const f = await fixture();
  await assert.rejects(f.operation({ action: 'claim', attemptId: randomUUID(), bindingId: otherBinding }), /FORBIDDEN/);
  assert.equal(f.store.commits.length, 1);
  await assert.rejects(f.operation({ action: 'claim', attemptId: randomUUID() }, now, f.store, { ...worker, actions: [] }), /FORBIDDEN/);
  process.env.WEBSITE_BOOKING_WORKERS = JSON.stringify([{ ...worker, binding_ids: ['*'] }]);
  assert.throws(() => notificationWorker(token), /WEBSITE_BOOKING_UNAVAILABLE/);
  process.env.WEBSITE_BOOKING_WORKERS = JSON.stringify([worker]);
});

test('ack requires provider proof, the claiming worker and exact attempt, and an accepted acknowledgement cannot change', async () => {
  const f = await fixture(), first = (await f.claim()).jobs[0];
  await assert.rejects(f.ack(first, { providerId: undefined }), /PROVIDER_PROOF_REQUIRED/);
  await assert.rejects(f.ack(first, { errorCode: 'guest@example.invalid' }), /INVALID_INPUT/);
  await assert.rejects(f.ack(first, { providerId: 'provider\nInjected' }), /INVALID_INPUT/);
  await assert.rejects(f.ack(first, { providerId: '<' }), /INVALID_INPUT/);
  await assert.rejects(f.ack(first, { outcome: ['sent'], providerId: undefined }), /INVALID_INPUT/);
  await assert.rejects(f.ack(first, { outcome: { state: 'sent' } }), /INVALID_INPUT/);
  await assert.rejects(f.ack(first, { attemptId: randomUUID() }), /NOTIFICATION_ACK_CONFLICT/);
  await assert.rejects(f.operation({ action: 'ack', jobId: first.id, attemptId: first.attemptId, outcome: 'sent', providerId: 'receipt-123' }, now, f.store, { ...worker, id: 'other-worker' }), /NOTIFICATION_ACK_CONFLICT/);
  const accepted = await f.ack(first);
  assert.equal(accepted.state, 'sent');
  assert.equal((await f.ack(first)).replayed, true);
  await assert.rejects(f.ack(first, { outcome: 'unknown' }), /NOTIFICATION_ACK_CONFLICT/);
  await assert.rejects(f.ack(first, { providerId: 'changed-provider-receipt' }), /NOTIFICATION_ACK_CONFLICT/);
});

test('an owner removed before claim never receives email or LINE from the old verified snapshot', async () => {
  const f = await fixture({ line: true });
  const first = (await f.claim()).jobs[0]; await f.ack(first);
  f.mutate(`workspace:${f.workspace.id}`, w => { w.members[0].active = false; });
  assert.deepEqual((await f.claim()).jobs, []);
  const states = await notificationStates(f.store, f.booking);
  assert.deepEqual(states, { guestEmail: 'sent', ownerEmail: 'failed', ownerLine: 'failed' });
  for (const channel of ['ownerEmail', 'ownerLine']) assert.equal((await f.store.read(`website:notification:${f.plan.notificationIds[channel]}`)).value.lastError, 'RECIPIENT_REVOKED');
});

test('LINE recipient rebind is checked again on claim, and unbound verification cannot create a send', async () => {
  const f = await fixture({ line: true });
  await f.ack((await f.claim()).jobs[0]); await f.ack((await f.claim()).jobs[0]);
  f.mutate(`website:binding:${bindingId}`, b => { b.ownerLine.recipientId = `U${'b'.repeat(32)}`; });
  assert.deepEqual((await f.claim()).jobs, []);
  assert.equal((await f.store.read(`website:notification:${f.plan.notificationIds.ownerLine}`)).value.lastError, 'RECIPIENT_CHANGED');
  const unverified = await fixture({ persist: false });
  unverified.binding.ownerLine = { recipientId: `U${'c'.repeat(32)}`, verifiedAt: 'not-a-date', verifiedBy: 'owner' };
  const plan = await notificationPlan(unverified.store, unverified.binding, unverified.booking, 'hold_created', now);
  assert.equal(plan.changes.find(c => c.after.channel === 'ownerLine').after.state, 'failed');
});

test('revocation after claim suppresses retry payload and records uncertain delivery, without erasing a late provider receipt', async () => {
  const f = await fixture({ line: true });
  await f.ack((await f.claim()).jobs[0]); await f.ack((await f.claim()).jobs[0]);
  const attemptId = randomUUID(), line = (await f.claim(attemptId)).jobs[0];
  f.mutate(`workspace:${f.workspace.id}`, w => { w.members[0].role = 'viewer'; });
  const recovered = await f.claim(attemptId);
  assert.deepEqual(recovered.jobs, []);
  assert.equal(recovered.results[0].state, 'unknown');
  await f.ack(line, { providerId: 'line:provider-receipt-before-revocation' });
  assert.equal((await notificationStates(f.store, f.booking)).ownerLine, 'sent');
});

test('configuration changes and disabled new sales do not erase pending notification receipts', async () => {
  const f = await fixture();
  f.mutate(`website:binding:${bindingId}`, b => { b.enabled = false; b.configurationHash = 'new-configuration'; });
  const claim = await f.claim();
  assert.equal(claim.jobs[0].channel, 'guestEmail');
  await f.ack(claim.jobs[0]);
  assert.equal((await notificationStates(f.store, f.booking)).guestEmail, 'sent');
});

test('queued old hold notices are superseded after conversion, release or extension; claimed old notices become unknown', async () => {
  for (const next of [
    { status: 'confirmed', state: 'converted' }, { status: 'cancelled', state: 'released' }, { status: 'held', state: 'active' },
  ]) {
    const f = await fixture();
    const attemptId = randomUUID(), first = (await f.claim(attemptId)).jobs[0];
    f.mutate(`workspace:${f.workspace.id}`, w => { const b = w.bookings[0]; b.version++; b.status = next.status; b.hold.state = next.state; if (next.status === 'held') b.hold.expiresAt = '2026-10-09T04:00:00.000Z'; });
    assert.deepEqual((await f.claim()).jobs, []);
    assert.equal((await f.store.read(`website:notification:${f.plan.notificationIds.ownerEmail}`)).value.lastError, 'SUPERSEDED');
    const old = await f.claim(attemptId);
    assert.deepEqual(old.jobs, []); assert.equal(old.results[0].state, 'unknown');
    assert.equal((await f.store.read(`website:notification:${first.id}`)).value.lastError, 'SUPERSEDED');
  }
});

test('expiry plans notify only the owner, retain the original guest result, and repeat without creating new jobs', async () => {
  const f = await fixture({ line: true });
  const guest = (await f.claim()).jobs[0]; await f.ack(guest);
  const later = new Date(now.getTime() + 25 * 3600000);
  f.booking.hold.state = 'awaiting_owner';
  const plan = await notificationPlan(f.store, f.binding, f.booking, 'hold_expired', later);
  assert.equal(plan.notificationIds.guestEmail, undefined);
  assert.equal(plan.changes.filter(c => c.after.channel === 'guestEmail').length, 0);
  f.booking.website.notificationIds = { ...f.booking.website.notificationIds, ...plan.notificationIds };
  f.mutate(`workspace:${f.workspace.id}`, w => { w.bookings = [f.booking]; });
  await f.store.commit(plan.changes);
  const first = (await f.claim(randomUUID(), later)).jobs[0];
  assert.equal(first.event, 'hold_expired'); assert.equal(first.channel, 'ownerEmail');
  assert.match(first.text, /仍待旅宿決定，不會自動釋放/);
  const repeated = await notificationPlan(f.store, f.binding, f.booking, 'hold_expired', later);
  assert.deepEqual(repeated.changes, []);
  assert.equal((await notificationStates(f.store, f.booking)).guestEmail, 'sent');
});

test('an owner revocation racing with claim is caught by the same atomic guard before payload is returned', async () => {
  const f = await fixture();
  await f.ack((await f.claim()).jobs[0]);
  const original = f.store.commit.bind(f.store); let raced = false;
  f.store.commit = async changes => {
    if (!raced && changes.some(c => c.after.channel === 'ownerEmail' && c.after.state === 'sending')) {
      raced = true; f.mutate(`workspace:${f.workspace.id}`, w => { w.members[0].active = false; });
    }
    return original(changes);
  };
  assert.deepEqual((await f.claim()).jobs, []);
  assert.equal((await notificationStates(f.store, f.booking)).ownerEmail, 'failed');
});

test('an ack response lost after commit is recovered without resending or changing delivery evidence', async () => {
  const f = await fixture(), first = (await f.claim()).jobs[0];
  const original = f.store.commit.bind(f.store); let lose = true;
  f.store.commit = async changes => { await original(changes); if (lose) { lose = false; throw Error('WRITE_UNCONFIRMED'); } };
  await assert.rejects(f.ack(first), /WRITE_UNCONFIRMED/);
  const recovered = await f.ack(first, {}, now, memory(f.store.values));
  assert.equal(recovered.state, 'sent'); assert.equal(recovered.replayed, true);
  assert.equal((await notificationStates(f.store, f.booking)).guestEmail, 'sent');
});

test('scoped enqueue_expired creates owner jobs once and never releases occupancy or replaces the guest notification', async () => {
  const f = await fixture();
  const guestId = f.booking.website.notificationIds.guestEmail;
  const later = new Date(now.getTime() + 25 * 3600000);
  const input = { action: 'enqueue_expired', attemptId: randomUUID() };
  const first = await f.operation(input, later);
  assert.equal(first.schemaVersion, 1); assert.equal(first.queued, 1);
  assert.equal((await f.operation(input, later)).queued, 0);
  const booking = (await f.store.read(`workspace:${f.workspace.id}`)).value.bookings[0];
  assert.equal(booking.status, 'held'); assert.equal(booking.version, 1);
  assert.equal(booking.website.notificationIds.guestEmail, guestId);
  assert.equal(booking.website.expiryNotifiedFingerprint, notificationFingerprint(booking));
  f.mutate(`workspace:${f.workspace.id}`, w => { w.bookings[0].notes = 'Harmless note'; w.bookings[0].version++; });
  assert.equal((await f.operation({ ...input, attemptId: randomUUID() }, later)).queued, 0);
  assert.equal((await f.claim(randomUUID(), later)).jobs[0].event, 'hold_expired');
  await assert.rejects(f.operation({ ...input, bindingId: otherBinding }, later), /FORBIDDEN/);
});

test('notes, tags, bookkeeping and later policy changes preserve the original correct message', async () => {
  const f = await fixture();
  const before = notificationFingerprint(f.booking);
  f.mutate(`workspace:${f.workspace.id}`, w => {
    const b = w.bookings[0]; b.version += 4; b.notes = 'Housekeeping note'; b.tagIds = ['tag'];
    b.bookedAt = '2026-10-06'; b.payments = [{ id: 'receipt-only', amount: 10 }];
  });
  f.mutate(`website:binding:${bindingId}`, b => { b.config.cancellationPolicy = 'New policy'; b.config.transferInstructions = 'New instructions'; });
  const changed = (await f.store.read(`workspace:${f.workspace.id}`)).value.bookings[0];
  assert.equal(notificationFingerprint(changed), before);
  const job = (await f.claim()).jobs[0];
  assert.equal(job.channel, 'guestEmail'); assert.equal(job.bookingVersion, 1);
  assert.match(job.text, /Synthetic cancellation policy/);
  assert(!job.text.includes('New policy') && !job.text.includes('Housekeeping note'));
  await f.ack(job); assert.equal((await notificationStates(f.store, changed)).guestEmail, 'sent');
});

test('guest payload and expiry actions also require the owner to retain this property scope', async () => {
  const f = await fixture();
  f.mutate(`workspace:${f.workspace.id}`, w => { w.members[0].allProperties = false; w.members[0].propertyIds = []; });
  assert.deepEqual((await f.claim()).jobs, []);
  assert.equal((await notificationStates(f.store, f.booking)).guestEmail, 'failed');
  await assert.rejects(f.operation({ action: 'enqueue_expired', attemptId: randomUUID() }, new Date(now.getTime() + 25 * 3600000)), /BINDING_UNAVAILABLE/);
});

test('unknown acknowledgement can be reconciled by its original worker with provider readback while preserving the original ack', async () => {
  const f = await fixture(), job = (await f.claim()).jobs[0];
  await f.ack(job, { outcome: 'unknown', providerId: undefined, errorCode: 'PROVIDER_TIMEOUT' });
  const original = (await f.store.read(`website:notification:${job.id}`)).value;
  const body = { action: 'reconcile', attemptId: job.attemptId, jobId: job.id, outcome: 'sent', providerId: 'provider:verified-readback', providerReadbackVerified: true };
  await assert.rejects(f.operation({ ...body, providerReadbackVerified: false }), /PROVIDER_PROOF_REQUIRED/);
  await assert.rejects(f.operation({ ...body, providerId: undefined }), /PROVIDER_PROOF_REQUIRED/);
  await assert.rejects(f.operation(body, now, f.store, { ...worker, id: 'different-worker' }), /NOTIFICATION_ACK_CONFLICT/);
  assert.equal((await f.operation(body)).state, 'sent');
  assert.equal((await f.operation(body)).replayed, true);
  const saved = (await f.store.read(`website:notification:${job.id}`)).value;
  assert.equal(saved.ackHash, original.ackHash); assert(saved.reconcileHash);
  assert.equal(saved.providerId, body.providerId);
  assert.equal((await notificationStates(f.store, f.booking)).guestEmail, 'sent');
  await assert.rejects(f.operation({ ...body, providerId: 'provider:different-readback' }), /NOTIFICATION_ACK_CONFLICT/);
  await assert.rejects(f.operation({ ...body, outcome: 'queued' }), /PROVIDER_PROOF_REQUIRED/);
});

test('channel-limited workers cannot claim LINE and a reused attempt cannot change its channel selection', async () => {
  const f = await fixture({ line: true });
  const emailWorker = { ...worker, channels: ['guestEmail', 'ownerEmail'] };
  const attemptId = randomUUID();
  const first = await f.operation({ action: 'claim', attemptId, channels: ['guestEmail'] }, now, f.store, emailWorker);
  assert.equal(first.jobs[0].channel, 'guestEmail');
  await assert.rejects(f.operation({ action: 'claim', attemptId, channels: ['ownerEmail'] }, now, f.store, emailWorker), /NOTIFICATION_CLAIM_CONFLICT/);
  await assert.rejects(f.operation({ action: 'claim', attemptId: randomUUID(), channels: ['ownerLine'] }, now, f.store, emailWorker), /FORBIDDEN/);
  const second = await f.operation({ action: 'claim', attemptId: randomUUID() }, now, f.store, emailWorker);
  assert.equal(second.jobs[0].channel, 'ownerEmail');
  assert.deepEqual((await f.operation({ action: 'claim', attemptId: randomUUID() }, now, f.store, emailWorker)).jobs, []);
  assert.equal((await f.store.read(`website:notification:${f.plan.notificationIds.ownerLine}`)).value.state, 'queued');
});

test('worker registry supports separate capabilities and exact approved site scopes without granting wildcard tenants', async () => {
  const f = await fixture();
  const scoped = { id: 'site-worker', token_sha256: digest(token), site_scopes: [{ client_id: 'editor', site_id: 'synthetic-site' }], actions: ['line_binding', 'owner_actions', 'notifications'], channels: ['ownerLine'] };
  process.env.WEBSITE_BOOKING_WORKERS = JSON.stringify([scoped]);
  const parsed = notificationWorker(token, 'line_binding');
  assert.deepEqual(parsed.binding_ids, []); assert.equal(notificationWorker(token, 'owner_actions').id, scoped.id);
  const siteKey = `website:site:${digest(JSON.stringify(['editor', 'synthetic-site']))}`;
  f.store.values.set(siteKey, JSON.stringify({ bindingId, ownerAccountId: f.binding.ownerAccountId }));
  const allowed = await authorizeWorkerBinding(f.store, parsed, bindingId);
  assert.equal(allowed.binding.id, bindingId);
  assert(allowed.guards.some(c => c.key === siteKey));
  await assert.rejects(authorizeWorkerBinding(f.store, { ...parsed, site_scopes: [{ client_id: 'other-editor', site_id: 'synthetic-site' }] }, bindingId), /FORBIDDEN/);
  f.store.values.set(siteKey, JSON.stringify({ bindingId: otherBinding, ownerAccountId: f.binding.ownerAccountId }));
  await assert.rejects(authorizeWorkerBinding(f.store, parsed, bindingId), /FORBIDDEN/);
  process.env.WEBSITE_BOOKING_WORKERS = JSON.stringify([{ ...scoped, site_scopes: [{ client_id: 'editor', site_id: '*' }] }]);
  assert.throws(() => notificationWorker(token), /WEBSITE_BOOKING_UNAVAILABLE/);
  process.env.WEBSITE_BOOKING_WORKERS = JSON.stringify([{ ...worker, actions: ['line_binding'] }]);
  assert.throws(() => notificationWorker(token), /UNAUTHORIZED/);
  process.env.WEBSITE_BOOKING_WORKERS = JSON.stringify([worker, { ...worker, id: 'duplicate-token-worker' }]);
  assert.throws(() => notificationWorker(token), /WEBSITE_BOOKING_UNAVAILABLE/);
  process.env.WEBSITE_BOOKING_WORKERS = JSON.stringify([worker]);
});

test('binding discovery follows exact site grants, deduplicates explicit grants, and exposes only integration metadata', async () => {
  const f = await fixture({ line: true });
  const siteKey = `website:site:${digest(JSON.stringify(['editor', 'synthetic-site']))}`;
  f.store.values.set(siteKey, JSON.stringify({ bindingId, ownerAccountId: f.binding.ownerAccountId }));
  const scoped = { ...worker, binding_ids: [], site_scopes: [{ client_id: 'editor', site_id: 'synthetic-site' }] };
  const expected = [{ bindingId, lineConnected: true, inventoryMode: 'platform_only' }];
  const readKeys = [], original = f.store.read.bind(f.store);
  f.store.read = async key => { readKeys.push(key); return original(key); };
  assert.deepEqual(await discoverWorkerBindings(f.store, scoped, now), expected);
  assert.deepEqual(await discoverWorkerBindings(f.store, { ...scoped, binding_ids: [bindingId] }, now), expected);
  assert(readKeys.every(key => [siteKey, `website:binding:${bindingId}`, `workspace:${f.workspace.id}`].includes(key)));
  assert.deepEqual(await discoverWorkerBindings(f.store, { ...scoped, site_scopes: [{ client_id: 'other-editor', site_id: 'synthetic-site' }] }, now), []);
  // A stale index that points at a binding belonging to another site grants no access.
  f.mutate(`website:binding:${bindingId}`, b => { b.siteId = 'another-site'; });
  assert.deepEqual(await discoverWorkerBindings(f.store, scoped, now), []);
  await assert.rejects(discoverWorkerBindings(f.store, { ...worker, actions: ['line_binding'] }, now), /FORBIDDEN/);
});

test('binding discovery omits unavailable ownership, unapproved and unsupported bindings while validating LINE verification', async () => {
  const f = await fixture({ line: true });
  const expected = [{ bindingId, lineConnected: false, inventoryMode: 'platform_only' }];
  f.mutate(`website:binding:${bindingId}`, b => { b.ownerLine.verifiedAt = new Date(now.getTime() + 60000).toISOString(); });
  assert.deepEqual(await discoverWorkerBindings(f.store, worker, now), expected);
  f.mutate(`website:binding:${bindingId}`, b => { b.enabled = false; delete b.ownerLine; });
  assert.deepEqual(await discoverWorkerBindings(f.store, worker, now), expected, 'Existing deliveries remain discoverable when new sales are off');
  for (const mutate of [
    b => { delete b.approvedAt; },
    b => { b.approvedAt = 'invalid'; },
    b => { b.approvedAt = new Date(now.getTime() + 60000).toISOString(); },
    b => { b.inventoryMode = 'unverified'; },
  ]) {
    f.store.values.set(`website:binding:${bindingId}`, JSON.stringify(f.binding));
    f.mutate(`website:binding:${bindingId}`, mutate);
    assert.deepEqual(await discoverWorkerBindings(f.store, worker, now), []);
  }
  f.store.values.set(`website:binding:${bindingId}`, JSON.stringify(f.binding));
  for (const mutate of [
    w => { w.members[0].active = false; },
    w => { w.members[0].role = 'viewer'; },
    w => { w.members[0].allProperties = false; w.members[0].propertyIds = []; },
    w => { w.properties = []; },
  ]) {
    f.store.values.set(`workspace:${f.workspace.id}`, JSON.stringify(f.workspace));
    f.mutate(`workspace:${f.workspace.id}`, mutate);
    assert.deepEqual(await discoverWorkerBindings(f.store, worker, now), []);
  }
  assert.deepEqual(await discoverWorkerBindings(f.store, { ...worker, binding_ids: [otherBinding] }, now), []);
});

test('binding discovery preserves storage failures and rejects a malformed persisted site index', async () => {
  const f = await fixture();
  const scoped = { ...worker, binding_ids: [], site_scopes: [{ client_id: 'editor', site_id: 'synthetic-site' }] };
  const siteKey = `website:site:${digest(JSON.stringify(['editor', 'synthetic-site']))}`;
  f.store.values.set(siteKey, JSON.stringify({ bindingId: 'owner@example.invalid' }));
  await assert.rejects(discoverWorkerBindings(f.store, scoped, now), error => error.message === 'STORE_UNAVAILABLE');
  f.store.read = async () => { throw Error('STORE_UNAVAILABLE'); };
  await assert.rejects(discoverWorkerBindings(f.store, worker, now), /STORE_UNAVAILABLE/);
});

test('a large queue is scanned in bounded pages without trapping an email behind LINE work', async () => {
  const f = await fixture({ line: true });
  const template = (await f.store.read(`website:notification:${f.plan.notificationIds.ownerLine}`)).value;
  const prefix = [];
  for (let i = 0; i < 150; i++) {
    const id = digest(`synthetic-line-backlog-${i}`); prefix.push(id);
    f.store.values.set(`website:notification:${id}`, JSON.stringify({ ...template, id }));
  }
  f.mutate(`website:notification-index:${bindingId}`, index => { index.ids = [...prefix, ...index.ids]; });
  const emailWorker = { ...worker, channels: ['guestEmail', 'ownerEmail'] };
  let jobReads = 0; const original = f.store.read.bind(f.store);
  f.store.read = async key => { if (key.startsWith('website:notification:')) jobReads++; return original(key); };
  const first = await f.operation({ action: 'claim', attemptId: randomUUID() }, now, f.store, emailWorker);
  assert.deepEqual(first.jobs, []); assert.equal(first.hasMore, true); assert.equal(jobReads, 100);
  jobReads = 0;
  const next = await f.operation({ action: 'claim', attemptId: randomUUID() }, now, f.store, emailWorker);
  assert.equal(next.jobs[0].channel, 'guestEmail'); assert(jobReads < 60);
  assert.equal((await f.store.read(`website:notification:${prefix[0]}`)).value.state, 'queued');
});

test('malformed bodies and authority fields are rejected without copying sensitive values into errors', async () => {
  const f = await fixture();
  for (const body of [null, [], { schemaVersion: 1, action: 'claim', bindingId, attemptId: 'guest@example.invalid' },
    { schemaVersion: 1, action: ['claim'], bindingId, attemptId: randomUUID() },
    { schemaVersion: 1, action: 'claim', bindingId, attemptId: randomUUID(), recipient: 'guest@example.invalid' },
    { schemaVersion: 1, action: 'claim', bindingId, attemptId: randomUUID(), tenant: 'secret-workspace' }]) {
    await assert.rejects(notificationOperation(f.store, worker, body, now), error => {
      assert.equal(error.message, 'INVALID_INPUT'); return true;
    });
  }
});
