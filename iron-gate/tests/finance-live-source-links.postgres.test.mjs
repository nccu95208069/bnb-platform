import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { FinanceCommandService } from '../src/finance-commands.mjs';

const enabled = process.env.IRON_GATE_FINANCE_TEST_DATABASE === 'iron_gate_finance_test3';
const config = { host:'/private/tmp', port:Number(process.env.IRON_GATE_FINANCE_TEST_PORT ?? 55432),
  database:'iron_gate_finance_test3' };

test('live booking links support OS and LINE with the same property and evidence guards',
  { skip:!enabled }, async t => {
    const admin = new Pool(config), runtime = new Pool(config);
    const workspaceId = randomUUID(), propertyId = randomUUID(), otherPropertyId = randomUUID();
    const bookingId = randomUUID(), otherBookingId = randomUUID();
    const osId = randomUUID(), lineId = randomUUID(), sheetId = randomUUID(), otherOsId = randomUUID();
    const service = new FinanceCommandService({ connect:async () => {
      const client = await runtime.connect();
      await client.query('SET ROLE iron_gate_runtime');
      return client;
    } }, 'synthetic-live-link-secret-at-least-32-bytes', true);
    const os = { origin:'os', workspaceId, propertyIds:[propertyId], authorityEpoch:1,
      subjectId:'synthetic-operator', financeSourceInstanceId:osId,
      actions:['finance:read','finance:link'] };
    const line = { ...os, origin:'line', financeSourceInstanceId:lineId };
    const otherOs = { ...os, propertyIds:[otherPropertyId], financeSourceInstanceId:otherOsId };
    const state = (id, booking) => ({ propertyId:id, workspaceId, authorityEpoch:1,
      version:1, roomIds:[], readOnly:false, bookings:[{ id:booking, propertyId:id,
        version:1, status:'confirmed', source:'external', sourceCalendar:null,
        totalCents:10000, currency:'TWD', paymentEvents:[] }] });
    const current = state(propertyId,bookingId);
    const input = (key, id = bookingId, version = 1) => ({ request_key:key,
      source_order_key:`${id}:v${version}`, booking_id:id,
      expected_booking_version:version, review_confirmed:true,
      origin_request_hash:'a'.repeat(64) });
    const preview = (principal, raw, property = propertyId) =>
      service.liveSourceLinkPreview(principal,property,raw,raw.request_key);
    const commit = (principal, raw, proof, property = propertyId) =>
      service.liveSourceLinkCommit(principal,property,
        { ...raw, preview_token:proof.preview_token },raw.request_key);
    const rejects = (promise, code) => assert.rejects(promise,error => error.code === code);
    const saveState = () => admin.query(`UPDATE iron_gate.property_state
      SET state_json=$1::jsonb WHERE property_id=$2`,[JSON.stringify(current),propertyId]);
    const counts = async () => (await admin.query(`SELECT
      (SELECT count(*)::int FROM iron_gate.finance_source_link WHERE property_id=$1) AS links,
      (SELECT count(*)::int FROM iron_gate.finance_request_receipt WHERE property_id=$1) AS receipts,
      (SELECT count(*)::int FROM iron_gate.finance_change WHERE property_id=$1) AS changes,
      (SELECT count(*)::int FROM iron_gate.audit_log WHERE property_id=$1) AS audits,
      (SELECT count(*)::int FROM iron_gate.finance_event WHERE property_id=$1) AS money`,
    [propertyId])).rows[0];
    try {
      for (const [id, booking] of [[propertyId,bookingId],[otherPropertyId,otherBookingId]])
        await admin.query(`INSERT INTO iron_gate.property_state
          (property_id,workspace_id,authority_epoch,inventory_version,state_json)
          VALUES ($1,$2,1,1,$3::jsonb)`,[id,workspaceId,JSON.stringify(state(id,booking))]);
      await admin.query(`INSERT INTO iron_gate.finance_write_scope(property_id,mode)
        VALUES ($1,'full'),($2,'full')`,
        [propertyId,otherPropertyId]);
      for (const [id, property, system] of [[osId,propertyId,'os_manual'],
        [lineId,propertyId,'line_finance'],[sheetId,propertyId,'sheet_bulk'],
        [otherOsId,otherPropertyId,'os_manual']])
        await admin.query(`INSERT INTO iron_gate.finance_connector
          (source_instance_id,property_id,source_system,enabled,cutover_at)
          VALUES ($1,$2,$3,true,now()-interval '1 day')`,[id,property,system]);

      await t.test('OS preview is read-only; commit and response recovery are exact',async () => {
        const raw = input('os-exact-link'), before = await counts();
        const proof = await preview(os,raw);
        assert.match(proof.source_snapshot_hash,/^[a-f0-9]{64}$/);
        assert.equal(proof.booking_id,bookingId);
        assert.equal(proof.booking_version,1);
        assert.deepEqual(await counts(),before);
        const result = await commit(os,raw,proof);
        assert.equal(result.receipt_status,'accepted');
        assert.equal(result.cash_effect_cents,0);
        assert.equal(result.source_snapshot_hash,proof.source_snapshot_hash);
        assert.equal(result.origin_request_hash,raw.origin_request_hash);
        assert.deepEqual(await commit(os,raw,proof),result);
        assert.deepEqual(await commit(os,raw,await preview(os,raw)),result);
        assert.deepEqual(await service.receipt(os,propertyId,raw.request_key),result);
        assert.deepEqual(await counts(),{ links:1, receipts:1, changes:1, audits:1, money:0 });
      });

      await t.test('LINE remains supported and request keys cannot cross source or property',async () => {
        const raw = input('os-exact-link');
        await rejects(service.receipt(line,propertyId,raw.request_key),'REQUEST_NOT_FOUND');
        const proof = await preview(line,raw), result = await commit(line,raw,proof);
        assert.equal(result.receipt_status,'accepted');
        const other = input(raw.request_key,otherBookingId);
        await rejects(service.receipt(otherOs,otherPropertyId,raw.request_key),'REQUEST_NOT_FOUND');
        const otherProof = await preview(otherOs,other,otherPropertyId);
        await rejects(commit(otherOs,other,proof,otherPropertyId),'VERSION_CONFLICT');
        assert.equal((await commit(otherOs,other,otherProof,otherPropertyId)).booking_id,otherBookingId);
        const rows = (await service.sourceLinks(os,propertyId)).source_links;
        assert.deepEqual(new Set(rows.map(row=>row.source_instance_id)),new Set([osId,lineId]));
        assert.equal(rows.some(row=>row.booking_id===otherBookingId),false);
      });

      await t.test('property, workspace, action and connector origin remain required',async () => {
        const raw = input('forbidden-link'), proof = await preview(os,raw);
        for (const [principal, code] of [
          [{...os,propertyIds:[otherPropertyId]},'PROPERTY_FORBIDDEN'],
          [{...os,workspaceId:randomUUID()},'PROPERTY_FORBIDDEN'],
          [{...os,actions:['finance:read']},'PROPERTY_FORBIDDEN'],
          [{...os,financeSourceInstanceId:otherOsId},'SOURCE_FORBIDDEN'],
          [{...os,financeSourceInstanceId:sheetId},'SOURCE_FORBIDDEN'],
          [{...os,origin:'line'},'SOURCE_FORBIDDEN'],
          [{...line,origin:'os'},'SOURCE_FORBIDDEN'],
        ]) {
          await rejects(preview(principal,raw),code);
          await rejects(commit(principal,raw,proof),code);
        }
        await rejects(preview(os,raw,otherPropertyId),'PROPERTY_FORBIDDEN');
        await rejects(preview(os,input('foreign-booking',otherBookingId)),'UNKNOWN_BOOKING');
      });

      await t.test('live links require an enabled connector and effective cutover',async () => {
        const raw = input('cutover-link'), proof = await preview(os,raw);
        for (const [active, cutover] of [[false,'2020-01-01'],[true,null],[true,'2099-01-01']]) {
          await admin.query(`UPDATE iron_gate.finance_connector SET enabled=$1,cutover_at=$2,
            version=version+1,updated_at=clock_timestamp() WHERE source_instance_id=$3`,
          [active,cutover,osId]);
          await rejects(preview(os,raw),'SOURCE_FORBIDDEN');
          await rejects(commit(os,raw,proof),'SOURCE_FORBIDDEN');
        }
        await admin.query(`UPDATE iron_gate.finance_connector SET enabled=true,
          cutover_at=now()-interval '1 day',version=version+1,updated_at=clock_timestamp()
          WHERE source_instance_id=$1`,[osId]);
        await rejects(commit({...os,authorityEpoch:2},raw,proof),'AUTHORITY_MOVED');
        current.readOnly=true;
        await saveState();
        await rejects(commit(os,raw,proof),'AUTHORITY_MOVED');
        current.readOnly=false;
        await saveState();
      });

      await t.test('callers cannot fabricate aliases or supply their own snapshot evidence',async () => {
        const raw = input('invalid-link');
        for (const patch of [{source_order_key:'Q:synthetic-order'},
          {source_order_key:`${bookingId}:v2`},{source_snapshot_hash:'f'.repeat(64)},
          {review_confirmed:false},{booking_id:'not-a-uuid'}]) {
          await rejects(preview(os,{...raw,...patch}),'INVALID_INPUT');
          await rejects(commit(os,{...raw,...patch},{preview_token:'invalid'}),'INVALID_INPUT');
        }
        await rejects(preview(os,input('stale-version',bookingId,2)),'VERSION_CONFLICT');
      });

      await t.test('proof binds the actor, source, command and current booking snapshot',async () => {
        const raw = input('proof-link'), proof = await preview(os,raw), before = await counts();
        await rejects(commit({...os,subjectId:'another-operator'},raw,proof),'VERSION_CONFLICT');
        await rejects(commit(line,raw,proof),'VERSION_CONFLICT');
        await rejects(commit(os,{...raw,origin_request_hash:'b'.repeat(64)},proof),'VERSION_CONFLICT');
        current.bookings[0].totalCents=12000;
        await saveState();
        await rejects(commit(os,raw,proof),'VERSION_CONFLICT');
        await rejects(preview(os,raw),'SOURCE_MAPPING_REVIEW_REQUIRED');
        current.bookings[0].version=2;
        await saveState();
        await rejects(commit(os,raw,proof),'VERSION_CONFLICT');
        await rejects(preview(os,raw),'VERSION_CONFLICT');
        assert.deepEqual(await counts(),before);
        const fresh = input('new-booking-version',bookingId,2);
        const freshProof = await preview(os,fresh);
        assert.notEqual(freshProof.source_snapshot_hash,proof.source_snapshot_hash);
        assert.equal((await commit(os,fresh,freshProof)).booking_version,2);
        current.bookings[0].status='cancelled';
        await saveState();
        await rejects(preview(os,input('cancelled-link',bookingId,2)),
          'SOURCE_MAPPING_REVIEW_REQUIRED');
      });
    } finally {
      await runtime.end();
      await admin.end();
    }
  });
