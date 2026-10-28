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
      const refundId = crypto.randomUUID();
      const refundInput = { expectedBookingVersion: 2, eventId: refundId,
        kind: 'refunded', amountCents: 4000, currency: 'TWD',
        evidenceRef: 'synthetic-card-refund', occurredAt: '2026-10-28T10:00:00+08:00',
        method: 'credit_card', refundOfEventId: cardResult.paymentEventId };
      const refundKey = crypto.randomUUID();
      const refund = await service.recordPaymentEvent(principal,propertyId,cardBookingId,
        refundKey,refundInput);
      assert.equal(refund.netReceivedCents,6000);
      assert.equal(refund.as_of_change_seq,3);
      assert.deepEqual(await service.recordPaymentEvent(principal,propertyId,cardBookingId,
        refundKey,refundInput),refund);
      const refundLedger = await admin.query(`SELECT e.event_kind,e.amount_cents,
        e.related_receipt_event_id,e.related_receipt_document_id,a.booking_id,
        o.provider_code,o.canonical_document_id
        FROM iron_gate.finance_event e
        JOIN iron_gate.finance_allocation a ON a.property_id=e.property_id AND a.event_id=e.id
        JOIN iron_gate.finance_payment_ownership o ON o.property_id=e.property_id AND
          o.existing_payment_event_id=e.id
        WHERE e.property_id=$1 AND e.id=$2`, [propertyId,refundId]);
      assert.equal(refundLedger.rows.length,1);
      assert.equal(refundLedger.rows[0].event_kind,'property_refund');
      assert.equal(Number(refundLedger.rows[0].amount_cents),4000);
      assert.equal(refundLedger.rows[0].related_receipt_event_id,cardResult.paymentEventId);
      assert.equal(refundLedger.rows[0].related_receipt_document_id,
        alias.rows[0].canonical_document_id);
      assert.equal(refundLedger.rows[0].booking_id,cardBookingId);
      assert.equal(refundLedger.rows[0].provider_code,'iron_gate_native');
      const afterRefund = await admin.query(`SELECT state_json FROM iron_gate.property_state
        WHERE property_id=$1`,[propertyId]);
      const cardBooking = afterRefund.rows[0].state_json.bookings.find(b=>b.id===cardBookingId);
      assert.equal(cardBooking.paymentEvents.length,2);
      assert.equal(cardBooking.paymentEvents[1].refundOfEventId,cardResult.paymentEventId);
      assert.equal(afterRefund.rows[0].state_json.receipts.at(-1).response.as_of_change_seq,3);
      const secondRefund = await service.recordPaymentEvent(principal,propertyId,cardBookingId,
        crypto.randomUUID(),{...refundInput,expectedBookingVersion:3,eventId:crypto.randomUUID(),
          amountCents:1000,evidenceRef:'synthetic-second-card-refund'});
      assert.equal(secondRefund.netReceivedCents,5000);
      assert.equal(secondRefund.as_of_change_seq,4);
      await assert.rejects(service.recordPaymentEvent(principal,propertyId,cardBookingId,
        crypto.randomUUID(),{...refundInput,expectedBookingVersion:4,eventId:crypto.randomUUID(),
          amountCents:6000,evidenceRef:'synthetic-over-refund'}),
      error=>error.code==='REFUND_EXCEEDS_RECEIVED');
      const afterRejected = await admin.query(`SELECT state_json FROM iron_gate.property_state
        WHERE property_id=$1`,[propertyId]);
      assert.equal(afterRejected.rows[0].state_json.bookings.find(b=>b.id===cardBookingId).version,4);
      const changes = await admin.query(`SELECT change_seq,source_kind FROM iron_gate.finance_change
        WHERE property_id=$1 ORDER BY change_seq`,[propertyId]);
      assert.deepEqual(changes.rows.map(row=>Number(row.change_seq)),[1,2,3,4]);
      assert.ok(changes.rows.every(row=>row.source_kind==='document_revision'));
    } finally {
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await runtime.end(); await admin.end();
    }
  });

