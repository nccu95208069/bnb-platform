import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { PostgresPropertyRepository } from '../src/postgres-repository.mjs';
import { PostgresCredentialDirectory } from '../src/postgres-auth.mjs';
import { IronGateService } from '../src/service.ts';
import { stageOfflandLineBookingGrant } from '../scripts/stage-offland-line-booking-grant.mjs';
import { switchOfflandLineBookingGrant } from '../scripts/switch-offland-line-booking-grant.mjs';
import { inspectProperty } from '../scripts/check-property-integrity.mjs';
import { retentionFixture, key } from './retained-fixture.mjs';

function localPool(connectionString, database, role) {
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, `/${database}`);
  if (role) url.username = role;
  return new Pool({ connectionString: url.toString(), max: 4 });
}
const runtimeUrl = process.env.IRON_GATE_PG_TEST_URL;
const provisionUrl = process.env.IRON_GATE_PG_PROVISION_TEST_URL;

test('Postgres provider-free booking survives reconnect, preserves exact receipts and has one last-room winner',
  { skip: !runtimeUrl }, async () => {
    let pool = localPool(runtimeUrl, 'iron_gate_test');
    try {
      const f = await retentionFixture({ repository: new PostgresPropertyRepository(pool), native: true });
      const actor = { ...f.owner, origin: 'line', grantId: key(), lineProviderFreeEnabled: true,
        actions: ['booking:read', 'booking:create', 'booking:amend', 'booking:cancel', 'booking:manage_all'] };
      await f.repository.transact(f.propertyId, state => {
        state.channel.lineBookingMode = 'provider_free'; state.channel.lineBookingGrantId = actor.grantId; state.version++;
      });
      const service = new IronGateService(f.repository, 'p'.repeat(43));
      const before = await f.read();
      const amendInput = { expectedInventoryVersion: before.state.version, expectedBookingVersion: before.booking.version,
        channelPolicy: 'provider_free', changes: { stays: [{ roomIds: [f.roomId], checkIn: '2027-06-01', checkOut: '2027-06-02' }],
          totalCents: 600000 } };
      const amendedPreview = await service.previewLineAction(actor, f.propertyId, f.bookingId, 'amend', amendInput);
      const amended = await service.amendBooking(actor, f.propertyId, f.bookingId, key(), amendInput, amendedPreview.previewToken);
      assert.equal(amended.operationState, 'not_required');
      const input = { expectedInventoryVersion: amended.inventoryVersion, source: 'line', channelPolicy: 'provider_free',
        stays: [{ roomIds: [f.roomId], checkIn: '2027-07-01', checkOut: '2027-07-02' }],
        guestName: 'Synthetic Concurrent', contact: null, notes: null, totalCents: 650000, bookedAt: '2026-10-29' };
      const preview = await service.previewLineCreate(actor, f.propertyId, input);
      const attempts = [key(), key()];
      const results = await Promise.allSettled(attempts.map(requestKey => service.createBooking(actor,
        f.propertyId, requestKey, input, preview.previewToken)));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'VERSION_CONFLICT');
      const winner = results.find(result => result.status === 'fulfilled').value;
      const cancelInput = { expectedBookingVersion: winner.bookingVersion, expectedInventoryVersion: winner.inventoryVersion,
        channelPolicy: 'provider_free' };
      const cancelPreview = await service.previewLineAction(actor, f.propertyId, winner.bookingId, 'cancel', cancelInput);
      const cancelKey = key();
      const receipt = await service.cancelBooking(actor, f.propertyId, winner.bookingId, cancelKey,
        cancelInput.expectedBookingVersion, cancelInput.expectedInventoryVersion, cancelPreview.previewToken, 'provider_free');
      await pool.end(); pool = localPool(runtimeUrl, 'iron_gate_test');
      const repository = new PostgresPropertyRepository(pool), reopened = new IronGateService(repository, 'p'.repeat(43));
      assert.deepEqual(await reopened.cancelBooking(actor, f.propertyId, winner.bookingId, cancelKey,
        cancelInput.expectedBookingVersion, cancelInput.expectedInventoryVersion, cancelPreview.previewToken, 'provider_free'), receipt);
      const state = await repository.read(f.propertyId);
      assert.equal(state.bookings.length, 2); assert.equal(state.bookings.filter(b => b.status === 'cancelled').length, 1);
      assert.equal(state.receipts.filter(r => r.key === cancelKey).length, 1);
      assert.deepEqual(state.operations, []); assert.deepEqual(state.fences, []);
      assert.equal(state.bookings.every(b => b.channelSyncState === 'not_required' && b.lineChannelPending === undefined), true);
      assert.equal((await inspectProperty(pool, f.propertyId)).ok, true);
    } finally { await pool.end(); }
  });

