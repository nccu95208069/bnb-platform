import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { cardFingerprint, cardPaymentId } from '../src/card-sync.ts';
import { NativeCardHistoryService } from '../src/finance-native-history.mjs';

const enabled=process.env.IRON_GATE_FINANCE_TEST_DATABASE==='iron_gate_finance_test3';
const config={host:'/private/tmp',port:Number(process.env.IRON_GATE_FINANCE_TEST_PORT ?? 55432),
  database:'iron_gate_finance_test3'};
const workspaceId='50000000-0000-4000-8000-000000000001';
const propertyId='50000000-0000-4000-8000-000000000002';
const nativeConnector='50000000-0000-4000-8000-000000000003';
const cardConnector='50000000-0000-4000-8000-000000000004';
const osConnector='50000000-0000-4000-8000-000000000005';
const osBookingId='50000000-0000-4000-8000-000000000006';
const cardBookingId='50000000-0000-4000-8000-000000000007';
const osReceiptId='50000000-0000-4000-8000-000000000008';
const osRefundId='50000000-0000-4000-8000-000000000009';
const cardRefundId='50000000-0000-4000-8000-000000000010';
const foreignEventId='50000000-0000-4000-8000-000000000011';
const importActor='synthetic-history-importer';
const sourceActor='synthetic-original-operator';
function payment(id,kind,amount,refundOfEventId=null) {
  return {id,kind,amountCents:amount,currency:'TWD',method:'credit_card',
    evidenceRef:`synthetic:${id}`,occurredAt:'2026-10-27T10:00:00+08:00',
    recordedAt:'2026-10-27T04:00:00Z',actorId:sourceActor,
    ...(refundOfEventId?{refundOfEventId}:{})};
}
function cardResult(status,paymentEventId=null) {
  const source={sheetId:'SyntheticCardSheet',tab:'20261027-20261102',row:2,
    platform:'booking',orderId:'12345678',checkIn:'2026-11-12',checkOut:'2026-11-13',
    amountCents:10000,status,chargeDate:status==='done'?'2026-10-27':null};
  return {...source,fingerprint:cardFingerprint(source),
    recordedAt:'2026-10-27T04:00:00Z',actorId:sourceActor,paymentEventId};
}
function state() {
  const cardId=cardPaymentId(propertyId,cardBookingId);
  return {workspaceId,propertyId,authorityEpoch:1,version:7,readOnly:false,
    roomIds:[],sourceLinks:[],bookings:[
      {id:osBookingId,propertyId,workspaceId,version:3,status:'confirmed',
        source:'os',totalCents:10000,currency:'TWD',paymentEvents:[
          payment(osReceiptId,'received',7000),payment(osRefundId,'refunded',2000,osReceiptId)]},
      {id:cardBookingId,propertyId,workspaceId,version:4,status:'confirmed',
        source:'external',totalCents:10000,currency:'TWD',cardChargeResults:[
          cardResult('fail'),cardResult('done',cardId)],paymentEvents:[
          payment(cardId,'received',10000),payment(cardRefundId,'refunded',3000,cardId)]},
    ]};
}
function principal(sourceId) {
  return {origin:'finance',workspaceId,propertyIds:[propertyId],authorityEpoch:1,
    subjectId:importActor,financeSourceInstanceId:sourceId,actions:['finance:import']};
}
async function setup(admin) {
  await admin.query('TRUNCATE iron_gate.property_state CASCADE');
  await admin.query(`INSERT INTO iron_gate.property_state
    (property_id,workspace_id,authority_epoch,inventory_version,state_json)
    VALUES ($1,$2,1,7,$3::jsonb)`,[propertyId,workspaceId,JSON.stringify(state())]);
  await admin.query(`INSERT INTO iron_gate.finance_connector
    (source_instance_id,property_id,source_system,enabled)
    VALUES ($1,$4,'iron_gate_native',true),($2,$4,'sweetfun_card',true),
      ($3,$4,'os_manual',true)`,[nativeConnector,cardConnector,osConnector,propertyId]);
}

