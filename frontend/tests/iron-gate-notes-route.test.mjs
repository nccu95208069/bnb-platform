import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET } from '../src/app/api/v1/bookings/[bookingId]/notes/route.ts';
import { createMemberSession, MEMBER_COOKIE } from '../src/lib/workspace-auth/session.ts';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
const workspaceId='11111111-1111-4111-8111-111111111111',bookingId='66666666-6666-4666-8666-666666666666';
const ids={sweetfun:'22222222-2222-4222-8222-222222222222',offland:'22222222-2222-4222-8222-222222222223'},secret='synthetic-note-proof-secret-32-bytes-long';
const grant=property=>({credentialId:property==='sweetfun'?'33333333-3333-4333-8333-333333333333':'33333333-3333-4333-8333-333333333334',clientId:'44444444-4444-4444-8444-444444444444',workspaceId,propertyId:ids[property],token:'a'.repeat(43)});
const rooms=Object.fromEntries(['101','102','201','202','301','302'].map((x,i)=>[x,`55555555-5555-4555-8555-55555555555${i}`]));
test('notes endpoint checks sessions, roles, property and response identity; only notes leave the server',async t=>{
 const original={...process.env};t.after(()=>{for(const k of Object.keys(process.env))if(!(k in original))delete process.env[k];Object.assign(process.env,original)});
 Object.assign(process.env,{CALENDAR_SOURCE:'sheet_snapshot',CALENDAR_OWNER_CODE_HASH:'a'.repeat(64),CALENDAR_OWNER_SESSION_SECRET:'b'.repeat(64),KV_REST_API_URL:'https://fixture.invalid',KV_REST_API_TOKEN:'synthetic',IRON_GATE_SWEETFUN_MANUAL_ENABLED:'true',IRON_GATE_SWEETFUN_MANUAL_GRANT:JSON.stringify(grant('sweetfun')),IRON_GATE_OFFLAND_RETAINED_ENABLED:'true',IRON_GATE_OFFLAND_RETAINED_GRANT:JSON.stringify(grant('offland'))});
 delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;
 for(const property of ['sweetfun','offland']){const prefix='IRON_GATE_'+property.toUpperCase();Object.assign(process.env,{[prefix+'_CALENDAR_ENABLED']:'true',[prefix+'_CALENDAR_GRANT']:JSON.stringify(grant(property)),[prefix+'_ROOM_IDS']:JSON.stringify(property==='sweetfun'?rooms:{'包棟':rooms['101']}),[prefix+'_OS_PROOF_SECRET']:secret,[prefix+'_BASE_URL']:'https://iron-gate.example/',[prefix+'_AUTHORITY_EPOCH']:'1'});}
 let member={id:'c'.repeat(32),displayName:'Synthetic',role:'viewer',status:'active',allProperties:false,propertyIds:['sweetfun','offland'],credential:{schema:1,kind:'password',revision:'d'.repeat(64),salt:'e'.repeat(32),hash:'f'.repeat(128)}};
 const cookie=`${MEMBER_COOKIE}=${createMemberSession(member)}`;let calls=0,notes='完整備註\n歷史提醒 <script>not executable</script>',mutation={},failure=false;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url)==='https://fixture.invalid')return Response.json({result:JSON.stringify({version:1,members:[member]})});
  calls++;assert.equal(options.method,'GET');assert.equal(options.cache,'no-store');assert.equal(options.body,undefined);
  const property=String(url).includes(ids.sweetfun)?'sweetfun':'offland';assert.equal(String(url),`https://iron-gate.example/v1/properties/${ids[property]}/bookings/${bookingId}`);
  const proof=await createOsMemberProofVerifier(secret)(new Request(url,options),{...grant(property),origin:'os'});assert.deepEqual(proof.actions,['booking:read']);assert.deepEqual(proof.fields,['notes']);
  if(failure)return Response.json({error:{code:'PROVIDER_SECRET_SHOULD_NOT_ESCAPE'}},{status:500});
  return Response.json({id:bookingId,propertyId:ids[property],workspaceId,version:7,notes,contact:'must not escape',totalCents:99999,...mutation});
 });
 const run=(property='sweetfun',auth=cookie,id=bookingId)=>GET(new NextRequest(`https://fixture.invalid/api/v1/bookings/${id}/notes?property=${property}`,{headers:auth?{cookie:auth}:{}}),{params:Promise.resolve({bookingId:id})});
 for(const property of ['sweetfun','offland']){const result=await run(property);assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'private, no-store');assert.equal(result.headers.get('vary'),'Cookie');assert.deepEqual(await result.json(),{bookingId,property,version:7,notes});}
 notes=null;assert.equal((await (await run()).json()).notes,null);
 for(const role of ['admin','housekeeper','god']){member={...member,role};assert.equal((await run()).status,200);}
 const before=calls;assert.equal((await run('sweetfun',null)).status,401);
 member={...member,role:'viewer_no_price'};assert.equal((await run()).status,403);
 member={...member,role:'viewer',propertyIds:['sweetfun']};assert.equal((await run('offland')).status,403);assert.equal((await run('unknown')).status,403);
 member={...member,mustResetPassword:true};assert.equal((await run()).status,401);
 member={...member,mustResetPassword:false,status:'suspended'};assert.equal((await run()).status,401);assert.equal(calls,before);
 member={...member,status:'active'};assert.equal((await run('sweetfun',cookie,'bad-id')).status,400);assert.equal(calls,before);
 for(const value of [{id:'other'},{propertyId:ids.offland},{workspaceId:'other'},{version:0},{notes:undefined},{notes:123}]){mutation=value;const result=await run();assert.equal(result.status,503);assert.deepEqual(await result.json(),{code:'NOTES_UNAVAILABLE'});}
 mutation={};failure=true;const failed=await run();assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{code:'NOTES_UNAVAILABLE'});
});
