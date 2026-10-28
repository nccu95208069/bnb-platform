import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { FinanceCommandService } from '../src/finance-commands.mjs';
import { bookingSnapshotHash, parseHistoricalManifest } from '../src/finance-historical-settlement.mjs';

const secret='synthetic-historical-preview-secret-32-bytes';
const digest=value=>createHash('sha256').update(value).digest('hex');
const propertyId=randomUUID();
const workspaceId=randomUUID();
const connectorId=randomUUID();
const otherPropertyId=randomUUID();
const otherConnectorId=randomUUID();
const bookings=Array.from({length:4},(_,index)=>({
  id:randomUUID(),propertyId,version:index+1,status:'confirmed',source:'external',
  sourceCalendar:null,totalCents:10000+index*1000,currency:'TWD',
  paymentEvents:[],cardChargeResults:[],
}));
const rawManifest={property_id:propertyId,source_instance_id:connectorId,
  full_os_snapshot_hash:digest('os'),owner_decision_hash:digest('owner'),
  sheet_snapshot_hash:digest('sheet'),rows:bookings.map((booking,index)=>({
    booking_id:booking.id,booking_version:booking.version,
    booking_snapshot_hash:bookingSnapshotHash(booking),
    booking_total_cents:booking.totalCents,source_order_key:`order-${index}`,
    source_link_snapshot_hash:digest(`link-${index}`),
    os_receipt_id:`receipt-${index}`,os_receipt_version:'1',
    os_receipt_snapshot_hash:digest(`receipt-${index}`),
    sheet_row_snapshot_hash:digest(`sheet-row-${index}`),
    money_aliases_hash:digest(`aliases-${index}`),
    os_receipt_amount_cents:0,os_settles_room:true,
    decision:index===3?'unpaid_at_cutover':
      'settled_before_cutover_cash_details_unknown',
  }))};
const manifestBytes=Buffer.from(JSON.stringify(rawManifest));
const manifest=parseHistoricalManifest(manifestBytes,digest(manifestBytes));
const principal={origin:'finance',workspaceId,propertyIds:[propertyId],authorityEpoch:1,
  subjectId:'synthetic-reviewer',financeSourceInstanceId:connectorId,
  actions:['finance:import','finance:read']};

