import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {amountFixture} from './airbnb-amount-fixture.mjs';
import {airbnbAmountSql,validateAirbnbAmountManifest,allocateWholeTwd} from '../scripts/reconcile-airbnb-group-amount.mjs';
import {MemoryPropertyRepository} from '../src/memory-repository.ts';
import {IronGateService} from '../src/service.ts';

test('verified five-room allocation conserves gross, fee and net without a receipt',()=>{
 const {manifest}=amountFixture();assert.equal(validateAirbnbAmountManifest(manifest),manifest);
 assert.deepEqual(manifest.targets.map(t=>t.amount.netCents),[471900,401000,418700,418700,233200]);
 assert.deepEqual(allocateWholeTwd(2300000,manifest.targets.map(t=>t.booking.totalCents)),[558400,474600,495500,495500,276000]);
 for(const change of [m=>m.targets.pop(),m=>m.targets[1]=m.targets[0],m=>m.targets[0].amount.netCents++,
  m=>m.targets[0].booking.paymentEvents.push({amountCents:100}),m=>m.targets[0].link.lastAppliedBookingVersion++,
  m=>m.evidence.hostFeeCents++,m=>m.targets[0].amount.privateData='hidden',m=>m.force=true,
  m=>m.targets[0].amount.checkIn='2027-01-02',m=>m.targets[0].amount.groupGrossCents++]){
  const bad=structuredClone(manifest);change(bad);assert.throws(()=>validateAirbnbAmountManifest(bad),/INVALID_AIRBNB_AMOUNT_MANIFEST/);
 }
});

test('money projections keep the original identity and never expose private evidence or invent receipts',async()=>{
 const {state,corrected}=amountFixture(),repository=new MemoryPropertyRepository();repository.seed(corrected);
 const service=new IronGateService(repository),p={clientId:'synthetic',subjectId:'synthetic',origin:'os',
  workspaceId:state.workspaceId,propertyIds:[state.propertyId],authorityEpoch:1,actions:['booking:read','finance:ledger'],fields:['guest_name','money']};
 const raw=await service.directFinanceSnapshot(p,state.propertyId);
 assert.equal(raw.bookings.length,0);assert.equal(raw.sourceAmountReconciliations.length,5);
 assert.doesNotMatch(JSON.stringify(raw),/Synthetic Guest|sweetfunSnapshot|mailEvidence/);
 for(const b of corrected.bookings){const visible=await service.getBooking(p,state.propertyId,b.id);
  assert.equal(visible.totalCents,b.sourceAmountReconciliation.netCents);
  assert.equal(visible.sourceCalendar.sourceOrderRef,b.sweetfunSnapshot.groupKey);
  assert.equal(visible.sourceCalendar.sourceIdentityEnriched,true);assert.equal(visible.paymentSummary.netReceivedCents,0);
  const hidden=await service.getBooking({...p,fields:['guest_name']},state.propertyId,b.id);
  assert.equal(hidden.totalCents,undefined);assert.equal(hidden.sourceAmountReconciliation,undefined);
 }
 await repository.transact(state.propertyId,s=>{s.bookings[0].version++;s.bookings[0].guestName='Updated synthetic guest';});
 assert.equal((await service.getBooking(p,state.propertyId,corrected.bookings[0].id)).sourceCalendar.sourceIdentityEnriched,true);
 await repository.transact(state.propertyId,s=>{s.bookings[0].totalCents++;});
 await assert.rejects(service.directFinanceSnapshot(p,state.propertyId),e=>e.code==='SOURCE_AMOUNT_RECONCILIATION_CONFLICT');
});

const connectionString=process.env.IRON_GATE_IDENTITY_TEST_URL;
test('Postgres amount correction is atomic, rejects drift/replay and changes no receipts or occupancy',
 {skip:!connectionString},async()=>{
 const url=new URL(connectionString);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.equal(url.pathname,'/iron_gate_identity_test');
 const pool=new Pool({connectionString,max:1}),client=await pool.connect();
 const {manifest,state,corrected}=amountFixture();const unrelated={id:randomUUID(),totalCents:1234,paymentEvents:[{amountCents:1234}]};
 state.bookings.push(unrelated);corrected.bookings.push(unrelated);
 try{
  await client.query(`CREATE SCHEMA iron_gate;
  CREATE TABLE iron_gate.property_state(property_id uuid PRIMARY KEY,authority_epoch integer,inventory_version integer,state_json jsonb,updated_at timestamptz);
  CREATE TABLE iron_gate.outbox(event_id uuid PRIMARY KEY,property_id uuid,event_json jsonb);
  CREATE TABLE iron_gate.audit_log(audit_id uuid PRIMARY KEY,property_id uuid,audit_json jsonb);`);
  const reset=async s=>{await client.query('ROLLBACK');await client.query('TRUNCATE iron_gate.property_state,iron_gate.outbox,iron_gate.audit_log');await client.query('INSERT INTO iron_gate.property_state VALUES ($1,1,10,$2,now())',[state.propertyId,s]);};
  const read=async()=>(await client.query('SELECT state_json FROM iron_gate.property_state')).rows[0].state_json;
  await reset(state);await client.query(airbnbAmountSql(manifest));assert.deepEqual(await read(),state);
  for(const change of [s=>s.bookings[4].totalCents++,s=>s.sourceLinks[4].lastAppliedBookingVersion++,
   s=>s.sourceLinks.push(s.sourceLinks[0]),s=>s.bookings[5].sourceCalendar={platform:'airbnb',externalOrderNo:'HMTEST1234'},s=>s.readOnly=true]){
   const drift=structuredClone(state);change(drift);await reset(drift);
   await assert.rejects(client.query(airbnbAmountSql(manifest,false)));await client.query('ROLLBACK');assert.deepEqual(await read(),drift);
   assert.equal((await client.query('SELECT count(*)::int n FROM iron_gate.audit_log')).rows[0].n,0);
  }
  await reset(state);await client.query(airbnbAmountSql(manifest,false));assert.deepEqual(await read(),corrected);
  for(const table of ['audit_log','outbox'])assert.equal((await client.query(`SELECT count(*)::int n FROM iron_gate.${table}`)).rows[0].n,5);
  const audits=(await client.query('SELECT audit_json FROM iron_gate.audit_log')).rows.map(r=>r.audit_json);
  assert.ok(audits.every(a=>a.financialChangeApplied===true&&a.paymentEventsCreated===false&&a.amountDifferenceCents===143500));
  await assert.rejects(client.query(airbnbAmountSql(manifest,false)));await client.query('ROLLBACK');assert.deepEqual(await read(),corrected);
 }finally{await client.query('ROLLBACK');await client.query('DROP SCHEMA IF EXISTS iron_gate CASCADE');client.release();await pool.end();}
});
