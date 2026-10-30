import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { PROJECT_REF } from '../scripts/stage-offland-line-booking-grant.mjs';
import { prepareOfflandLineBookingSql } from '../scripts/prepare-offland-line-booking-sql.mjs';
import { tokenHash } from '../src/credential-grant.mjs';
import { planOfflandLineBookingAdminSql, offlandLineBookingSnapshotSql,
  offlandLineBookingReadbackSql, verifyOfflandLineBookingCommittedReadback }
  from '../scripts/offland-line-booking-admin-sql.mjs';

const id = randomUUID;
const future = milliseconds => new Date(Date.now() + milliseconds).toISOString();
function fixture() {
  const propertyId = id(), workspaceId = id(), roomId = id(), bookingId = id();
  const state = { propertyId, workspaceId, authorityEpoch: 1, version: 7, readOnly: false,
    roomIds: [roomId], channel: { mode: 'none', ready: false, grantId: null },
    offlandImport: { sourceId: 'synthetic-source' }, sourceGrants: [{ grantId: id(),
      sourceSystem: 'offland-calendar-sheet', sourceAccount: 'synthetic-source', active: true }],
    operations: [], fences: [], manualBlocks: [], sourceLinks: [{ key: 'synthetic-source-link', opaque: 'keep' }],
    receipts: [{ key: id(), response: { preserve: 'synthetic-original-receipt' } }],
    bookings: [{ id: bookingId, propertyId, workspaceId, version: 3, status: 'confirmed',
      guestName: 'Synthetic 私人 guest not in SQL', notes: "Preserve '\n and $ and 未知 fields", contact: 'synthetic-only',
      totalCents: 1234500, paymentEvents: [{ id: id(), amountCents: 90000, method: 'synthetic-method' }],
      stays: [{ roomIds: [roomId], checkIn: '2027-01-01', checkOut: '2027-01-02' }],
      unknownFutureField: { alpha: [1, false, null, 'preserve-me'], decimal: 0.125 } }],
    unknownTopLevel: { keep: true } };
  const occupancy = [{ room_id: roomId, night: '2027-01-01', booking_id: bookingId }];
  const manifest = { projectRef: PROJECT_REF, propertyId, workspaceId, expectedVersion: state.version,
    credentialId: id(), grantId: id(), clientId: id(), sourceAccount: 'synthetic-source',
    groupId: 'synthetic-group', actorIds: ['synthetic-owner'], channelPolicy: 'provider_free',
    expiresAt: future(86_400_000), requestKey: id(), authorizationRef: 'synthetic:owner-approved' };
  const snapshot = { schema: 1, projectRef: PROJECT_REF, capturedAt: new Date().toISOString(),
    property: { property_id: propertyId, workspace_id: workspaceId, authority_epoch: 1,
      inventory_version: state.version, updated_at: new Date().toISOString() },
    stateJsonText: JSON.stringify(state), occupancyJsonText: JSON.stringify(occupancy), credentialsJsonText: '[]' };
  return { manifest, snapshot, state, occupancy };
}
function revokeManifest(manifest, expectedVersion) {
  return Object.fromEntries(['projectRef', 'propertyId', 'workspaceId', 'credentialId', 'grantId',
    'authorizationRef'].map(key => [key, manifest[key]]).concat([
    ['expectedVersion', expectedVersion], ['requestKey', id()]]));
}
const stage = (f, hash = tokenHash('synthetic-bearer')) =>
  planOfflandLineBookingAdminSql('stage', f.manifest, f.snapshot, hash);
const row = (result, key) => (Array.isArray(result) ? result : [result])
  .flatMap(item => item.rows ?? []).find(item => Object.hasOwn(item, key))?.[key];

