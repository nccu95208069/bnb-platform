import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresPropertyRepository } from '../src/postgres-repository.mjs';
import { IronGateService } from '../src/service.ts';

const adminUrl = process.env.IRON_GATE_REALTIME_PG_TEST_URL;
const key = randomUUID;
const sendStub = `CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text,
  topic text, private boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
  BEGIN INSERT INTO realtime.messages(payload,event,topic,private,extension)
    VALUES(payload,event,topic,private,'broadcast'); END $$`;

// Hosted Realtime's WebSocket authorization is verified separately. This local
// fixture tests the real PostgreSQL trigger, grants, RLS and transaction boundary.
test('calendar invalidations preserve transactions and capability isolation',
  { skip: !adminUrl }, async t => {
    const url = new URL(adminUrl);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/iron_gate_realtime_test');
    const admin = new Pool({ connectionString: adminUrl, max: 2 });
    const runtimeUrl = new URL(adminUrl); runtimeUrl.username = 'iron_gate_realtime_test_app';
    const runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 2 });
    const migration = await readFile(new URL('../sql/022_calendar_realtime_notifications.sql', import.meta.url), 'utf8');
    const repository = new PostgresPropertyRepository(runtime);
    const service = new IronGateService(repository, 'p'.repeat(43));
    async function fixture(mapped = true) {
      const propertyId = key(), workspaceId = key(), roomId = key(), grantId = key(), sourceGrantId = key();
      await repository.seed({ propertyId, workspaceId, roomIds: [roomId], version: 1, authorityEpoch: 7, readOnly: false,
        channel: { mode: 'none', ready: false, websiteSalesEnabled: false, grantId: null,
          websiteBindingId: null, lineBookingMode: 'provider_free', lineBookingGrantId: grantId },
        sourceGrants: [{ grantId: sourceGrantId, sourceSystem: 'ota', sourceAccount: 'synthetic-account', active: true }],
        bookings: [], sourceLinks: [], operations: [], fences: [], manualBlocks: [], receipts: [] });
      const topic = `calendar:${randomBytes(32).toString('hex')}`;
      if (mapped) await admin.query('INSERT INTO calendar_realtime.topics(property_id,topic) VALUES($1,$2)', [propertyId, topic]);
      const actor = { clientId: 'synthetic-line', subjectId: 'synthetic-member', origin: 'line',
        propertyIds: [propertyId], workspaceId, authorityEpoch: 7, grantId, lineProviderFreeEnabled: true,
        actions: ['booking:read', 'booking:create', 'booking:amend', 'booking:cancel', 'booking:manage_all'],
        fields: ['guest_name', 'contact', 'notes', 'money'] };
      const source = { ...actor, origin: 'source', clientId: 'synthetic-source', grantId: sourceGrantId,
        actions: ['source:write'], fields: [], sourceSystem: 'ota', sourceAccount: 'synthetic-account' };
      const stays = [{ checkIn: '2027-01-10', checkOut: '2027-01-11', roomIds: [roomId] }];
      const input = { expectedInventoryVersion: 1, source: 'line', channelPolicy: 'provider_free',
        stays, guestName: 'Synthetic private guest', contact: 'private@example.invalid',
        notes: 'Synthetic private notes', totalCents: 600000, bookedAt: '2026-10-30' };
      const messages = async () => (await admin.query(
        'SELECT payload,event,topic,private FROM realtime.messages WHERE topic=$1 ORDER BY id', [topic])).rows;
      return { propertyId, topic, actor, source, stays, input, messages };
    }
    async function create(f) {
      const preview = await service.previewLineCreate(f.actor, f.propertyId, f.input);
      return service.createBooking(f.actor, f.propertyId, key(), f.input, preview.previewToken);
    }
    async function asAnon(topic, sql, values = []) {
      const client = await admin.connect();
      try {
        await client.query('BEGIN'); await client.query('SET LOCAL ROLE anon');
        await client.query("SELECT set_config('realtime.topic', $1, true)", [topic]);
        return await client.query(sql, values);
      } finally { await client.query('ROLLBACK'); client.release(); }
    }
    try {
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iron_gate_realtime_test_app') THEN CREATE ROLE iron_gate_realtime_test_app LOGIN; END IF;
        END $$`);
      await admin.query(await readFile(new URL('../sql/001_property_store.sql', import.meta.url), 'utf8'));
      await admin.query('GRANT iron_gate_runtime TO iron_gate_realtime_test_app');
      await admin.query(`CREATE SCHEMA IF NOT EXISTS realtime;
        CREATE TABLE IF NOT EXISTS realtime.messages(id bigint GENERATED ALWAYS AS IDENTITY,
          payload jsonb, event text, topic text, private boolean, extension text);
        ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
        GRANT USAGE ON SCHEMA realtime TO anon;
        GRANT SELECT,INSERT ON realtime.messages TO anon;
        GRANT USAGE ON SEQUENCE realtime.messages_id_seq TO anon;
        CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$
          SELECT current_setting('realtime.topic', true) $$`);
      await admin.query(sendStub);
      await admin.query(migration);
      await admin.query(migration);

      await t.test('LINE create, metadata amendment, reschedule and cancel emit minimal private signals', async () => {
        const f = await fixture(), created = await create(f);
        let state = await repository.read(f.propertyId);
        const metadata = { expectedBookingVersion: created.bookingVersion, expectedInventoryVersion: state.version,
          channelPolicy: 'provider_free', changes: { guestName: 'Another synthetic private guest' } };
        const preview = await service.previewLineAction(f.actor, f.propertyId, created.bookingId, 'amend', metadata);
        await service.amendBooking(f.actor, f.propertyId, created.bookingId, key(), metadata, preview.previewToken);
        const amended = await repository.read(f.propertyId);
        assert.equal(amended.version, state.version, 'metadata does not advance inventory version');
        state = amended;
        const move = { expectedBookingVersion: state.bookings[0].version, expectedInventoryVersion: state.version,
          channelPolicy: 'provider_free', changes: { stays: [{ ...f.stays[0], checkIn: '2027-01-12', checkOut: '2027-01-13' }] } };
        const movePreview = await service.previewLineAction(f.actor, f.propertyId, created.bookingId, 'amend', move);
        await service.amendBooking(f.actor, f.propertyId, created.bookingId, key(), move, movePreview.previewToken);
        state = await repository.read(f.propertyId);
        const cancel = { expectedBookingVersion: state.bookings[0].version, expectedInventoryVersion: state.version, channelPolicy: 'provider_free' };
        const cancelPreview = await service.previewLineAction(f.actor, f.propertyId, created.bookingId, 'cancel', cancel);
        await service.cancelBooking(f.actor, f.propertyId, created.bookingId, key(), cancel.expectedBookingVersion,
          cancel.expectedInventoryVersion, cancelPreview.previewToken, 'provider_free');
        const events = await repository.events(f.propertyId, 0, 20), messages = await f.messages();
        assert.deepEqual(events.map(e => e.type), ['booking.created', 'booking.amended', 'booking.amended', 'booking.cancelled']);
        assert.equal(messages.length, 4);
        messages.forEach((message, index) => {
          assert.deepEqual(message.payload, { property_id: f.propertyId, cursor: String(events[index].cursor) });
          assert.equal(message.event, 'calendar.changed'); assert.equal(message.private, true);
        });
        assert.equal((await repository.read(f.propertyId)).bookings[0].status, 'cancelled');
      });

      await t.test('OTA create, date change and cancellation share the same signal path', async () => {
        const f = await fixture();
        const input = { propertyId: f.propertyId, sourceSystem: 'ota', sourceAccount: 'synthetic-account',
          externalOrderId: 'synthetic-external-order', sourceVersion: 'v1', previousSourceVersion: null,
          kind: 'upsert', expectedInventoryVersion: 1, stays: f.stays, guestName: 'Synthetic OTA private guest', bookedAt: '2026-10-30' };
        assert.equal((await service.applySourceEvent(f.source, key(), input)).state, 'applied');
        input.previousSourceVersion = 'v1'; input.sourceVersion = 'v2'; input.expectedInventoryVersion = 2;
        input.stays = [{ ...f.stays[0], checkIn: '2027-01-14', checkOut: '2027-01-15' }];
        assert.equal((await service.applySourceEvent(f.source, key(), input)).state, 'applied');
        input.previousSourceVersion = 'v2'; input.sourceVersion = 'v3'; input.expectedInventoryVersion = 3; input.kind = 'cancel';
        assert.equal((await service.applySourceEvent(f.source, key(), input)).state, 'applied');
        assert.equal((await f.messages()).length, 3);
        assert.equal((await repository.read(f.propertyId)).bookings[0].status, 'cancelled');
      });

      await t.test('notifications are invisible until commit and disappear on rollback', async () => {
        const f = await fixture(), client = await runtime.connect();
        try {
          for (const completion of ['ROLLBACK', 'COMMIT']) {
            await client.query('BEGIN');
            await client.query("SELECT set_config('iron_gate.property_id',$1,true)", [f.propertyId]);
            const eventId = key();
            await client.query('INSERT INTO iron_gate.outbox(event_id,property_id,event_json) VALUES($1,$2,$3)',
              [eventId, f.propertyId, { eventId, propertyId: f.propertyId }]);
            assert.equal((await f.messages()).length, 0);
            await client.query(completion);
            assert.equal((await f.messages()).length, completion === 'COMMIT' ? 1 : 0);
          }
        } finally { await client.query('ROLLBACK'); client.release(); }
      });

      await t.test('a failed broadcaster cannot roll back a valid booking', async () => {
        const f = await fixture();
        await admin.query(`CREATE OR REPLACE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean DEFAULT true)
          RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic sender unavailable'; END $$`);
        try {
          await create(f);
          assert.equal((await repository.read(f.propertyId)).bookings.length, 1);
          assert.equal((await repository.events(f.propertyId, 0, 10)).length, 1);
          assert.equal((await f.messages()).length, 0);
        } finally { await admin.query(sendStub); }
      });

      await t.test('capability grants receive only its own broadcast rows, no mapping reads or publishing', async () => {
        const a = await fixture(), b = await fixture(); await create(a); await create(b);
        assert.equal((await asAnon(a.topic, 'SELECT * FROM realtime.messages')).rowCount, 1);
        assert.equal((await asAnon(a.topic, 'SELECT * FROM realtime.messages WHERE topic=$1', [b.topic])).rowCount, 0);
        assert.equal((await asAnon(`calendar:${'0'.repeat(64)}`, 'SELECT * FROM realtime.messages')).rowCount, 0);
        await assert.rejects(asAnon(a.topic, 'SELECT * FROM calendar_realtime.topics'), error => error.code === '42501');
        await assert.rejects(asAnon(a.topic, 'SELECT * FROM iron_gate.property_state'), error => error.code === '42501');
        await assert.rejects(asAnon(a.topic, "INSERT INTO realtime.messages(topic,extension,payload) VALUES($1,'broadcast','{}')", [a.topic]), error => error.code === '42501');
        await assert.rejects(asAnon(a.topic, 'SELECT calendar_realtime.broadcast_outbox_change()'), error => error.code === '42501');
        await admin.query('UPDATE calendar_realtime.topics SET active=false WHERE property_id=$1', [a.propertyId]);
        assert.equal((await asAnon(a.topic, 'SELECT * FROM realtime.messages')).rowCount, 0);
      });

      await t.test('unconfigured properties commit normally without a notification', async () => {
        const f = await fixture(false); await create(f);
        assert.equal((await f.messages()).length, 0);
        assert.equal((await repository.events(f.propertyId, 0, 10)).length, 1);
      });

      await t.test('a conflicting existing Realtime policy blocks installation', async () => {
        await admin.query('CREATE POLICY synthetic_broad_realtime_read ON realtime.messages FOR SELECT TO anon USING(true)');
        try { await assert.rejects(admin.query(migration), /CALENDAR_REALTIME_EXISTING_POLICY_REQUIRES_REVIEW/); }
        finally { await admin.query('DROP POLICY synthetic_broad_realtime_read ON realtime.messages'); }
        await admin.query(migration);
      });
    } finally { await runtime.end(); await admin.end(); }
  });
