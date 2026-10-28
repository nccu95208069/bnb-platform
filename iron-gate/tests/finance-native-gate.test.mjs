import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeFinanceCutover} from '../src/finance-native.mjs';

const propertyId='10000000-0000-4000-8000-000000000001';
const client=(rows,calls)=>({query:async(sql,args)=>{
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
