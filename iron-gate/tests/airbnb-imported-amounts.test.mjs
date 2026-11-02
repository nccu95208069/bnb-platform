import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {importedAmountFixture} from './airbnb-imported-amount-fixture.mjs';
import {validateImportedAmounts,importedAmountSql} from '../scripts/reconcile-airbnb-imported-amounts.mjs';
import {reconciledAmount,reconciledFinanceAmounts} from '../src/source-amount-reconciliation.ts';
import {MemoryPropertyRepository} from '../src/memory-repository.ts';
import {IronGateService} from '../src/service.ts';
import {createHandler} from '../src/http.ts';
const principal=state=>({clientId:'synthetic',subjectId:'synthetic',origin:'os',workspaceId:state.workspaceId,
 propertyIds:[state.propertyId],authorityEpoch:1,actions:['booking:read'],fields:['guest_name','money']});

test('multi-night corrections conserve amounts and reject partial groups, conflicting identity, unexpected money and drift',()=>{
 for(const property of ['sweetfun','offland']){
  const {manifest,corrected}=importedAmountFixture({property});assert.equal(validateImportedAmounts(manifest),manifest);
  assert.equal(reconciledFinanceAmounts(corrected.bookings).length,corrected.bookings.length);
  for(const change of [m=>m.properties[0].groups[0].targets.pop(),m=>m.properties[0].groups[0].targets[0].amount.groupNetCents++,
   m=>m.properties[0].groups[0].targets[0].booking.paymentEvents.push({amountCents:100}),m=>m.properties[0].groups[0].targets[0].link.lastAppliedBookingVersion++,
   m=>m.properties[0].groups[0].targets[0].amount.roomId=crypto.randomUUID(),m=>m.properties[0].groups[0].evidence.hostFeeCents++,
   m=>m.properties[0].groups[0].targets[0].booking[`${property}Snapshot`].rows[0].values[property==='sweetfun'?13:16]='HMOTHER123',
   m=>m.properties[0].groups[0].targets[0].amount.untrustedField='secret',m=>m.properties[0].groups[0].targets[0].booking.osDirectOverride=true]){
   const bad=structuredClone(manifest);change(bad);assert.throws(()=>validateImportedAmounts(bad),/INVALID_AIRBNB_IMPORTED_AMOUNT_MANIFEST/);
  }
  const partial=structuredClone(corrected.bookings);partial.pop();assert.throws(()=>reconciledFinanceAmounts(partial));
  const old=structuredClone(corrected.bookings[0]);old.totalCents++;assert.throws(()=>reconciledAmount(old));
 }
});

test('signed read endpoint and calendar expose corrected multi-night values with stable legacy IDs and zero receipts',async()=>{
 for(const property of ['sweetfun','offland']){
  const {corrected,state}=importedAmountFixture({property});const repo=new MemoryPropertyRepository();repo.seed(corrected);
  const service=new IronGateService(repo),p=principal(state),handler=createHandler(service,async()=>p);
  const res=await handler(new Request(`https://ig.test/v1/properties/${state.propertyId}/source-amount-snapshot`));assert.equal(res.status,200);
  const snapshot=await res.json();assert.equal(snapshot.sourceAmountReconciliations.length,corrected.bookings.length);
  assert.doesNotMatch(JSON.stringify(snapshot),/Synthetic Guest|sweetfunSnapshot|offlandSnapshot|paymentEvents/);
  for(const b of corrected.bookings){
   const raw=await service.getBooking(p,state.propertyId,b.id);assert.equal(raw.totalCents,b.totalCents);
   assert.equal(raw.sourceCalendar.sourceOrderRef,b.sourceAmountReconciliation.sourceOrderRef);
   assert.equal(raw.sourceCalendar.sourceIdentityEnriched,true);assert.equal(raw.paymentSummary.netReceivedCents,0);
  }
  const hidden=await service.calendarSnapshot({...p,fields:['guest_name']},state.propertyId,'2026-01-01','2026-01-03');
  assert.ok(hidden.bookings.every(b=>b.totalCents===undefined&&b.sourceAmountReconciliation===undefined));
  for(const patch of [{fields:['guest_name']},{actions:[]},{origin:'line'},{propertyIds:[]},{authorityEpoch:2}])
   await assert.rejects(service.sourceAmountSnapshot({...p,...patch},state.propertyId));
 }
});

