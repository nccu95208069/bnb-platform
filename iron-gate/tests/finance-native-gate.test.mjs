import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeFinanceCutover} from '../src/finance-native.mjs';

const propertyId='10000000-0000-4000-8000-000000000001';
const client=(rows,calls,tableExists=true)=>({query:async(sql,args)=>{
  if (sql.includes('to_regclass')) return {rows:[{connector:tableExists ? 'iron_gate.finance_connector' : null}]};
  assert.match(sql,/property_id=\$1 AND source_system=\$2/);
  assert.match(sql,/cutover_at<=now\(\)/);
  calls.push(args);
  return {rows};
}});

test('native and Card cutovers are checked for the exact property and source',async()=>{
  const calls=[];
  assert.equal(await nativeFinanceCutover(client([],calls),propertyId,'payment',true),false);
  assert.equal(await nativeFinanceCutover(client([{enabled:true}],calls),propertyId,
    'card',true),true);
  assert.deepEqual(calls,[[propertyId,'iron_gate_native'],
    [propertyId,'sweetfun_card']]);
});

test('the legacy writer remains available before the connector migration',async()=>{
  const calls=[];
  assert.equal(await nativeFinanceCutover(client([],calls,false),propertyId,
    'payment',false),false);
  assert.deepEqual(calls,[]);
});

test('an effective cutover fails closed if the connector or runtime is disabled',async()=>{
  await assert.rejects(nativeFinanceCutover(client([{enabled:false}],[]),propertyId,
    'payment',true),error=>error.code==='FINANCE_CONNECTOR_NOT_READY');
  await assert.rejects(nativeFinanceCutover(client([{enabled:true}],[]),propertyId,
    'card',false),error=>error.code==='FINANCE_NATIVE_LEDGER_DISABLED');
  await assert.rejects(nativeFinanceCutover(client([{enabled:true},{enabled:true}],[]),
    propertyId,'payment',true),error=>error.code==='FINANCE_CONNECTOR_NOT_READY');
  await assert.rejects(nativeFinanceCutover(client([],[]),propertyId,'unknown',true),
    error=>error.code==='FINANCE_NATIVE_INTENT_INVALID');
});

test('external Card refunds require a ledger path when the finance schema exists',async()=>{
  const refund={type:'payment',bookingSource:'external',kind:'refunded'};
  const sourceClient=(rows,tableExists=true)=>({query:async(sql,args)=>{
    if (sql.includes('to_regclass')) return {rows:[{connector:tableExists ?
      'iron_gate.finance_connector' : null}]};
    assert.match(sql,/source_system IN \('iron_gate_native','sweetfun_card'\)/);
    assert.deepEqual(args,[propertyId]);
    return {rows};
  }});
  assert.equal(await nativeFinanceCutover(sourceClient([
    {source_system:'sweetfun_card',enabled:true}]),propertyId,refund,true),true);
  assert.equal(await nativeFinanceCutover(sourceClient([
    {source_system:'iron_gate_native',enabled:true}]),propertyId,refund,true),true);
  assert.equal(await nativeFinanceCutover(sourceClient([],false),propertyId,refund,false),false);
  await assert.rejects(nativeFinanceCutover(sourceClient([]),propertyId,refund,true),
    error=>error.code==='SOURCE_MAPPING_REVIEW_REQUIRED');
  await assert.rejects(nativeFinanceCutover(sourceClient([
    {source_system:'sweetfun_card',enabled:true}]),propertyId,refund,false),
  error=>error.code==='FINANCE_NATIVE_LEDGER_DISABLED');
  await assert.rejects(nativeFinanceCutover(sourceClient([
    {source_system:'iron_gate_native',enabled:false},
    {source_system:'sweetfun_card',enabled:true}]),propertyId,refund,true),
  error=>error.code==='FINANCE_CONNECTOR_NOT_READY');
});
