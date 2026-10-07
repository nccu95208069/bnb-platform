import test from 'node:test';
import assert from 'node:assert/strict';
import { runWebsiteEmailDelivery, emailDeliveryBindings, emailDeliverySiteScopes } from '../src/lib/website-booking/delivery.ts';
import { notificationStates } from '../src/lib/website-booking/notifications.ts';
import { emailFixture, memoryEmailStore, fixtureNow, storedRecords } from './helpers/website-email-fixture.mjs';

const fixedNow = () => fixtureNow;
const run = (f, send, extra = {}) => runWebsiteEmailDelivery(f.store, [f.bindingId], { send, now: fixedNow, ...extra });
const deliveries = f => storedRecords(f.store, 'website:email-delivery:');

test('native email delivery persists sending before the provider call and confirms durable provider evidence before sent', async () => {
  const f = await emailFixture(); const calls = [];
  const result = await run(f, async (to, subject, text) => {
    const pending = deliveries(f).filter(d => d.state === 'sending');
    assert.equal(pending.length, 1); assert(pending[0].dispatchId);
    assert.equal(pending[0].providerId, undefined);
    assert(!JSON.stringify(pending[0]).includes('@'));
    calls.push({ to, subject, text }); return `provider:message-${calls.length}`;
  });
  assert.equal(result.sent, 2); assert.equal(result.pending, 0); assert.equal(result.unknown, 0);
  assert.deepEqual(calls.map(c => c.to), ['guest-0@example.invalid', 'owner@example.invalid']);
  assert(deliveries(f).every(d => d.state === 'sent' && d.providerId && d.acknowledgedAt));
  assert.deepEqual(await notificationStates(f.store, f.bookings[0]), { guestEmail: 'sent', ownerEmail: 'sent', ownerLine: 'queued' });
  const line = (await f.store.read(`website:notification:${f.bookings[0].website.notificationIds.ownerLine}`)).value;
  assert.equal(line.state, 'queued'); assert.equal(line.attemptId, undefined);
  const receiptCount = storedRecords(f.store, 'website:notification-claim:').length;
  const again = await run({ ...f, store: memoryEmailStore(f.store.values) }, async () => { throw Error('must not resend'); });
  assert.equal(again.scanned, 0); assert.equal(calls.length, 2);
  assert.equal(storedRecords(f.store, 'website:notification-claim:').length, receiptCount, 'Idle polls do not accumulate empty permanent receipts');
});

test('concurrent invocations share the current attempt and only one crosses the durable sending CAS', async () => {
  const f = await emailFixture(); let calls = 0, finishProvider, started;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const first = run(f, async () => { calls++; started(); return new Promise(resolve => { finishProvider = resolve; }); }, { maxJobs: 1 });
  await providerStarted;
  const concurrent = await run({ ...f, store: memoryEmailStore(f.store.values) }, async () => { calls++; return 'provider:duplicate'; }, { maxJobs: 1 });
  assert.equal(concurrent.pending, 1); assert.equal(calls, 1);
  finishProvider('provider:exactly-one');
  assert.equal((await first).sent, 1);
  assert.equal((await run(f, async () => { calls++; return 'provider:owner-message'; }, { maxJobs: 1 })).sent, 1);
  assert.equal(calls, 2);
});

test('crash after persisting sending never redispatches, even if the first process had not reached the provider', async () => {
  const f = await emailFixture(); const original = f.store.commit.bind(f.store); let crashed = false, calls = 0;
  f.store.commit = async changes => {
    await original(changes);
    if (!crashed && changes.some(c => c.key.startsWith('website:email-delivery:') && c.after.state === 'sending')) { crashed = true; throw Error('STORE_UNAVAILABLE'); }
  };
  const send = async () => { calls++; return 'provider:must-not-be-called'; };
  assert.equal((await run(f, send, { maxJobs: 1 })).pending, 1); assert.equal(calls, 0);
  const restarted = { ...f, store: memoryEmailStore(f.store.values) };
  assert.equal((await run(restarted, send, { maxJobs: 1 })).pending, 1); assert.equal(calls, 0);
  const later = () => new Date(fixtureNow.getTime() + 11 * 60000);
  assert.equal((await run(restarted, send, { maxJobs: 1, now: later })).unknown, 1);
  assert.equal(calls, 0);
  assert.equal((await notificationStates(restarted.store, f.bookings[0])).guestEmail, 'unknown');
});