test('Postgres Offland grant stage, atomic activation failure, activate and revoke preserve bookings and deny inactive credentials',
  { skip: !provisionUrl }, async () => {
    const admin = localPool(provisionUrl, 'postgres');
    const runtime = localPool(provisionUrl, 'postgres', 'iron_gate_test_runtime');
    const directory = await mkdtemp(join(tmpdir(), 'offland-line-pg-grant-'));
    try {
      const f = await retentionFixture({ repository: new PostgresPropertyRepository(runtime) });
      await f.repository.transact(f.propertyId, state => { state.roomIds = [f.roomId]; });
      const before = (await f.read()).state;
      const manifest = { projectRef: 'brcszrkwkgiwatrxevkf', propertyId: f.propertyId,
        workspaceId: f.workspaceId, expectedVersion: before.version, credentialId: key(), grantId: key(),
        clientId: key(), groupId: 'synthetic-group', actorIds: ['synthetic-owner'],
        sourceAccount: 'synthetic-offland-sheet', channelPolicy: 'provider_free',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        requestKey: key(), authorizationRef: 'synthetic-owner-authorization' };
      const output = join(directory, 'inactive.json');
      await stageOfflandLineBookingGrant(admin, manifest, output);
      const secret = JSON.parse(await readFile(output, 'utf8'));
      const credentials = new PostgresCredentialDirectory(runtime);
      assert.equal(await credentials.lookup(secret.token), null);
      assert.deepEqual((await f.read()).state, before);
      const broken = { query: (...args) => admin.query(...args), connect: async () => {
        const client = await admin.connect();
        return { release: () => client.release(), query: (sql, ...args) => {
          if (sql.startsWith('INSERT INTO iron_gate.audit_log')) throw Error('synthetic audit failure');
          return client.query(sql, ...args);
        } };
      } };
      await assert.rejects(switchOfflandLineBookingGrant(broken, 'activate', manifest), { message: 'synthetic audit failure' });
      assert.deepEqual((await f.read()).state, before);
      assert.equal(await credentials.lookup(secret.token), null);
      const activated = await switchOfflandLineBookingGrant(admin, 'activate', manifest);
      assert.equal(activated.active, true);
      assert.equal((await credentials.lookup(secret.token)).lineProviderFreeEnabled, true);
      const enabled = (await f.read()).state;
      assert.equal(enabled.version, before.version + 1);
      assert.equal(enabled.channel.lineBookingGrantId, manifest.grantId);
      assert.deepEqual(enabled.bookings, before.bookings); assert.deepEqual(enabled.sourceLinks, before.sourceLinks);
      assert.equal((await switchOfflandLineBookingGrant(admin, 'activate', manifest)).alreadyApplied, true);
      assert.equal((await f.read()).state.version, enabled.version);
      const revoke = { ...manifest, requestKey: key(), expectedVersion: enabled.version };
      const revoked = await switchOfflandLineBookingGrant(admin, 'revoke', revoke);
      assert.equal(revoked.active, false); assert.equal(await credentials.lookup(secret.token), null);
      const after = (await f.read()).state;
      assert.equal(after.version, enabled.version + 1);
      assert.equal(after.channel.lineBookingMode, undefined);
      assert.equal(after.channel.lineBookingGrantId, undefined);
      assert.deepEqual(after.bookings, before.bookings); assert.deepEqual(after.sourceLinks, before.sourceLinks);
      assert.equal((await switchOfflandLineBookingGrant(admin, 'activate', manifest)).alreadyApplied, true);
      assert.equal(await credentials.lookup(secret.token), null, 'replaying old activation cannot reverse a later revoke');
      const audits = await admin.query('SELECT audit_json FROM iron_gate.audit_log WHERE property_id = $1', [f.propertyId]);
      assert.equal(audits.rows.length, 2);
      assert.equal((await inspectProperty(runtime, f.propertyId)).ok, true);
    } finally { await admin.end(); await runtime.end(); await rm(directory, { recursive: true, force: true }); }
  });