test('W7 imports original Card Done once, Fail as zero, then native receipts/refunds',
  {skip:!enabled},async()=>{
    const admin=new Pool(config),runtime=new Pool(config);
    const service=new NativeCardHistoryService({connect:async()=>{
      const client=await runtime.connect();
      await client.query('SET ROLE iron_gate_runtime');
      return client;
    }});
    try {
      await setup(admin);
      const cardPrincipal=principal(cardConnector),nativePrincipal=principal(nativeConnector);
      const cardPreview=await service.preview(cardPrincipal,propertyId,'sweetfun_card');
      assert.equal(cardPreview.ready,true);
      assert.equal(cardPreview.total_difference_cents,10000);
      assert.deepEqual(cardPreview.records.map(row=>row.status),['missing','missing']);
      await assert.rejects(service.commit(cardPrincipal,propertyId,'sweetfun_card','a'.repeat(64)),
        error=>error.code==='VERSION_CONFLICT');
      const cardImported=await service.commit(cardPrincipal,propertyId,'sweetfun_card',
        cardPreview.preview_hash);
      assert.equal(cardImported.imported,2);
      assert.equal(cardImported.total_difference_cents,0);
      const cardId=cardPaymentId(propertyId,cardBookingId);
      const cardEvents=await admin.query(`SELECT id,event_kind,source_recorded_at,recorded_at
        FROM iron_gate.finance_event
        WHERE property_id=$1 AND document_id=(SELECT id FROM iron_gate.finance_document
          WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3)`,
        [propertyId,cardConnector,cardBookingId]);
      assert.equal(cardEvents.rows.length,1);
      assert.equal(cardEvents.rows[0].id,cardId);
      assert.equal(cardEvents.rows[0].event_kind,'property_receipt');
      assert.equal(cardEvents.rows[0].source_recorded_at.toISOString(),
        '2026-10-27T04:00:00.000Z');
      assert.notEqual(cardEvents.rows[0].recorded_at.toISOString(),
        cardEvents.rows[0].source_recorded_at.toISOString());
      const cardRevisions=await admin.query(`SELECT version,action,actor_ref,source_actor_ref,
        source_recorded_at,created_at
        FROM iron_gate.finance_revision WHERE property_id=$1 ORDER BY version`,[propertyId]);
      assert.deepEqual(cardRevisions.rows.map(row=>row.action),['card_fail','create']);
      assert.ok(cardRevisions.rows.every(row=>row.actor_ref===importActor &&
        row.source_actor_ref.startsWith('ig_actor:') && row.source_actor_ref!==sourceActor));
      assert.ok(cardRevisions.rows.every(row=>
        row.source_recorded_at.toISOString()==='2026-10-27T04:00:00.000Z' &&
        row.created_at.toISOString()!==row.source_recorded_at.toISOString()));
      const alias=await admin.query(`SELECT canonical_document_id FROM iron_gate.finance_source_alias
        WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3`,
        [propertyId,nativeConnector,cardId]);
      assert.equal(alias.rows.length,1);
      const nativePreview=await service.preview(nativePrincipal,propertyId,'iron_gate_native');
      assert.equal(nativePreview.ready,true);
      assert.equal(nativePreview.records.length,3);
      const nativeImported=await service.commit(nativePrincipal,propertyId,'iron_gate_native',
        nativePreview.preview_hash);
      assert.equal(nativeImported.imported,3);
      assert.equal(nativeImported.total_difference_cents,0);
      const original=await admin.query(`SELECT e.id,e.event_kind,e.related_receipt_event_id,
        a.booking_id,o.provider_code FROM iron_gate.finance_event e
        JOIN iron_gate.finance_allocation a ON a.property_id=e.property_id AND a.event_id=e.id
        JOIN iron_gate.finance_payment_ownership o ON o.property_id=e.property_id
          AND o.existing_payment_event_id=e.id
        WHERE e.property_id=$1 ORDER BY e.id`,[propertyId]);
      assert.deepEqual(new Set(original.rows.map(row=>row.id)),
        new Set([cardId,osReceiptId,osRefundId,cardRefundId]));
      assert.equal(original.rows.find(row=>row.id===cardRefundId).related_receipt_event_id,cardId);
      assert.equal(original.rows.find(row=>row.id===cardId).provider_code,'sweetfun_card');
      const nativeTimes=await admin.query(`SELECT r.source_recorded_at AS revision_source_recorded_at,
        r.created_at,e.source_recorded_at AS event_source_recorded_at,e.recorded_at
        FROM iron_gate.finance_revision r JOIN iron_gate.finance_event e
          ON e.property_id=r.property_id AND e.document_id=r.document_id
            AND e.revision_version=r.version
        JOIN iron_gate.finance_document d ON d.property_id=r.property_id AND d.id=r.document_id
        WHERE r.property_id=$1 AND d.source_system='iron_gate_native'`,[propertyId]);
      assert.equal(nativeTimes.rows.length,3);
      assert.ok(nativeTimes.rows.every(row=>
        row.revision_source_recorded_at.toISOString()==='2026-10-27T04:00:00.000Z' &&
        row.event_source_recorded_at.toISOString()==='2026-10-27T04:00:00.000Z' &&
        row.created_at.toISOString()!==row.revision_source_recorded_at.toISOString() &&
        row.recorded_at.toISOString()!==row.event_source_recorded_at.toISOString()));
      const stored=await admin.query(`SELECT state_json FROM iron_gate.property_state
        WHERE property_id=$1`,[propertyId]);
      assert.deepEqual(stored.rows[0].state_json,state());
      const again=await service.preview(nativePrincipal,propertyId,'iron_gate_native');
      assert.equal(again.total_difference_cents,0);
      assert.ok(again.records.every(row=>row.status==='matched'));
      assert.equal((await service.commit(nativePrincipal,propertyId,'iron_gate_native',
        again.preview_hash)).imported,0);
      await admin.query(`UPDATE iron_gate.finance_connector SET cutover_at=now()-interval '1 day',
        version=version+1 WHERE property_id=$1 AND source_instance_id=$2`,
        [propertyId,nativeConnector]);
      await assert.rejects(service.preview(nativePrincipal,propertyId,'iron_gate_native'),
        error=>error.code==='SOURCE_FORBIDDEN');
    } finally {await admin.end();await runtime.end();}
  });

