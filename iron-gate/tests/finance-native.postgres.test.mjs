import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { IronGateService } from '../src/service.ts';
import { PostgresPropertyRepository } from '../src/postgres-repository.mjs';
import { CARD_SHEET_ID } from '../src/card-sync.ts';

const enabled = process.env.IRON_GATE_FINANCE_TEST_DATABASE === 'iron_gate_finance_test3';
const config = { host: '/private/tmp',
  port: Number(process.env.IRON_GATE_FINANCE_TEST_PORT ?? 55432),
  database: 'iron_gate_finance_test3' };
const workspaceId = '20000000-0000-4000-8000-000000000001';
const propertyId = '20000000-0000-4000-8000-000000000002';
const bookingId = '20000000-0000-4000-8000-000000000003';
const nativeConnector = '20000000-0000-4000-8000-000000000004';
const cardConnector = '20000000-0000-4000-8000-000000000005';
const roomId = '20000000-0000-4000-8000-000000000006';
const cardBookingId = '20000000-0000-4000-8000-000000000007';
const legacyPropertyId = '20000000-0000-4000-8000-000000000008';
const legacyBookingId = '20000000-0000-4000-8000-000000000009';
const legacyConnector = '20000000-0000-4000-8000-000000000010';
function state() {
  return { workspaceId, propertyId, roomIds: [roomId], version: 1, authorityEpoch: 1,
    channel: { mode: 'none', ready: false, websiteSalesEnabled: false,
      grantId: null, websiteBindingId: null }, sourceGrants: [], sourceLinks: [],
    operations: [], fences: [], manualBlocks: [], receipts: [], bookings: [{
      id: bookingId, propertyId, workspaceId, version: 1, status: 'confirmed',
      channelSyncState: 'verified', channelOperationKey: null, source: 'os',
      sourceKey: null, stays: [{ checkIn: '2026-11-10', checkOut: '2026-11-11', roomIds: [roomId] }],
      guestName: 'Synthetic', contact: null, notes: null, totalCents: 10000,
      currency: 'TWD', bookedAt: null, createdAt: '2026-10-27T00:00:00Z',
      sourceCalendar: null }] };
}

