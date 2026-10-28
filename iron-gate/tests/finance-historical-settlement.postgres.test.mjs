import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { FinanceCommandService } from '../src/finance-commands.mjs';
import { bookingSnapshotHash, parseHistoricalManifest } from '../src/finance-historical-settlement.mjs';

const enabled=process.env.IRON_GATE_FINANCE_HISTORICAL_TEST_DATABASE===
  'iron_gate_historical_test';
const config={host:'/private/tmp',port:Number(process.env.IRON_GATE_FINANCE_TEST_PORT??55439),
  database:'iron_gate_historical_test'};
const sha=value=>createHash('sha256').update(value).digest('hex');

test('migration 018 accepts four pinned zero-cash dispositions under runtime RLS',
  {skip:!enabled},async()=>{
    const admin=new Pool(config);
    const runtime=new Pool(config);
    const propertyId=randomUUID();
    const workspaceId=randomUUID();
    const connectorId=randomUUID();
    const bookings=Array.from({length:4},(_,index)=>({
      id:randomUUID(),propertyId,version:index+1,status:'confirmed',source:'external',
      sourceCalendar:null,totalCents:10000+index*1000,currency:'TWD',
      paymentEvents:[],cardChargeResults:[],
    }));
    const raw={property_id:propertyId,source_instance_id:connectorId,
      full_os_snapshot_hash:sha('full-os'),owner_decision_hash:sha('owner'),
      sheet_snapshot_hash:sha('sheet'),rows:bookings.map((booking,index)=>({
        booking_id:booking.id,booking_version:booking.version,
        booking_snapshot_hash:bookingSnapshotHash(booking),
        booking_total_cents:booking.totalCents,source_order_key:`synthetic-order-${index}`,
        source_link_snapshot_hash:sha(`source-link-${index}`),
        os_receipt_id:`synthetic-receipt-${index}`,os_receipt_version:'1',
        os_receipt_snapshot_hash:sha(`os-receipt-${index}`),
        sheet_row_snapshot_hash:sha(`sheet-row-${index}`),
        sheet_order_source_version:sha(`sheet-order-version-${index}`),
        money_aliases_hash:sha(`money-aliases-${index}`),
        os_receipt_amount_cents:0,os_settles_room:true,
        decision:index===3?'unpaid_at_cutover':
          'settled_before_cutover_cash_details_unknown',
      }))};
    const bytes=Buffer.from(JSON.stringify(raw));
    const manifest=parseHistoricalManifest(bytes,sha(bytes));
    const state={propertyId,workspaceId,authorityEpoch:1,version:1,
      readOnly:false,roomIds:[],bookings};
    const importer={origin:'finance',workspaceId,propertyIds:[propertyId],
      authorityEpoch:1,subjectId:'synthetic-reviewer',
      financeSourceInstanceId:connectorId,actions:['finance:read','finance:import']};
    const reader={...importer,origin:'os'};
    const service=new FinanceCommandService({connect:async()=>{
      const client=await runtime.connect();
      await client.query('SET ROLE iron_gate_runtime');
      return client;
    }},'synthetic-historical-preview-secret-32-bytes',true,manifest);
    try {
      await admin.query(`INSERT INTO iron_gate.property_state
        (property_id,workspace_id,authority_epoch,inventory_version,state_json)
        VALUES ($1,$2,1,1,$3::jsonb)`,[propertyId,workspaceId,JSON.stringify(state)]);
      await admin.query(`INSERT INTO iron_gate.finance_connector
        (source_instance_id,property_id,source_system,enabled)
        VALUES ($1,$2,'os_manual',true)`,[connectorId,propertyId]);
      for (const row of raw.rows) await admin.query(`INSERT INTO iron_gate.finance_source_link
        (property_id,source_instance_id,source_order_key,booking_id,
         verified_booking_version,source_snapshot_hash,evidence_ref)
        VALUES ($1,$2,$3,$4,$5,$6,'synthetic-evidence')`,
        [propertyId,connectorId,row.source_order_key,row.booking_id,row.booking_version,
          row.source_link_snapshot_hash]);
      for (const index of [0,1,2,3]) {
        const row=raw.rows[index];
        const requestKey=`historical-${index}`;
        const command={request_key:requestKey,booking_id:row.booking_id,
          source_order_key:row.source_order_key,decision:row.decision,
          manifest_sha256:manifest.sha256};
        const preview=await service.historicalSettlementPreview(importer,propertyId,
          command,requestKey);
        const accepted=await service.historicalSettlementCommit(importer,propertyId,
          {...command,preview_token:preview.preview_token},requestKey);
        assert.equal(accepted.cash_effect_cents,0);
        assert.equal(accepted.as_of_change_seq,index+1);
        assert.deepEqual(await service.historicalSettlementCommit(importer,propertyId,
          {...command,preview_token:preview.preview_token},requestKey),accepted);
        const read=await service.historicalSettlementReceipt(importer,propertyId,requestKey);
        assert.equal(read.readback_verified,true);
        assert.equal(read.disposition.os_receipt_snapshot_hash,row.os_receipt_snapshot_hash);
        assert.equal(read.disposition.sheet_order_source_version,
          row.sheet_order_source_version);
      }
      const settled=await service.bookingFinance(reader,propertyId,bookings[0].id);
      assert.equal(settled.summary.room_received_cents,0);
      assert.equal(settled.remaining_due_cents,0);
      assert.equal(settled.historical_cash_detail_missing,true);
      const unpaid=await service.bookingFinance(reader,propertyId,bookings[3].id);
      assert.equal(unpaid.remaining_due_cents,null);
      assert.equal(unpaid.review_required,true);
      const list=await service.historicalSettlements(reader,propertyId,4);
      assert.equal(list.legacy_settlements.length,4);
      assert.equal(list.current_change_seq,4);
      assert.equal(list.legacy_settlements[0].source_link_snapshot_hash,
        raw.rows[0].source_link_snapshot_hash);
      assert.equal(list.legacy_settlements[0].sheet_order_source_version,
        raw.rows[0].sheet_order_source_version);
      await admin.query(`UPDATE iron_gate.finance_connector
        SET cutover_at='2026-10-01T00:00:00Z',version=version+1,updated_at=now()
        WHERE property_id=$1 AND source_instance_id=$2`,[propertyId,connectorId]);
      const liveOperator={...importer,origin:'os',actions:['finance:status']};
      const contradicted={request_key:'contradicted-live-status',
        source_record_id:'contradicted-live-status',version:1,
        status_code:'room_confirmed',settles_room:true,
        booking_id:bookings[3].id,expected_booking_version:bookings[3].version};
      await assert.rejects(service.statusCommand(liveOperator,propertyId,
        contradicted,contradicted.request_key),
      error=>error.code==='HISTORICAL_SETTLEMENT_REVIEW_REQUIRED');
      await admin.query(`UPDATE iron_gate.finance_connector
        SET source_system='os_legacy_payment',cutover_at=NULL,
          version=version+1,updated_at=now()
        WHERE property_id=$1 AND source_instance_id=$2`,[propertyId,connectorId]);
      const imported={...contradicted,request_key:'contradicted-import-status',
        source_record_id:'contradicted-import-status',
        source_order_key:raw.rows[3].source_order_key,
        source_snapshot_hash:raw.rows[3].source_link_snapshot_hash,
        origin_request_hash:sha('status-request'),origin_source_version:'1',
        source_actor_ref:`os_actor:${sha('actor')}`,
        source_recorded_at:'2026-10-28T00:00:00.000Z'};
      await assert.rejects(service.statusCommand(importer,propertyId,
        imported,imported.request_key,true),
      error=>error.code==='HISTORICAL_SETTLEMENT_REVIEW_REQUIRED');
      const statuses=await admin.query(`SELECT count(*)::int AS count
        FROM iron_gate.finance_operational_status WHERE property_id=$1`,[propertyId]);
      assert.equal(statuses.rows[0].count,0);
      const cash=await admin.query(`SELECT count(*)::int AS events FROM iron_gate.finance_event
        WHERE property_id=$1`,[propertyId]);
      assert.equal(cash.rows[0].events,0);
      const totals=await admin.query(`SELECT sum(cash_effect_cents)::bigint AS total
        FROM iron_gate.finance_legacy_settlement WHERE property_id=$1`,[propertyId]);
      assert.equal(Number(totals.rows[0].total),0);
    } finally {
      await runtime.end();
      await admin.end();
    }
  });
