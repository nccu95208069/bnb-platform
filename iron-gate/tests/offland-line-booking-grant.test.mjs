import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planOfflandLineBookingGrant, planOfflandLineBookingActivation,
  stageOfflandLineBookingGrant } from '../scripts/stage-offland-line-booking-grant.mjs';
import { tokenHash } from '../src/credential-grant.mjs';
import { retentionFixture, key } from './retained-fixture.mjs';

async function fixture() {
  const f = await retentionFixture();
  const state = (await f.read()).state;
  state.roomIds = [f.roomId];
  const manifest = { projectRef: 'brcszrkwkgiwatrxevkf', propertyId: f.propertyId,
    workspaceId: f.workspaceId, expectedVersion: state.version, credentialId: key(),
    grantId: key(), clientId: key(), groupId: 'synthetic-group', actorIds: ['synthetic-owner'],
    sourceAccount: 'synthetic-offland-sheet', channelPolicy: 'provider_free',
    expiresAt: new Date(Date.now() + 86400000).toISOString() };
  return { state, manifest };
}

test('Offland grant candidate is property, source, group and actor scoped without provider or money mutation rights', async () => {
  const { state, manifest } = await fixture(); const before = structuredClone(state);
  const { grant } = planOfflandLineBookingGrant(state, manifest);
  assert.deepEqual(grant.actions, ['booking:read', 'booking:create', 'booking:amend', 'booking:cancel', 'booking:manage_all']);
  assert.equal(grant.lineInventoryEnabled, undefined);
  assert.equal(grant.lineFinanceEnabled, undefined);
  assert.equal(grant.propertyId, state.propertyId);
  assert.deepEqual(grant.lineActorIds, manifest.actorIds);
  const candidate = planOfflandLineBookingActivation(state, manifest);
  assert.equal(candidate.expectedVersion, state.version);
  assert.equal(candidate.state.version, state.version + 1);
  assert.equal(candidate.state.channel.lineBookingMode, 'provider_free');
  assert.equal(candidate.state.channel.lineBookingGrantId, grant.grantId);
  assert.deepEqual(candidate.state.bookings, state.bookings);
  assert.deepEqual(candidate.state.sourceLinks, state.sourceLinks);
  assert.deepEqual(candidate.state.operations, []);
  assert.deepEqual(state, before);
});

test('Offland grant preparation rejects wrong property, source, epoch, provider configuration and unknown actors', async () => {
  const { state, manifest } = await fixture();
  for (const mutate of [
    m => { m.propertyId = key(); }, m => { m.workspaceId = key(); },
    m => { m.expectedVersion++; }, m => { m.sourceAccount = 'different-source'; },
    m => { m.inventoryEnabled = true; }, m => { m.channelPolicy = 'manual'; },
    m => { m.actorIds = []; }, m => { m.actorIds = ['duplicate', 'duplicate']; },
    m => { m.expiresAt = new Date(Date.now() - 1).toISOString(); },
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    assert.throws(() => planOfflandLineBookingGrant(state, changed));
  }
  for (const mutate of [
    s => { s.channel.mode = 'owlnest'; }, s => { s.channel.ready = true; },
    s => { s.channel.grantId = key(); }, s => { s.channel.lineBookingMode = 'provider_free'; },
    s => { s.channel.sourceReadbackEnabled = true; }, s => { s.authorityEpoch++; },
    s => { s.readOnly = true; }, s => { s.sourceGrants[0].active = false; },
    s => { delete s.offlandImport; }, s => { s.operations = [{ key: key() }]; },
  ]) {
    const changed = structuredClone(state); mutate(changed);
    assert.throws(() => planOfflandLineBookingGrant(changed, manifest));
  }
});

function mockPool(state, { existing = false, commitError = false } = {}) {
  let inserted = null, committed = false;
  const queries = [];
  const client = { release() {}, async query(sql, values) {
    queries.push(sql);
    if (sql.startsWith('SELECT state_json')) return { rows: [{ state_json: structuredClone(state) }] };
    if (sql.startsWith('SELECT credential_id')) return { rows: existing ? [{ credential_id: key() }] : [] };
    if (sql.startsWith('INSERT INTO iron_gate.credentials')) {
      assert.match(sql, /false\)/);
      inserted = { token_hash: values[0], grant_json: JSON.parse(values[3]), active: false };
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('SELECT token_hash')) return { rows: [inserted] };
    if (sql === 'COMMIT') { committed = true; if (commitError) throw Error('synthetic commit acknowledgment lost'); }
    return { rows: [] };
  } };
  return { connect: async () => client,
    query: async () => ({ rows: [{ login: 'postgres', database_name: 'postgres' }] }),
    inspect: () => ({ inserted, committed, queries }) };
}

test('Offland staging stores only an inactive hash and private recovery file, leaving property activation separate', async () => {
  const { state, manifest } = await fixture(); const pool = mockPool(state);
  const directory = await mkdtemp(join(tmpdir(), 'offland-line-grant-test-'));
  try {
    const output = join(directory, 'grant.json');
    const response = await stageOfflandLineBookingGrant(pool, manifest, output);
    assert.equal(response.status, 'staged_inactive_provider_free');
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(saved.active, false);
    assert.equal(saved.channelPolicy, 'provider_free');
    assert.equal(typeof saved.token, 'string'); assert.equal(saved.token.length, 43);
    assert.equal(pool.inspect().inserted.token_hash === tokenHash(saved.token), true);
    assert.equal(pool.inspect().inserted.active, false);
    assert.equal(pool.inspect().committed, true);
    assert.equal(pool.inspect().queries.some(sql => sql.includes('UPDATE iron_gate.property_state')), false);
    assert.equal(JSON.stringify(response).includes(saved.token), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Offland staging refuses a duplicate writer and preserves secret recovery after unknown commit', async () => {
  const { state, manifest } = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'offland-line-grant-test-'));
  try {
    const output = join(directory, 'grant.json');
    await assert.rejects(stageOfflandLineBookingGrant(mockPool(state, { existing: true }), manifest, output),
      { message: 'OFFLAND_LINE_WRITER_GRANT_ALREADY_PRESENT' });
    await assert.rejects(stat(output), { code: 'ENOENT' });
    await assert.rejects(stageOfflandLineBookingGrant(mockPool(state, { commitError: true }), manifest, output),
      { message: 'synthetic commit acknowledgment lost' });
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).active, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