test('planner reuses source/authority/actor restrictions and emits no guest state or bearer', () => {
  const f = fixture(), before = structuredClone(f), bundle = stage(f);
  assert.deepEqual(f, before);
  assert.equal(bundle.plan.targetAfter.active, false);
  assert.deepEqual(bundle.plan.targetAfter.grant_json.actions,
    ['booking:read', 'booking:create', 'booking:amend', 'booking:cancel', 'booking:manage_all']);
  assert.equal(bundle.plan.targetAfter.grant_json.lineInventoryEnabled, undefined);
  assert.equal(bundle.plan.targetAfter.grant_json.lineFinanceEnabled, undefined);
  assert.equal(JSON.stringify(bundle).includes(f.state.bookings[0].guestName), false);
  assert.equal(JSON.stringify(bundle).includes('synthetic-bearer'), false);
  assert.equal(Object.hasOwn(bundle.plan, 'afterState'), false);
  for (const change of [
    g => { g.manifest.sourceAccount = 'wrong-source'; },
    g => { g.manifest.actorIds = []; },
    g => { g.manifest.channelPolicy = 'manual'; },
    g => { g.manifest.inventoryEnabled = false; },
    g => { g.manifest.expectedVersion++; },
    g => { g.snapshot.property.workspace_id = id(); },
    g => { g.snapshot.capturedAt = future(-16 * 60_000); },
    g => { g.snapshot.capturedAt = future(2 * 60_000); },
    g => { g.snapshot.occupancyJsonText = '[]'; },
    g => { const s = JSON.parse(g.snapshot.stateJsonText); s.readOnly = 'false'; g.snapshot.stateJsonText = JSON.stringify(s); },
    g => { const s = JSON.parse(g.snapshot.stateJsonText); s.sourceGrants[0].active = false; g.snapshot.stateJsonText = JSON.stringify(s); },
    g => { const s = JSON.parse(g.snapshot.stateJsonText); s.channel.mode = 'owlnest'; g.snapshot.stateJsonText = JSON.stringify(s); },
  ]) { const altered = structuredClone(f); change(altered); assert.throws(() => stage(altered)); }
});

test('recovery readback rejects changed expected fields without requiring a fresh snapshot', () => {
  const { plan } = stage(fixture());
  for (const change of [
    p => { p.result.active = true; }, p => { p.evidence.stateHash = 'a'.repeat(64); },
    p => { p.targetAfter.grant_json.lineActorIds.push('different-actor'); },
    p => { p.audit.response.bookingMode = 'provider_free'; },
  ]) { const altered = structuredClone(plan); change(altered); assert.throws(() => offlandLineBookingReadbackSql(altered), /READBACK_PLAN_INVALID/); }
  assert.ok(offlandLineBookingReadbackSql(plan).includes('REPEATABLE READ READ ONLY'));
});