test('W7 blocks unresolved cross-source receipt overlap before any history write',
  {skip:!enabled},async()=>{
    const admin=new Pool(config),runtime=new Pool(config);
    const service=new NativeCardHistoryService(runtime);
    try {
      await setup(admin);
      const documentId='50000000-0000-4000-8000-000000000012';
      await admin.query('BEGIN');
      await admin.query(`INSERT INTO iron_gate.finance_document
        (id,property_id,source_instance_id,source_system,source_record_id,
         kind,current_version,status)
        VALUES ($1,$2,$3,'os_manual','foreign-receipt','money',1,'active')`,
        [documentId,propertyId,osConnector]);
      await admin.query(`INSERT INTO iron_gate.finance_revision
        (property_id,document_id,version,action,request_hash,source_version,actor_ref)
        VALUES ($1,$2,1,'create',$3,'1','synthetic-operator')`,
        [propertyId,documentId,'a'.repeat(64)]);
      await admin.query(`INSERT INTO iron_gate.finance_event
        (id,property_id,document_id,revision_version,event_kind,amount_cents,
         cash_effect_cents,effective_on,cash_on,evidence_level,receipt_purpose,actor_ref)
        VALUES ($1,$2,$3,1,'property_receipt',7000,7000,'2026-10-27',
          '2026-10-27','operator_attested','room','synthetic-operator')`,
        [foreignEventId,propertyId,documentId]);
      await admin.query(`INSERT INTO iron_gate.finance_allocation
        (property_id,event_id,booking_id,amount_cents,allocation_kind)
        VALUES ($1,$2,$3,7000,'room')`,[propertyId,foreignEventId,osBookingId]);
      await admin.query('COMMIT');
      const preview=await service.preview(principal(nativeConnector),propertyId,'iron_gate_native');
      assert.equal(preview.ready,false);
      assert.ok(preview.issues.some(row=>row.code==='CROSS_SOURCE_OVERLAP_UNRESOLVED'));
      await assert.rejects(service.commit(principal(nativeConnector),propertyId,
        'iron_gate_native',preview.preview_hash),
      error=>error.code==='SOURCE_MAPPING_REVIEW_REQUIRED');
      const count=await admin.query(`SELECT count(*)::int AS n FROM iron_gate.finance_document
        WHERE property_id=$1 AND source_system='iron_gate_native'`,[propertyId]);
      assert.equal(count.rows[0].n,0);
    } finally {await admin.end();await runtime.end();}
  });