test('native payment commits its legacy booking projection and new ledger in one transaction',
  { skip: !enabled }, async () => {
    const admin = new Pool(config), runtime = new Pool(config);
    const rolePool = { connect: async () => {
      const client = await runtime.connect();
      await client.query('SET ROLE iron_gate_runtime');
      return client;
    } };
    const repo = new PostgresPropertyRepository(rolePool, true);
    const service = new IronGateService(repo);
    const principal = { workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
      origin: 'os', subjectId: 'synthetic-operator', clientId: 'synthetic-os',
      actions: ['payment:write'], fields: ['money'],
      financeSourceInstanceId:nativeConnector };
    try {
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await admin.query(`INSERT INTO iron_gate.property_state
        (property_id,workspace_id,authority_epoch,inventory_version,state_json)
        VALUES ($1,$2,1,1,$3::jsonb)`, [propertyId,workspaceId,JSON.stringify(state())]);
      await admin.query(`INSERT INTO iron_gate.finance_connector
        (source_instance_id,property_id,source_system,enabled,cutover_at)
        VALUES ($1,$3,'iron_gate_native',true,now()-interval '1 day'),
               ($2,$3,'sweetfun_card',true,now()-interval '1 day')`,
      [nativeConnector,cardConnector,propertyId]);
      const legacyState=state();
      legacyState.propertyId=legacyPropertyId;
      legacyState.bookings[0].id=legacyBookingId;
      legacyState.bookings[0].propertyId=legacyPropertyId;
      await admin.query(`INSERT INTO iron_gate.property_state
        (property_id,workspace_id,authority_epoch,inventory_version,state_json)
        VALUES ($1,$2,1,1,$3::jsonb)`,
      [legacyPropertyId,workspaceId,JSON.stringify(legacyState)]);
      await admin.query(`INSERT INTO iron_gate.finance_connector
        (source_instance_id,property_id,source_system,enabled,cutover_at)
        VALUES ($1,$2,'iron_gate_native',true,now()+interval '1 day')`,
      [legacyConnector,legacyPropertyId]);
      const legacyEventId=crypto.randomUUID();
      const legacyResult=await service.recordPaymentEvent({...principal,
        propertyIds:[legacyPropertyId],financeSourceInstanceId:legacyConnector},
      legacyPropertyId,legacyBookingId,crypto.randomUUID(),{
        expectedBookingVersion:1,eventId:legacyEventId,kind:'received',
        amountCents:1000,currency:'TWD',evidenceRef:'legacy-source-proof',
        occurredAt:'2026-10-27T10:00:00+08:00',method:'cash'});
      assert.equal(legacyResult.paymentEventId,legacyEventId);
      assert.equal(legacyResult.as_of_change_seq,undefined);
      const legacyLedger=await admin.query(`SELECT id FROM iron_gate.finance_event
        WHERE property_id=$1`,[legacyPropertyId]);
      assert.equal(legacyLedger.rows.length,0);
      const legacyProjection=await admin.query(`SELECT state_json FROM iron_gate.property_state
        WHERE property_id=$1`,[legacyPropertyId]);
      assert.equal(legacyProjection.rows[0].state_json.bookings[0].paymentEvents.length,1);
      const paymentEventId = crypto.randomUUID();
      const input = { expectedBookingVersion: 1, eventId: paymentEventId,
        kind: 'received', amountCents: 3000, currency: 'TWD',
        evidenceRef: 'synthetic-provider-ref', occurredAt: '2026-10-27T10:00:00+08:00',
        method: 'bank_transfer' };
      const result = await service.recordPaymentEvent(principal,propertyId,bookingId,
        crypto.randomUUID(),input);
      assert.equal(result.paymentEventId,paymentEventId);
      assert.equal(result.as_of_change_seq,1);
      let rows = await admin.query(`SELECT event_kind,amount_cents FROM iron_gate.finance_event
        WHERE property_id=$1 AND id=$2`, [propertyId,paymentEventId]);
      assert.equal(rows.rows[0].event_kind,'property_receipt');
      assert.equal(Number(rows.rows[0].amount_cents),3000);
      let stored = await admin.query(`SELECT state_json FROM iron_gate.property_state WHERE property_id=$1`,
        [propertyId]);
      assert.equal(stored.rows[0].state_json.bookings[0].paymentEvents.length,1);
      assert.equal(stored.rows[0].state_json.receipts[0].response.as_of_change_seq,1);
      const runtimeOff=new IronGateService(new PostgresPropertyRepository(rolePool,false));
      await assert.rejects(runtimeOff.recordPaymentEvent(principal,propertyId,bookingId,
        crypto.randomUUID(),{...input,expectedBookingVersion:2,eventId:crypto.randomUUID(),
          evidenceRef:'runtime-off-proof'}),
      error=>error.code==='FINANCE_NATIVE_LEDGER_DISABLED');
      stored = await admin.query(`SELECT state_json FROM iron_gate.property_state WHERE property_id=$1`,
        [propertyId]);
      assert.equal(stored.rows[0].state_json.bookings[0].paymentEvents.length,1);
      const noConnector = await admin.query(`UPDATE iron_gate.finance_connector SET enabled=false,
        version=version+1,updated_at=clock_timestamp()
        WHERE property_id=$1 AND source_instance_id=$2`, [propertyId,nativeConnector]);
      assert.equal(noConnector.rowCount,1);
      await assert.rejects(service.recordPaymentEvent(principal,propertyId,bookingId,
        crypto.randomUUID(),{...input,expectedBookingVersion:2,eventId:crypto.randomUUID(),
          evidenceRef:'another-ref'}), e => e.code === 'FINANCE_CONNECTOR_NOT_READY');
      stored = await admin.query(`SELECT state_json FROM iron_gate.property_state WHERE property_id=$1`,
        [propertyId]);
      assert.equal(stored.rows[0].state_json.bookings[0].paymentEvents.length,1);
      await admin.query(`UPDATE iron_gate.finance_connector SET enabled=true,
        version=version+1,updated_at=clock_timestamp()
        WHERE property_id=$1 AND source_instance_id=$2`, [propertyId,nativeConnector]);
      const cardState = stored.rows[0].state_json;
      cardState.bookings.push({ ...cardState.bookings[0], id: cardBookingId,
        version: 1, source: 'external', totalCents: 10000, paymentEvents: [],
        stays: [{ checkIn: '2026-11-12', checkOut: '2026-11-13', roomIds: [roomId] }],
        sourceCalendar: { platform: 'Booking.com', externalOrderNo: '12345678' } });
      await admin.query(`UPDATE iron_gate.property_state SET state_json=$1::jsonb
        WHERE property_id=$2`, [JSON.stringify(cardState),propertyId]);
      const cardPrincipal = { ...principal, origin: 'finance', actions: ['card:sync'],
        financeSourceInstanceId:cardConnector };
      const cardInput = { sheetId: CARD_SHEET_ID, tab: '20261027-20261102', row: 2,
        platform: 'booking', orderId: '12345678', checkIn: '2026-11-12',
        checkOut: '2026-11-13', amountCents: 10000, status: 'done',
        chargeDate: '2026-10-27', bookingId: cardBookingId, expectedBookingVersion: 1 };
      const cardResult = await service.recordCardSync(cardPrincipal,propertyId,
        crypto.randomUUID(),cardInput);
      assert.equal(cardResult.bookingId,cardBookingId);
      assert.equal(cardResult.as_of_change_seq,2);
      rows = await admin.query(`SELECT e.event_kind,a.booking_id FROM iron_gate.finance_event e
        JOIN iron_gate.finance_allocation a ON a.property_id=e.property_id AND a.event_id=e.id
        WHERE e.property_id=$1 AND e.id=$2`, [propertyId,cardResult.paymentEventId]);
      assert.equal(rows.rows[0].event_kind,'property_receipt');
      assert.equal(rows.rows[0].booking_id,cardBookingId);
      const alias = await admin.query(`SELECT canonical_document_id FROM iron_gate.finance_source_alias
        WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3`,
        [propertyId,nativeConnector,cardResult.paymentEventId]);
      assert.equal(alias.rows.length,1);
      const changes = await admin.query(`SELECT change_seq,source_kind FROM iron_gate.finance_change
        WHERE property_id=$1 ORDER BY change_seq`,[propertyId]);
      assert.deepEqual(changes.rows.map(row=>Number(row.change_seq)),[1,2]);
      assert.ok(changes.rows.every(row=>row.source_kind==='document_revision'));
    } finally {
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await runtime.end(); await admin.end();
    }
  });