test('provider acceptance survives process restart; an ACK failure retries only ACK', async () => {
  const f = await emailFixture(); const original = f.store.commit.bind(f.store); let calls = 0;
  f.store.commit = async changes => {
    if (changes.some(c => c.key.startsWith('website:notification:') && c.after.state === 'sent')) throw Error('STORE_UNAVAILABLE');
    return original(changes);
  };
  const send = async () => { calls++; return 'provider:persisted-before-ack'; };
  assert.equal((await run(f, send, { maxJobs: 1 })).pending, 1); assert.equal(calls, 1);
  assert.equal(deliveries(f)[0].state, 'accepted'); assert.equal(deliveries(f)[0].providerId, 'provider:persisted-before-ack');
  const restarted = { ...f, store: memoryEmailStore(f.store.values) };
  const result = await run(restarted, send, { maxJobs: 1 });
  assert.equal(result.sent, 1); assert.equal(calls, 1);
  assert.equal((await notificationStates(restarted.store, f.bookings[0])).guestEmail, 'sent');
});

test('lost responses after accepted persistence or ACK commit recover without another provider send', async () => {
  for (const phase of ['accepted', 'ack']) {
    const f = await emailFixture(); const original = f.store.commit.bind(f.store); let lost = false, calls = 0;
    f.store.commit = async changes => {
      await original(changes);
      const target = changes.some(c => phase === 'accepted' ? c.key.startsWith('website:email-delivery:') && c.after.state === 'accepted' : c.key.startsWith('website:notification:') && c.after.state === 'sent');
      if (!lost && target) { lost = true; throw Error('WRITE_UNCONFIRMED'); }
    };
    const send = async () => { calls++; return `provider:lost-response-${phase}`; };
    assert.equal((await run(f, send, { maxJobs: 1 })).pending, 1);
    const restarted = { ...f, store: memoryEmailStore(f.store.values) };
    assert.equal((await run(restarted, send, { maxJobs: 1 })).sent, 1);
    assert.equal(calls, 1);
  }
});

test('SMTP/OAuth exceptions and missing provider IDs remain unknown with machine-only errors and no resend', async () => {
  for (const mode of ['throws', 'no-proof']) {
    const f = await emailFixture(); let calls = 0;
    const send = async () => { calls++; if (mode === 'throws') throw Error('SMTP rejected guest-secret@example.invalid token=private-secret'); return ''; };
    const result = await run(f, send, { maxJobs: 1 });
    assert.equal(result.unknown, 1); assert.equal(result.sent, 0);
    const record = deliveries(f)[0];
    assert.equal(record.state, 'unknown'); assert.equal(record.lastError, 'EMAIL_PROVIDER_UNCERTAIN');
    assert(!JSON.stringify(record).includes('guest-secret') && !JSON.stringify(record).includes('private-secret'));
    assert.equal((await notificationStates(f.store, f.bookings[0])).guestEmail, 'unknown');
    // Only the other channel may be sent by a fresh claim.
    await run({ ...f, store: memoryEmailStore(f.store.values) }, async to => { assert.equal(to, 'owner@example.invalid'); calls++; return 'provider:owner-only'; }, { maxJobs: 1 });
    assert.equal(calls, 2);
  }
});

