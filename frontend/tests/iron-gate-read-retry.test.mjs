import assert from 'node:assert/strict';
import test from 'node:test';
import {callIronGate} from '../src/lib/booking-sources/iron-gate-manual.server.ts';

const grant={credentialId:'11111111-1111-4111-8111-111111111111',
  clientId:'22222222-2222-4222-8222-222222222222',
  workspaceId:'33333333-3333-4333-8333-333333333333',
  propertyId:'44444444-4444-4444-8444-444444444444',token:'x'.repeat(43)};
const config={grant,calendar:{propertyKey:'offland',
  baseUrl:'https://iron-gate.example',proofSecret:'synthetic-proof-secret-long-enough'}};
const actor={id:'synthetic-owner',role:'owner',allProperties:false,
  propertyIds:['offland'],viewPrices:true};
const path=`/v1/properties/${grant.propertyId}/finance/ledger`;
const call=(method,send)=>callIronGate(config,actor,method,path,null,null,send,
  ['finance:read'],['money'],512*1024);
const claim=init=>JSON.parse(Buffer.from(init.headers['x-iron-gate-os-proof'].split('.')[0],
  'base64url').toString('utf8'));

test('one retried GET signs a fresh proof after an expired authorization',async()=>{
  const original=Date.now;let now=100_000,calls=0;
  Date.now=()=>now;
  try{
    const result=await call('GET',async(_url,init)=>{
      const proof=claim(init);calls++;
      assert.equal(proof.issuedAtMs,now);
      assert.equal(proof.expiresAtMs,now+5000);
      if(calls===1){now+=6000;return Response.json({error:{code:'UNAUTHORIZED'}},{status:401});}
      return Response.json({ok:true});
    });
    assert.deepEqual(result,{ok:true});assert.equal(calls,2);
  }finally{Date.now=original;}
});

test('GET transport failure retries once, then an unavailable read stays closed',async()=>{
  let calls=0;
  const result=await call('GET',async()=>{
    if(++calls===1)throw Error('transient network failure');
    return Response.json({ok:true});
  });
  assert.deepEqual(result,{ok:true});assert.equal(calls,2);
  calls=0;
  await assert.rejects(()=>call('GET',async()=>{calls++;throw Error('offline');}),
    /MANUAL_READ_UNAVAILABLE/);
  assert.equal(calls,2);
});

test('authorization retry is bounded and other read denials do not retry',async()=>{
  let calls=0;
  await assert.rejects(()=>call('GET',async()=>{
    calls++;return Response.json({error:{code:'UNAUTHORIZED'}},{status:401});
  }),/UNAUTHORIZED/);
  assert.equal(calls,2);
  calls=0;
  await assert.rejects(()=>call('GET',async()=>{
    calls++;return Response.json({error:{code:'FORBIDDEN'}},{status:403});
  }),/FORBIDDEN/);
  assert.equal(calls,1);
});

test('a POST never retries, even after an authorization rejection',async()=>{
  let calls=0;
  await assert.rejects(()=>call('POST',async()=>{
    calls++;return Response.json({error:{code:'UNAUTHORIZED'}},{status:401});
  }),/UNAUTHORIZED/);
  assert.equal(calls,1);
});