test('Card cutover writes its native-source alias before the native source cuts over',
  { skip: !enabled }, async () => {
    const admin = new Pool(config), runtime = new Pool(config);
    const rolePool = { connect: async () => {
      const client = await runtime.connect();
      await client.query('SET ROLE iron_gate_runtime');
      return client;
    } };
    const service = new IronGateService(new PostgresPropertyRepository(rolePool,true));
    const cardFirstProperty = '20000000-0000-4000-8000-000000000011';
    const cardFirstBooking = '20000000-0000-4000-8000-000000000012';
    const cardFirstNative = '20000000-0000-4000-8000-000000000013';
    const cardFirstSource = '20000000-0000-4000-8000-000000000014';
    const cardState = state();
    cardState.propertyId = cardFirstProperty;
    cardState.bookings[0] = { ...cardState.bookings[0], id: cardFirstBooking,
      propertyId: cardFirstProperty, source: 'external',
      sourceCalendar: { platform: 'Booking.com', externalOrderNo: '12345678' } };
    try {
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await admin.query(`INSERT INTO iron_gate.property_state
        (property_id,workspace_id,authority_epoch,inventory_version,state_json)
        VALUES ($1,$2,1,1,$3::jsonb)`,
      [cardFirstProperty,workspaceId,JSON.stringify(cardState)]);
      await admin.query(`INSERT INTO iron_gate.finance_connector
        (source_instance_id,property_id,source_system,enabled,cutover_at)
        VALUES ($1,$3,'iron_gate_native',false,now()+interval '1 day'),
               ($2,$3,'sweetfun_card',true,now()-interval '1 day')`,
      [cardFirstNative,cardFirstSource,cardFirstProperty]);
      const result = await service.recordCardSync({ workspaceId,
        propertyIds:[cardFirstProperty], authorityEpoch:1, origin:'finance',
        subjectId:'synthetic-card', clientId:'synthetic-card-client',
        actions:['card:sync'], fields:['money'], financeSourceInstanceId:cardFirstSource },
      cardFirstProperty,crypto.randomUUID(),{ sheetId:CARD_SHEET_ID,
        tab:'20261027-20261102',row:2,platform:'booking',orderId:'12345678',
        checkIn:'2026-11-10',checkOut:'2026-11-11',amountCents:10000,
        status:'done',chargeDate:'2026-10-27',bookingId:cardFirstBooking,
        expectedBookingVersion:1 });
      assert.equal(result.as_of_change_seq,1);
      const alias = await admin.query(`SELECT a.canonical_document_id,d.source_system
        FROM iron_gate.finance_source_alias a JOIN iron_gate.finance_document d
          ON d.property_id=a.property_id AND d.id=a.canonical_document_id
        WHERE a.property_id=$1 AND a.source_instance_id=$2 AND a.source_record_id=$3`,
      [cardFirstProperty,cardFirstNative,result.paymentEventId]);
      assert.equal(alias.rows.length,1);
      assert.equal(alias.rows[0].source_system,'sweetfun_card');
      const native = await admin.query(`SELECT enabled,cutover_at>now() AS future
        FROM iron_gate.finance_connector WHERE property_id=$1 AND source_instance_id=$2`,
      [cardFirstProperty,cardFirstNative]);
      assert.equal(native.rows[0].enabled,false);
      assert.equal(native.rows[0].future,true);
      const refundId=crypto.randomUUID(), refundKey=crypto.randomUUID();
      const refundInput={expectedBookingVersion:2,eventId:refundId,kind:'refunded',
        amountCents:2500,currency:'TWD',evidenceRef:'card-first-refund',
        occurredAt:'2026-10-28T10:00:00+08:00',method:'credit_card',
        refundOfEventId:result.paymentEventId};
      const os={workspaceId,propertyIds:[cardFirstProperty],authorityEpoch:1,
        origin:'os',subjectId:'synthetic-operator',clientId:'synthetic-os',
        actions:['payment:write'],fields:['money'],financeSourceInstanceId:cardFirstNative};
      await assert.rejects(service.recordPaymentEvent(os,cardFirstProperty,cardFirstBooking,
        refundKey,refundInput),error=>error.code==='FINANCE_CONNECTOR_NOT_READY');
      let stored=await admin.query(`SELECT state_json FROM iron_gate.property_state WHERE property_id=$1`,
        [cardFirstProperty]);
      assert.equal(stored.rows[0].state_json.bookings[0].paymentEvents.length,1);
      await admin.query(`UPDATE iron_gate.finance_connector SET enabled=true,
        version=version+1,updated_at=clock_timestamp()
        WHERE property_id=$1 AND source_instance_id=$2`,[cardFirstProperty,cardFirstNative]);
      const refund=await service.recordPaymentEvent(os,cardFirstProperty,cardFirstBooking,
        refundKey,refundInput);
      assert.equal(refund.as_of_change_seq,2);
      assert.equal(refund.netReceivedCents,7500);
      const ledger=await admin.query(`SELECT event_kind,related_receipt_event_id
        FROM iron_gate.finance_event WHERE property_id=$1 AND id=$2`,
      [cardFirstProperty,refundId]);
      assert.equal(ledger.rows.length,1);
      assert.equal(ledger.rows[0].event_kind,'property_refund');
      assert.equal(ledger.rows[0].related_receipt_event_id,result.paymentEventId);
      stored=await admin.query(`SELECT state_json FROM iron_gate.property_state WHERE property_id=$1`,
        [cardFirstProperty]);
      assert.equal(stored.rows[0].state_json.bookings[0].paymentEvents.length,2);
    } finally {
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await runtime.end(); await admin.end();
    }
  });