test('failed sending-state readback prevents the external call, and failed accepted readback cannot report sent', async () => {
  for (const phase of ['sending', 'accepted']) {
    const f = await emailFixture(); const original = f.store.read.bind(f.store); let faulted = false, calls = 0;
    f.store.read = async key => {
      const snapshot = await original(key);
      if (!faulted && key.startsWith('website:email-delivery:') && snapshot.value?.state === phase) { faulted = true; return { ...snapshot, value: null }; }
      return snapshot;
    };
    const result = await run(f, async () => { calls++; return 'provider:readback-required'; }, { maxJobs: 1 });
    assert.equal(result.sent, 0); assert.equal(result.pending, 1); assert.equal(calls, phase === 'sending' ? 0 : 1);
    if (phase === 'accepted') {
      assert.equal((await notificationStates(f.store, f.bookings[0])).guestEmail, 'unknown');
      assert.equal((await run({ ...f, store: memoryEmailStore(f.store.values) }, async () => { throw Error('must not resend'); }, { maxJobs: 1 })).sent, 1);
    }
  }
});

test('owner revocation or semantic change racing with pre-send persistence aborts dispatch atomically', async () => {
  for (const change of ['owner', 'hold']) {
    const f = await emailFixture(); const original = f.store.commit.bind(f.store); let raced = false, calls = 0;
    f.store.commit = async changes => {
      if (!raced && changes.some(c => c.key.startsWith('website:email-delivery:') && c.after.state === 'sending')) {
        raced = true; f.mutate(`workspace:${f.workspace.id}`, w => {
          if (change === 'owner') { w.members[0].allProperties = false; w.members[0].propertyIds = []; }
          else { w.bookings[0].hold.expiresAt = '2026-10-09T04:00:00.000Z'; w.bookings[0].version++; }
        });
      }
      return original(changes);
    };
    assert.equal((await run(f, async () => { calls++; return 'provider:forbidden'; }, { maxJobs: 1 })).pending, 1);
    assert.equal(calls, 0); assert.equal(deliveries(f).length, 0);
  }
});

test('one invocation sends at most ten emails and leaves remaining jobs for a later invocation', async () => {
  const f = await emailFixture({ count: 6, line: false }); let calls = 0;
  const send = async () => `provider:bounded-${++calls}`;
  const result = await run(f, send);
  assert.equal(result.sent, 10); assert.equal(result.scanned, 10); assert.equal(calls, 10);
  const remaining = await run(f, send);
  assert.equal(remaining.sent, 2); assert.equal(calls, 12);
  await assert.rejects(run(f, send, { maxJobs: 11 }), /INVALID_INPUT/);
});

test('configured exact site scopes discover approved bindings without per-binding environment edits or broad scans', async () => {
  const f = await emailFixture(); let calls = 0;
  const scope = { client_id: f.binding.clientId, site_id: f.binding.siteId };
  const result = await runWebsiteEmailDelivery(f.store, [], { siteScopes: [scope], now: fixedNow, send: async () => `provider:site-scope-${++calls}` });
  assert.equal(result.sent, 2); assert.equal(calls, 2);
  const other = await emailFixture({ bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', siteId: 'another-site', store: f.store });
  await runWebsiteEmailDelivery(f.store, [], { siteScopes: [scope], now: fixedNow, send: async () => { throw Error('must not send another site'); } });
  assert.equal((await notificationStates(f.store, other.bookings[0])).guestEmail, 'queued');
  await assert.rejects(runWebsiteEmailDelivery(f.store, [], { siteScopes: [{ ...scope, site_id: '*' }], now: fixedNow }), /INVALID_INPUT/);
  process.env.WEBSITE_BOOKING_EMAIL_BINDINGS = JSON.stringify([f.bindingId]);
  process.env.WEBSITE_BOOKING_EMAIL_SITE_SCOPES = JSON.stringify([scope]);
  assert.deepEqual(emailDeliveryBindings(), [f.bindingId]); assert.deepEqual(emailDeliverySiteScopes(), [scope]);
  process.env.WEBSITE_BOOKING_EMAIL_SITE_SCOPES = JSON.stringify([{ client_id: '*', site_id: f.binding.siteId }]);
  assert.throws(emailDeliverySiteScopes, /EMAIL_DELIVERY_UNAVAILABLE/);
});