test('private CLI writes token once before SQL, never overwrites, and refuses unsafe files/paths', async () => {
  const directory = await mkdtemp('/private/tmp/offland-line-sql-cli-test-');
  try {
    const f = fixture(), manifest = `${directory}/manifest.json`, snapshot = `${directory}/snapshot.json`;
    await writeFile(manifest, JSON.stringify(f.manifest), { mode: 0o600 });
    await writeFile(snapshot, JSON.stringify(f.snapshot), { mode: 0o600 });
    const output = `${directory}/stage`;
    const summary = await prepareOfflandLineBookingSql('stage', manifest, snapshot, output);
    assert.equal(summary.status, 'prepared_not_applied');
    const secret = JSON.parse(await readFile(`${output}/credential.private.json`, 'utf8'));
    assert.match(secret.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(secret.issuanceStatus, 'prepared_not_applied');
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    for (const name of ['credential.private.json', 'plan.json', 'apply.sql', 'dry-run.sql', 'readback.sql', 'package.json']) {
      assert.equal((await stat(`${output}/${name}`)).mode & 0o777, 0o600);
      if (name !== 'credential.private.json') assert.equal((await readFile(`${output}/${name}`, 'utf8')).includes(secret.token), false);
    }
    const plan = JSON.parse(await readFile(`${output}/plan.json`, 'utf8'));
    assert.equal(plan.targetAfter.token_hash, tokenHash(secret.token));
    const before = await readFile(`${output}/credential.private.json`, 'utf8');
    await assert.rejects(prepareOfflandLineBookingSql('stage', manifest, snapshot, output), { code: 'EEXIST' });
    assert.equal(await readFile(`${output}/credential.private.json`, 'utf8'), before);
    await writeFile(`${directory}/public.json`, JSON.stringify(f.manifest), { mode: 0o644 });
    await assert.rejects(prepareOfflandLineBookingSql('stage', `${directory}/public.json`, snapshot, `${directory}/unsafe`), /UNSAFE_PRIVATE_INPUT/);
    await symlink(manifest, `${directory}/manifest-link.json`);
    await assert.rejects(prepareOfflandLineBookingSql('stage', `${directory}/manifest-link.json`, snapshot, `${directory}/link`), /UNSAFE_PRIVATE_INPUT/);
    await assert.rejects(prepareOfflandLineBookingSql('stage', manifest, snapshot, '/offland-line-sql-unsafe-test-output'), /PRIVATE_TEMP/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const pgBin = process.env.IRON_GATE_LOCAL_PG_BIN ?? '/opt/homebrew/opt/postgresql@15/bin';
test('isolated PostgreSQL staging and switching use committed full-scope CAS and preserve other data',
  { skip: !existsSync(`${pgBin}/initdb`) }, async t => {
    const directory = await mkdtemp('/private/tmp/offland-line-sql-pg-test-');
    let pool, independent, running = false;
    try {
      execFileSync(`${pgBin}/initdb`, ['-D', `${directory}/data`, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'ignore' });
      execFileSync(`${pgBin}/pg_ctl`, ['-D', `${directory}/data`, '-l', `${directory}/postgres.log`, '-o',
        `-k ${directory} -p 55463 -c listen_addresses='' -c fsync=off`, '-w', 'start'], { stdio: 'ignore' });
      running = true;
      const options = { host: directory, port: 55463, user: 'postgres', database: 'postgres', max: 2 };
      pool = new Pool(options); independent = new Pool({ ...options, max: 1 });
      await pool.query('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN');
      for (const migration of ['001_property_store.sql', '002_policy_plan_and_credential_index.sql',
        '003_migration_source_evidence.sql', '005_finance_ssot_core.sql'])
        await pool.query(await readFile(new URL(`../sql/${migration}`, import.meta.url), 'utf8'));
      async function capture(manifest, reader = pool) {
        return row(await reader.query(offlandLineBookingSnapshotSql(manifest)), 'snapshot');
      }
      async function readback(bundle) {
        return row(await independent.query(bundle.readbackSql), 'verification');
      }
      async function protectedData() {
        const tables = ['occupied_room_nights', 'finance_connector', 'finance_document', 'finance_revision',
          'finance_event', 'outbox'];
        const data = {};
        for (const table of tables) data[table] = (await independent.query(
          `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM iron_gate.${table} t`)).rows[0].rows;
        return data;
      }
      async function allData() {
        const data = await protectedData();
        for (const table of ['property_state', 'credentials', 'audit_log']) data[table] = (await independent.query(
          `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM iron_gate.${table} t`)).rows[0].rows;
        return data;
      }
      async function seed() {
        await pool.query('ROLLBACK');
        await pool.query('TRUNCATE iron_gate.property_state CASCADE');
        const f = fixture(), other = fixture();
        for (const item of [f, other]) {
          const s = item.state;
          await pool.query('INSERT INTO iron_gate.property_state(property_id,workspace_id,authority_epoch,inventory_version,state_json) VALUES($1,$2,$3,$4,$5)',
            [s.propertyId, s.workspaceId, s.authorityEpoch, s.version, JSON.stringify(s)]);
          for (const n of item.occupancy) await pool.query('INSERT INTO iron_gate.occupied_room_nights VALUES($1,$2,$3,$4)',
            [s.propertyId, n.room_id, n.night, n.booking_id]);
          const source = id(), document = id();
          await pool.query("INSERT INTO iron_gate.finance_connector(source_instance_id,property_id,source_system,enabled) VALUES($1,$2,'line_finance',true)", [source, s.propertyId]);
          await pool.query("INSERT INTO iron_gate.finance_document(id,property_id,source_instance_id,source_system,source_record_id,kind,current_version,status) VALUES($1,$2,$3,'line_finance','synthetic-finance-record','money',1,'active')", [document, s.propertyId, source]);
          await pool.query("INSERT INTO iron_gate.finance_revision(property_id,document_id,version,action,request_hash,source_version,actor_ref) VALUES($1,$2,1,'create',$3,'synthetic-v1','synthetic-owner')", [s.propertyId, document, 'a'.repeat(64)]);
          await pool.query("INSERT INTO iron_gate.finance_event(id,property_id,document_id,revision_version,event_kind,amount_cents,cash_effect_cents,effective_on,cash_on,evidence_level,actor_ref) VALUES($1,$2,$3,1,'expense_paid',12500,-12500,'2027-01-01','2027-01-01','operator_attested','synthetic-owner')", [id(), s.propertyId, document]);
        }
        f.snapshot = await capture(f.manifest);
        return { ...f, other };
      }
      async function refuse(sql, pattern) {
        await assert.rejects(pool.query(sql), pattern);
        await pool.query('ROLLBACK');
      }
      async function prepareActivation(f) {
        const staged = stage(f); await pool.query(staged.applySql);
        const manifest = { ...f.manifest, requestKey: id() };
        const snapshot = await capture(manifest);
        return { staged, manifest, bundle: planOfflandLineBookingAdminSql('activate', manifest, snapshot) };
      }
      async function insertFinanceGrant(f, grantId, otherProperty = false) {
        const scope = otherProperty ? f.other : f;
        const grant = { credentialId: id(), propertyId: scope.state.propertyId,
          workspaceId: scope.state.workspaceId, authorityEpoch: 1, clientId: id(),
          subjectId: 'synthetic-finance-only', origin: 'line', grantId, lineGroupId: 'synthetic-group',
          lineActorIds: ['synthetic-owner'], lineFinanceEnabled: true, financeSourceInstanceId: id(),
          actions: ['finance:read'], fields: ['money'] };
        await pool.query('INSERT INTO iron_gate.credentials(token_hash,credential_id,property_id,grant_json,expires_at,active) VALUES($1,$2,$3,$4,$5,true)',
          [tokenHash(randomBytes(32)), grant.credentialId, grant.propertyId, JSON.stringify(grant), future(86_400_000)]);
      }

      await t.test('stage dry-run, committed stage/activate/revoke, reconnect recovery and historical replay', async () => {
        const f = await seed(), original = await allData(), protectedBefore = await protectedData();
        const staged = stage(f), dry = row(await pool.query(staged.dryRunSql), 'verification');
        assert.equal(dry.executionMode, 'dry_run'); assert.equal(dry.receiptCommitted, false);
        assert.throws(() => verifyOfflandLineBookingCommittedReadback(staged.plan, dry), /COMMITTED_READBACK/);
        assert.deepEqual(await allData(), original);
        const applied = row(await pool.query(staged.applySql), 'verification');
        assert.equal(applied.receiptCommitted, true);
        assert.throws(() => verifyOfflandLineBookingCommittedReadback(staged.plan, applied), /COMMITTED_READBACK/);
        assert.equal(verifyOfflandLineBookingCommittedReadback(staged.plan, await readback(staged)).active, false);
        assert.equal((await pool.query('SELECT iron_gate.lookup_credential($1) AS grant', [staged.plan.targetAfter.token_hash])).rows[0].grant, null);
        assert.deepEqual(JSON.parse((await capture(f.manifest)).stateJsonText), f.state);
        const afterStage = await allData();
        // A new connection represents recovery after losing the commit reply.
        await pool.end(); pool = new Pool(options);
        await pool.query(staged.applySql); assert.deepEqual(await allData(), afterStage);
        const am = { ...f.manifest, requestKey: id() };
        const activated = planOfflandLineBookingAdminSql('activate', am, await capture(am));
        await pool.query(activated.applySql);
        assert.equal(verifyOfflandLineBookingCommittedReadback(activated.plan, await readback(activated)).active, true);
        const enabled = JSON.parse((await capture(am)).stateJsonText);
        assert.deepEqual(enabled, { ...f.state, version: 8, channel: { ...f.state.channel,
          lineBookingMode: 'provider_free', lineBookingGrantId: am.grantId } });
        assert.equal((await pool.query('SELECT iron_gate.lookup_credential($1) AS grant', [staged.plan.targetAfter.token_hash])).rows[0].grant.lineProviderFreeEnabled, true);
        const rm = revokeManifest(am, 8), revoked = planOfflandLineBookingAdminSql('revoke', rm, await capture(rm));
        await pool.query(revoked.applySql);
        assert.equal(verifyOfflandLineBookingCommittedReadback(revoked.plan, await readback(revoked)).active, false);
        const afterRevoke = await allData();
        await pool.query(activated.applySql); await pool.query(staged.applySql); await pool.query(revoked.applySql);
        assert.deepEqual(await allData(), afterRevoke, 'old activation/stage cannot revive a revoked credential');
        const historic = await readback(activated);
        assert.equal(historic.receiptCommitted, true); assert.equal(historic.recordedResponse.active, true);
        assert.equal(historic.currentCredentialActive, false); assert.equal(historic.currentStateMatchesExpected, false);
        assert.throws(() => verifyOfflandLineBookingCommittedReadback(activated.plan, historic), /COMMITTED_READBACK/);
        assert.deepEqual(JSON.parse((await capture(rm)).stateJsonText), { ...f.state, version: 9 });
        assert.deepEqual(await protectedData(), protectedBefore);
        assert.deepEqual((await allData()).property_state.find(p => p.property_id === f.other.state.propertyId),
          original.property_state.find(p => p.property_id === f.other.state.propertyId));
        assert.equal((await allData()).audit_log.length, 3);
      });

      for (const [name, mutate, error] of [
        ['state without version bump', f => pool.query("UPDATE iron_gate.property_state SET state_json=jsonb_set(state_json,'{unknownTopLevel,keep}','false') WHERE property_id=$1", [f.manifest.propertyId]), /STATE_OR_OCCUPANCY_DRIFT/],
        ['source revoked', f => pool.query("UPDATE iron_gate.property_state SET state_json=jsonb_set(state_json,'{sourceGrants,0,active}','false') WHERE property_id=$1", [f.manifest.propertyId]), /STATE_OR_OCCUPANCY_DRIFT/],
        ['timestamp only', f => pool.query("UPDATE iron_gate.property_state SET updated_at=updated_at+interval '1 second' WHERE property_id=$1", [f.manifest.propertyId]), /STATE_OR_OCCUPANCY_DRIFT/],
        ['occupancy', f => pool.query("UPDATE iron_gate.occupied_room_nights SET night='2027-01-02' WHERE property_id=$1", [f.manifest.propertyId]), /STATE_OR_OCCUPANCY_DRIFT/],
        ['credential phantom', f => insertFinanceGrant(f, id()), /CREDENTIAL_DRIFT/],
      ]) await t.test(`stage refuses ${name} after capture`, async () => {
        const f = await seed(), bundle = stage(f); await mutate(f); const before = await allData();
        await refuse(bundle.applySql, error); assert.deepEqual(await allData(), before);
      });

      for (const [name, expression] of [
        ['grant actor', "grant_json=jsonb_set(grant_json,'{lineActorIds}','[\"different-actor\"]')"],
        ['token hash', "token_hash=repeat('d',64)"],
        ['expiry', "expires_at=expires_at+interval '1 second'"],
        ['active flag', 'active=true'],
      ]) await t.test(`activation refuses changed ${name}`, async () => {
        const f = await seed(), { bundle } = await prepareActivation(f);
        await pool.query(`UPDATE iron_gate.credentials SET ${expression} WHERE credential_id=$1`, [f.manifest.credentialId]);
        const before = await allData(); await refuse(bundle.applySql, /CREDENTIAL_DRIFT/);
        assert.deepEqual(await allData(), before);
      });

      await t.test('grant ID collision with finance-only or another property is refused', async () => {
        for (const other of [false, true]) {
          const f = await seed(); await insertFinanceGrant(f, f.manifest.grantId, other);
          f.snapshot = await capture(f.manifest);
          if (!other) assert.throws(() => stage(f), /GRANT_ID_CONFLICT/);
          else { const bundle = stage(f), before = await allData(); await refuse(bundle.applySql, /GRANT_ID_CONFLICT/); assert.deepEqual(await allData(), before); }
        }
        const f = await seed(), { bundle } = await prepareActivation(f);
        await insertFinanceGrant(f, f.manifest.grantId, true); const before = await allData();
        await refuse(bundle.applySql, /GRANT_ID_CONFLICT/); assert.deepEqual(await allData(), before);
      });

      await t.test('inactive unexpired competing booking grant and simultaneous staging cannot create two writers', async () => {
        const f = await seed(), first = stage(f);
        const secondManifest = { ...f.manifest, credentialId: id(), grantId: id(), clientId: id(), requestKey: id() };
        const second = planOfflandLineBookingAdminSql('stage', secondManifest, f.snapshot, tokenHash('other-synthetic-bearer'));
        await pool.query(first.applySql);
        assert.throws(() => planOfflandLineBookingAdminSql('stage', secondManifest,
          { ...f.snapshot, credentialsJsonText: JSON.stringify([first.plan.targetAfter]) }, tokenHash('other-synthetic-bearer')), /OTHER_WRITER/);
        await refuse(second.applySql, /CREDENTIAL_DRIFT/);
        assert.equal((await allData()).credentials.length, 1);
        const fresh = await seed(), a = stage(fresh), bm = { ...fresh.manifest, credentialId: id(), grantId: id(), clientId: id(), requestKey: id() };
        const b = planOfflandLineBookingAdminSql('stage', bm, fresh.snapshot, tokenHash('race-synthetic-bearer'));
        const c1 = await pool.connect(), c2 = await independent.connect();
        try {
          const results = await Promise.allSettled([c1.query(a.applySql), c2.query(b.applySql)]);
          assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
          await c1.query('ROLLBACK'); await c2.query('ROLLBACK');
        } finally { c1.release(); c2.release(); }
        assert.equal((await allData()).credentials.length, 1); assert.equal((await allData()).audit_log.length, 1);
      });

      await t.test('audit failure rolls back every stage, activation and revocation write', async () => {
        for (const action of ['stage', 'activate', 'revoke']) {
          const f = await seed(); let bundle = stage(f);
          if (action !== 'stage') {
            const prepared = await prepareActivation(f); bundle = prepared.bundle;
            if (action === 'revoke') {
              await pool.query(bundle.applySql); const manifest = revokeManifest(f.manifest, 8);
              bundle = planOfflandLineBookingAdminSql('revoke', manifest, await capture(manifest));
            }
          }
          const before = await allData();
          await pool.query("ALTER TABLE iron_gate.audit_log ADD CONSTRAINT reject_next_audit CHECK ((audit_json->>'requestHash') <> $1)".replace('$1', `'${bundle.plan.requestHash}'`));
          try { await refuse(bundle.applySql, /reject_next_audit/); } finally { await pool.query('ALTER TABLE iron_gate.audit_log DROP CONSTRAINT reject_next_audit'); }
          assert.deepEqual(await allData(), before);
        }
      });

      await t.test('same request key with changed action/body conflicts without changing state', async () => {
        const f = await seed(), { staged, bundle } = await prepareActivation(f);
        const am = { ...f.manifest, requestKey: staged.plan.manifest.requestKey };
        const conflict = planOfflandLineBookingAdminSql('activate', am, await capture(am));
        const before = await allData(); await refuse(conflict.applySql, /IDEMPOTENCY_CONFLICT/);
        assert.deepEqual(await allData(), before);
        await pool.query(bundle.applySql);
        const rm = revokeManifest(f.manifest, 8); rm.requestKey = bundle.plan.manifest.requestKey;
        const revoke = planOfflandLineBookingAdminSql('revoke', rm, await capture(rm));
        const enabled = await allData(); await refuse(revoke.applySql, /IDEMPOTENCY_CONFLICT/);
        assert.deepEqual(await allData(), enabled);
      });

      await t.test('database time rejects delayed snapshot/expiry and recovery remains readable after expiry', async () => {
        const f = await seed(); f.snapshot.capturedAt = future(-15 * 60_000 + 300);
        const old = stage(f); await new Promise(resolve => setTimeout(resolve, 400));
        await refuse(old.applySql, /SNAPSHOT_STALE/);
        const next = await seed(); next.manifest.expiresAt = future(300);
        const expiring = stage(next); await new Promise(resolve => setTimeout(resolve, 400));
        await refuse(expiring.applySql, /CREDENTIAL_EXPIRED/);
        assert.ok(offlandLineBookingReadbackSql(expiring.plan));
      });

      await t.test('fresh revoke works after expiry and later legitimate state/authority changes', async () => {
        const f = await seed(), { bundle } = await prepareActivation(f); await pool.query(bundle.applySql);
        await pool.query("UPDATE iron_gate.credentials SET expires_at=now()-interval '1 day' WHERE credential_id=$1", [f.manifest.credentialId]);
        await pool.query("UPDATE iron_gate.property_state SET inventory_version=9,authority_epoch=2,state_json=jsonb_set(jsonb_set(jsonb_set(state_json,'{version}','9'),'{authorityEpoch}','2'),'{readOnly}','true') WHERE property_id=$1", [f.manifest.propertyId]);
        const before = await allData(), manifest = revokeManifest(f.manifest, 9);
        const revoke = planOfflandLineBookingAdminSql('revoke', manifest, await capture(manifest));
        await pool.query(revoke.applySql);
        assert.equal(verifyOfflandLineBookingCommittedReadback(revoke.plan, await readback(revoke)).active, false);
        const after = await allData();
        assert.deepEqual(after.occupied_room_nights, before.occupied_room_nights);
        assert.deepEqual(after.finance_event, before.finance_event);
        assert.equal(after.property_state.find(p => p.property_id === f.manifest.propertyId).authority_epoch, 2);
      });

      await t.test('post-update state or audit corruption is caught before commit', async () => {
        const f = await seed(), { bundle } = await prepareActivation(f), before = await allData();
        await pool.query(`CREATE FUNCTION iron_gate.synthetic_corrupt_state() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN NEW.state_json:=jsonb_set(NEW.state_json,'{unknownTopLevel,keep}','false'); RETURN NEW; END $$;
          CREATE TRIGGER synthetic_corrupt_state BEFORE UPDATE ON iron_gate.property_state FOR EACH ROW EXECUTE FUNCTION iron_gate.synthetic_corrupt_state();`);
        try { await refuse(bundle.applySql, /READBACK_MISMATCH/); } finally {
          await pool.query('DROP TRIGGER synthetic_corrupt_state ON iron_gate.property_state; DROP FUNCTION iron_gate.synthetic_corrupt_state()');
        }
        assert.deepEqual(await allData(), before);
        await pool.query(`CREATE FUNCTION iron_gate.synthetic_corrupt_audit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN NEW.audit_json:=jsonb_set(NEW.audit_json,'{type}','"corrupted"'); RETURN NEW; END $$;
          CREATE TRIGGER synthetic_corrupt_audit BEFORE INSERT ON iron_gate.audit_log FOR EACH ROW EXECUTE FUNCTION iron_gate.synthetic_corrupt_audit();`);
        try { await refuse(bundle.applySql, /AUDIT_READBACK_MISMATCH/); } finally {
          await pool.query('DROP TRIGGER synthetic_corrupt_audit ON iron_gate.audit_log; DROP FUNCTION iron_gate.synthetic_corrupt_audit()');
        }
        assert.deepEqual(await allData(), before);
      });
    } finally {
      await pool?.end(); await independent?.end();
      if (running) execFileSync(`${pgBin}/pg_ctl`, ['-D', `${directory}/data`, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
      await rm(directory, { recursive: true, force: true });
    }
  });