test('historical cancellation zeroes receivable and removes local occupancy without a refund or channel operation',async()=>{
 const {manifest,corrected,state}=importedAmountFixture({property:'offland',nights:1,rooms:1,cancelled:true});validateImportedAmounts(manifest);
 const repo=new MemoryPropertyRepository();repo.seed(corrected);const service=new IronGateService(repo);
 const snapshot=await service.sourceAmountSnapshot(principal(state),state.propertyId);assert.equal(snapshot.sourceAmountReconciliations[0].status,'cancelled');
 assert.equal(snapshot.sourceAmountReconciliations[0].netCents,0);
 const calendar=await service.calendarSnapshot(principal(state),state.propertyId,'2026-01-01','2026-01-02');assert.equal(calendar.bookings.length,0);
 assert.deepEqual(corrected.bookings[0].paymentEvents,[]);assert.deepEqual(corrected.operations,state.operations);assert.deepEqual(corrected.fences,state.fences);
});

const connectionString=process.env.IRON_GATE_IDENTITY_TEST_URL;
test('Postgres sweep is atomic across properties, preserves source evidence/receipts and rejects replay or late-target drift',{skip:!connectionString},async()=>{
 const url=new URL(connectionString);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.equal(url.pathname,'/iron_gate_identity_test');
 const pool=new Pool({connectionString,max:1}),c=await pool.connect();
 const a=importedAmountFixture(),b=importedAmountFixture({property:'offland',nights:1,rooms:1,cancelled:true});
 const m={schema:2,requestKey:crypto.randomUUID(),properties:[...a.manifest.properties,...b.manifest.properties]};
 try{
  await c.query('CREATE SCHEMA iron_gate; CREATE TABLE iron_gate.property_state(property_id uuid PRIMARY KEY,authority_epoch integer,inventory_version integer,state_json jsonb,updated_at timestamptz); CREATE TABLE iron_gate.outbox(event_id uuid PRIMARY KEY,property_id uuid,event_json jsonb); CREATE TABLE iron_gate.audit_log(audit_id uuid PRIMARY KEY,property_id uuid,audit_json jsonb);');
  const reset=async()=>{await c.query('ROLLBACK');await c.query('TRUNCATE iron_gate.property_state,iron_gate.outbox,iron_gate.audit_log');for(const f of [a,b])await c.query('INSERT INTO iron_gate.property_state VALUES($1,1,10,$2,now())',[f.state.propertyId,f.state]);};
  const read=async id=>(await c.query('SELECT state_json FROM iron_gate.property_state WHERE property_id=$1',[id])).rows[0].state_json;
  await reset();await c.query(importedAmountSql(m));for(const f of [a,b])assert.deepEqual(await read(f.state.propertyId),f.state);
  await c.query("UPDATE iron_gate.property_state SET state_json=jsonb_set(state_json,'{bookings,0,version}','2') WHERE property_id=$1",[a.state.propertyId]);
  await assert.rejects(c.query(importedAmountSql(m,false)));await c.query('ROLLBACK');assert.deepEqual(await read(b.state.propertyId),b.state);
  assert.equal((await c.query('SELECT count(*)::int n FROM iron_gate.audit_log')).rows[0].n,0);
  await reset();await c.query(importedAmountSql(m,false));for(const f of [a,b])assert.deepEqual(await read(f.state.propertyId),f.corrected);
  const logs=(await c.query('SELECT audit_json FROM iron_gate.audit_log')).rows.map(r=>r.audit_json);assert.equal(logs.length,5);assert.ok(logs.every(l=>l.paymentEventsCreated===false));
  await assert.rejects(c.query(importedAmountSql(m,false)));await c.query('ROLLBACK');for(const f of [a,b])assert.deepEqual(await read(f.state.propertyId),f.corrected);
 }finally{await c.query('ROLLBACK');await c.query('DROP SCHEMA IF EXISTS iron_gate CASCADE');c.release();await pool.end();}
});