function harness() {
  const data={state:{propertyId,workspaceId,authorityEpoch:1,readOnly:false,
    bookings:structuredClone(bookings)},connector:{source_system:'os_manual',enabled:true,
      cutover_at:null},links:new Map(rawManifest.rows.map(row=>
      [row.source_order_key,row.source_link_snapshot_hash])),
    sheetPending:false,overlap:false,dispositions:new Map(),receipts:new Map(),changes:[],
    tamperReadback:false};
  const client={release(){},async query(sql,params=[]) {
    const q=sql.replace(/\s+/g,' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(q) || q.includes("set_config('iron_gate.property_id'"))
      return {rows:[]};
    if (q.includes('FROM iron_gate.property_state'))
      return {rows:params[0]===propertyId ? [{state_json:data.state,
        workspace_id:workspaceId,authority_epoch:1}] : []};
    if (q.includes('FROM iron_gate.finance_connector'))
      return {rows:params[0]===propertyId && params[1]===connectorId ?
        [data.connector] : []};
    if (q.includes('FROM iron_gate.finance_request_receipt rr')) {
      const saved=data.receipts.get(params[2]);
      const disposition=data.dispositions.get(saved?.response_json?.booking_id);
      if (!saved || !disposition) return {rows:[]};
      return {rows:[{response_json:data.tamperReadback ?
        {...saved.response_json,booking_total_cents:1} : saved.response_json,
        ...disposition,change_seq:disposition.change_seq}]};
    }
    if (q.includes('FROM iron_gate.finance_request_receipt')) {
      const saved=data.receipts.get(params[2]);
      return {rows:saved ? [saved] : []};
    }
    if (q.includes('FROM iron_gate.finance_source_link')) {
      if (q.includes('source_order_key<>')) return {rows:[]};
      const expected=data.links.get(params[2]);
      return {rows:expected===params.at(-1) ? [{one:1}] : []};
    }
    if (q.includes('FROM iron_gate.finance_allocation'))
      return {rows:data.overlap ? [{one:1}] : []};
    if (q.includes('FROM iron_gate.finance_payment_ownership') ||
      q.includes('FROM iron_gate.finance_source_alias') ||
      q.includes('FROM iron_gate.finance_document') ||
      q.includes('FROM iron_gate.finance_import_issue') ||
      q.includes('FROM iron_gate.finance_operational_status')) return {rows:[]};
    if (q.includes('FROM iron_gate.finance_legacy_settlement')) {
      if (q.includes('booking_id=ANY'))
        return {rows:[...data.dispositions.values()].some(row=>
          params[1].includes(row.booking_id) &&
          row.decision==='settled_before_cutover_cash_details_unknown') ? [{one:1}] : []};
      if (q.includes('JOIN iron_gate.finance_change c'))
        return {rows:[...data.dispositions.values()].filter(row=>
          row.change_seq<=Number(params[1]))};
      if (q.includes('booking_id=$2') && !q.includes('source_order_key')) {
        const disposition=data.dispositions.get(params[1]);
        return {rows:disposition ? [disposition] : []};
      }
      return {rows:[...data.dispositions.values()].some(row=>
        row.booking_id===params[1] || row.source_order_key===params[3] ||
        row.os_receipt_id===params[4]) ? [{one:1}] : []};
    }
    if (q.includes('FROM iron_gate.finance_outbox'))
      return {rows:data.sheetPending ? [{one:1}] : []};
    if (q.includes('FROM iron_gate.finance_change') && q.includes('MAX(change_seq)'))
      return {rows:[{seq:String(data.changes.length)}]};
    if (q.startsWith('INSERT INTO iron_gate.finance_legacy_settlement')) {
      const row={id:params[0],property_id:params[1],source_instance_id:params[2],
        booking_id:params[3],booking_version:params[4],booking_snapshot_hash:params[5],
        booking_total_cents:params[6],source_order_key:params[7],
        source_link_snapshot_hash:params[8],os_receipt_id:params[9],
        os_receipt_version:params[10],os_receipt_snapshot_hash:params[11],
        os_receipt_amount_cents:params[12],os_settles_room:params[13],
        full_os_snapshot_hash:params[14],owner_decision_hash:params[15],
        sheet_snapshot_hash:params[16],sheet_row_snapshot_hash:params[17],
        money_aliases_hash:params[18],manifest_sha256:params[19],
        decision:params[20],request_key:params[21],reviewed_by_ref:params[22],
        cash_effect_cents:0,change_seq:data.changes.length+1};
      data.dispositions.set(row.booking_id,row);
      return {rows:[]};
    }
    if (q.startsWith('INSERT INTO iron_gate.finance_change')) {
      data.changes.push({change_seq:Number(params[1]),source_id:params[2]});
      return {rows:[]};
    }
    if (q.startsWith('INSERT INTO iron_gate.audit_log')) return {rows:[]};
    if (q.startsWith('INSERT INTO iron_gate.finance_request_receipt')) {
      data.receipts.set(params[2],{request_hash:params[3],
        response_json:JSON.parse(params[4])});
      return {rows:[]};
    }
    if (q.includes('SELECT e.id,e.document_id,e.event_kind')) return {rows:[]};
    throw Error(`UNHANDLED_TEST_SQL: ${q.slice(0,120)}`);
  }};
  const service=new FinanceCommandService({connect:async()=>client},secret,true,manifest);
  const input=index=>({request_key:`hist-${index}`,booking_id:bookings[index].id,
    source_order_key:`order-${index}`,decision:rawManifest.rows[index].decision,
    manifest_sha256:manifest.sha256});
  const preview=async index=>service.historicalSettlementPreview(principal,propertyId,
    input(index),`hist-${index}`);
  const commit=async(index,token)=>service.historicalSettlementCommit(principal,propertyId,
    {...input(index),preview_token:token},`hist-${index}`);
  return {data,service,input,preview,commit};
}

test('external booking historical commit is zero-cash, idempotent and exactly read back',async()=>{
  const h=harness();
  const p=await h.preview(0);
  const accepted=await h.commit(0,p.preview_token);
  assert.equal(accepted.cash_effect_cents,0);
  assert.equal(accepted.as_of_change_seq,1);
  assert.equal(h.data.changes.length,1);
  assert.deepEqual(await h.commit(0,p.preview_token),accepted);
  assert.equal(h.data.changes.length,1);
  const read=await h.service.historicalSettlementReceipt(principal,propertyId,'hist-0');
  assert.equal(read.readback_verified,true);
  assert.equal(read.disposition.booking_snapshot_hash,rawManifest.rows[0].booking_snapshot_hash);
  h.data.tamperReadback=true;
  await assert.rejects(h.service.historicalSettlementReceipt(principal,propertyId,'hist-0'),
    error=>error.code==='READBACK_MISMATCH');
});

test('preview and commit reject scope, changed evidence, unresolved Sheet, competing cash and cutover',async()=>{
  const h=harness();
  const wrongProperty={...principal,propertyIds:[otherPropertyId]};
  await assert.rejects(h.service.historicalSettlementPreview(wrongProperty,propertyId,
    h.input(0),'hist-0'),error=>error.code==='PROPERTY_FORBIDDEN');
  const wrongSource={...principal,financeSourceInstanceId:otherConnectorId};
  await assert.rejects(h.service.historicalSettlementPreview(wrongSource,propertyId,
    h.input(0),'hist-0'),error=>error.code==='HISTORICAL_MANIFEST_FORBIDDEN');
  const noImport={...principal,actions:['finance:read']};
  await assert.rejects(h.service.historicalSettlementPreview(noImport,propertyId,
    h.input(0),'hist-0'),error=>error.code==='PROPERTY_FORBIDDEN');
  const p=await h.preview(0);
  h.data.state.bookings[0].version++;
  await assert.rejects(h.commit(0,p.preview_token),error=>error.code==='VERSION_CONFLICT');
  h.data.state.bookings[0].version--;
  h.data.links.set('order-0',digest('different-link'));
  await assert.rejects(h.preview(0),error=>error.code==='SOURCE_MAPPING_REVIEW_REQUIRED');
  h.data.links.set('order-0',rawManifest.rows[0].source_link_snapshot_hash);
  h.data.sheetPending=true;
  await assert.rejects(h.preview(0),error=>error.code==='SOURCE_MAPPING_REVIEW_REQUIRED');
  h.data.sheetPending=false;
  h.data.overlap=true;
  await assert.rejects(h.preview(0),error=>error.code==='SOURCE_MAPPING_REVIEW_REQUIRED');
  h.data.overlap=false;
  h.data.connector.cutover_at='2026-10-28T00:00:00Z';
  await assert.rejects(h.preview(0),error=>error.code==='SOURCE_FORBIDDEN');
  assert.equal(h.data.dispositions.size,0);
});

test('expired preview and flipped decision fail without a disposition',async()=>{
  const h=harness();
  const p=await h.preview(1);
  const [encoded]=p.preview_token.split('.');
  const claims=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
  claims.expiresAt=0;
  const stale=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token=`${stale}.${createHmac('sha256',secret).update(stale).digest('base64url')}`;
  await assert.rejects(h.commit(1,token),error=>error.code==='VERSION_CONFLICT');
  await assert.rejects(h.service.historicalSettlementCommit(principal,propertyId,
    {...h.input(1),decision:'unpaid_at_cutover',preview_token:p.preview_token},'hist-1'),
  error=>error.code==='SOURCE_MAPPING_REVIEW_REQUIRED');
  assert.equal(h.data.dispositions.size,0);
});

test('bookingFinance keeps A cash summary zero and external D under payer review',async()=>{
  const h=harness();
  for (const index of [0,3]) {
    const p=await h.preview(index);
    await h.commit(index,p.preview_token);
  }
  const reader={...principal,origin:'os'};
  const settled=await h.service.bookingFinance(reader,propertyId,bookings[0].id);
  assert.equal(settled.summary.room_received_cents,0);
  assert.equal(settled.remaining_due_cents,0);
  assert.equal(settled.collection_hold,true);
  assert.equal(settled.historical_cash_detail_missing,true);
  const unpaid=await h.service.bookingFinance(reader,propertyId,bookings[3].id);
  assert.equal(unpaid.remaining_due_cents,null);
  assert.equal(unpaid.collection_hold,false);
  assert.equal(unpaid.historical_cash_detail_missing,false);
  assert.equal(unpaid.review_required,true);
  const before=await h.service.historicalSettlements(reader,propertyId,0);
  assert.equal(before.legacy_settlements.length,0);
  const pinned=await h.service.historicalSettlements(reader,propertyId,1);
  assert.equal(pinned.property_id,propertyId);
  assert.equal(pinned.legacy_settlements.length,1);
  assert.equal(pinned.legacy_settlements[0].source_link_snapshot_hash,
    rawManifest.rows[0].source_link_snapshot_hash);
  const current=await h.service.historicalSettlements(reader,propertyId,2);
  assert.equal(current.legacy_settlements.length,2);
  assert.equal(current.legacy_settlements[1].remaining_due_cents,null);
  assert.equal(current.legacy_settlements[1].review_required,true);
  await assert.rejects(h.service.historicalSettlements(reader,propertyId,3),
    error=>error.code==='VERSION_CONFLICT');
});

test('later finance money command cannot duplicate a historical settled booking',async()=>{
  const h=harness();
  const p=await h.preview(0);
  await h.commit(0,p.preview_token);
  h.data.connector.cutover_at='2026-10-01T00:00:00Z';
  const operator={...principal,origin:'os',
    actions:['finance:read','finance:record_receipt']};
  const money={request_key:'new-cash',source_record_id:'new-cash',source_version:'1',
    action:'create',event_kind:'property_receipt',amount_cents:bookings[0].totalCents,
    currency:'TWD',effective_on:'2026-10-28',cash_on:'2026-10-28',
    receipt_purpose:'room',evidence_level:'operator_attested',
    booking_allocations:[{booking_id:bookings[0].id,
      expected_booking_version:bookings[0].version,allocation_kind:'room',
      amount_cents:bookings[0].totalCents}]};
  const preview=await h.service.preview(operator,propertyId,money,money.request_key);
  await assert.rejects(h.service.command(operator,propertyId,
    {...preview.resolved_command,preview_token:preview.preview_token},money.request_key),
  error=>error.code==='HISTORICAL_SETTLEMENT_REVIEW_REQUIRED');
});
