import assert from 'node:assert/strict';
import test from 'node:test';
import {NextRequest} from 'next/server';
import {ironGateSsotFinanceConfig,ssotFinanceEnabled,readSsotActivity} from
  '../src/lib/booking-sources/iron-gate-ssot-finance.server.ts';
import {GET as financeGet,POST as financePost} from '../src/app/api/v1/finance/route.ts';
import {POST as previewPost} from '../src/app/api/v1/finance/preview/route.ts';
import {GET as pendingGet} from '../src/app/api/v1/finance/pending/route.ts';
import {createMemberSession,MEMBER_COOKIE} from '../src/lib/workspace-auth/session.ts';
import {createPasswordCredential} from '../src/lib/owner-password.ts';
import {reservePendingOsFinance,readPendingOsFinance} from '../src/lib/finance-ssot-pending.server.ts';

const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const grant=property=>({credentialId:id(property==='offland'?1:2),
  clientId:id(property==='offland'?3:4),workspaceId:id(5),
  propertyId:id(property==='offland'?6:7),token:(property==='offland'?'o':'s').repeat(43)});
function environment(){
  const env={CALENDAR_SOURCE:'sheet_snapshot',BOOKING_SHEET_SOURCES:'sweetfun,offland'};
  for(const property of ['sweetfun','offland']){
    const prefix=`IRON_GATE_${property.toUpperCase()}`;
    Object.assign(env,{
      [`OS_${property.toUpperCase()}_FINANCE_SSOT_ENABLED`]:'true',
      [`${prefix}_CALENDAR_ENABLED`]:'true',
      [`${prefix}_CALENDAR_PREVIEW_ENABLED`]:'false',
      [`${prefix}_CALENDAR_GRANT`]:JSON.stringify(grant(property)),
      [`${prefix}_SSOT_FINANCE_GRANT`]:JSON.stringify({...grant(property),credentialId:id(property==='offland'?8:9)}),
      [`${prefix}_ROOM_IDS`]:JSON.stringify(Object.fromEntries(
        (property==='offland'?['包棟']:['101','102','201','202','301','302'])
          .map((room,index)=>[room,id(20+index)]))),
      [`${prefix}_OS_PROOF_SECRET`]:`synthetic-${property}-proof-secret-32-bytes-long`,
      [`${prefix}_BASE_URL`]:'https://iron-gate.example',
      [`${prefix}_AUTHORITY_EPOCH`]:'1',
    });
  }
  return env;
}

test('finance flags and grants are selected independently for each property',()=>{
  const env=environment();
  env.OS_SWEETFUN_FINANCE_SSOT_ENABLED='false';
  assert.equal(ssotFinanceEnabled('offland',env),true);
  assert.equal(ssotFinanceEnabled('sweetfun',env),false);
  assert.equal(ssotFinanceEnabled('other',env),false);
  const config=ironGateSsotFinanceConfig('offland',env);
  assert.equal(config.calendar.propertyKey,'offland');
  assert.equal(config.grant.propertyId,grant('offland').propertyId);
  assert.equal(config.grant.credentialId,id(8));
  assert.equal(config.calendar.proofSecret,env.IRON_GATE_OFFLAND_OS_PROOF_SECRET);
  assert.throws(()=>ironGateSsotFinanceConfig('sweetfun',env),/FINANCE_SSOT_UNAVAILABLE/);
  assert.throws(()=>ironGateSsotFinanceConfig('other',env),/FINANCE_SSOT_UNAVAILABLE/);
  for(const patch of [
    {IRON_GATE_OFFLAND_SSOT_FINANCE_GRANT:JSON.stringify(grant('sweetfun'))},
    {IRON_GATE_OFFLAND_SSOT_FINANCE_GRANT:JSON.stringify({...grant('offland'),workspaceId:id(40)})},
    {IRON_GATE_OFFLAND_SSOT_FINANCE_GRANT:''},
    {IRON_GATE_OFFLAND_CALENDAR_ENABLED:'false',IRON_GATE_OFFLAND_CALENDAR_PREVIEW_ENABLED:'true'},
  ])assert.throws(()=>ironGateSsotFinanceConfig('offland',{...env,...patch}),/FINANCE_SSOT_UNAVAILABLE/);
});

test('shared Iron Gate signer permits Offland members and refuses a different property before sending',async()=>{
  const config=ironGateSsotFinanceConfig('offland',environment());
  const actor={id:'scoped-admin',role:'admin',allProperties:false,
    propertyIds:['offland'],viewPrices:true};
  let calls=0;
  const send=async(url,options)=>{
    calls++;
    assert.ok(new URL(url).pathname.startsWith(`/v1/properties/${grant('offland').propertyId}/`));
    const proof=JSON.parse(Buffer.from(options.headers['x-iron-gate-os-proof'].split('.')[0],'base64url'));
    assert.equal(proof.propertyId,grant('offland').propertyId);
    assert.equal(proof.credentialId,id(8));
    return Response.json({activities:[],total:0,page_size:30});
  };
  assert.deepEqual((await readSsotActivity(config,actor,1,'','',send)).activities,[]);
  for(const denied of [{...actor,propertyIds:['sweetfun']},
    {...actor,viewPrices:false},{...actor,role:'viewer'}])
    await assert.rejects(readSsotActivity(config,denied,1,'','',send),/MANUAL_FORBIDDEN/);
  assert.equal(calls,1);
});

async function setup(t){
  const env={...environment(),CALENDAR_OWNER_CODE_HASH:'a'.repeat(64),
    CALENDAR_OWNER_SESSION_SECRET:'b'.repeat(64),
    UPSTASH_REDIS_REST_URL:'https://redis.example',UPSTASH_REDIS_REST_TOKEN:'synthetic'};
  const old=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
  Object.assign(process.env,env);
  t.after(()=>{for(const [key,value] of Object.entries(old)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }});
  const member={id:'c'.repeat(32),displayName:'Synthetic admin',role:'admin',
    status:'active',propertyIds:['offland'],allProperties:false,
    credential:await createPasswordCredential('Synthetic password testing!')};
  const values=new Map(),commands=[],ig=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url).startsWith('https://iron-gate.example/')){
      ig.push({url:String(url),options});
      return Response.json({activities:[],total:0,page_size:30});
    }
    assert.equal(String(url),'https://redis.example');
    const command=JSON.parse(options.body);commands.push(command);
    let result;
    if(command[0]==='GET'){
      result=String(command[1]).includes(':workspace-auth:')?
        JSON.stringify({version:1,members:[member]}):values.get(command[1])??null;
    }else if(command[0]==='SET'){
      if(command.includes('NX')&&values.has(command[1]))result=null;
      else{values.set(command[1],command[2]);result='OK';}
    }else if(command[0]==='EVAL'&&command[1].includes('INCR'))result=1;
    else throw Error(`Unexpected ${command[0]} command`);
    return Response.json({result});
  });
  const request=(path,input)=>new NextRequest(`https://os.example${path}`,{
    method:input?'POST':'GET',headers:{origin:'https://os.example',host:'os.example',
      cookie:`${MEMBER_COOKIE}=${createMemberSession(member)}`},
    ...(input?{body:JSON.stringify(input)}:{})});
  const actor={...member,viewPrices:true};
  return {member,actor,values,commands,ig,request};
}

test('Offland finance routes use only the property grant and never fall back to the old money writer',async t=>{
  const f=await setup(t);
  let response=await financeGet(f.request('/api/v1/finance?property=offland&year=2026&audit=1'));
  assert.equal(response.status,200,JSON.stringify(await response.json()));
  assert.equal(f.ig.length,1);
  assert.ok(f.ig[0].url.includes(`/properties/${grant('offland').propertyId}/finance/activity`));
  response=await financeGet(f.request('/api/v1/finance?property=sweetfun&year=2026&audit=1'));
  assert.equal(response.status,403);
  assert.equal(f.ig.length,1);
  const input={property_id:'offland',year:2026,request_id:id(50),
    expected_version:0,projection_version:'synthetic',action:'create',kind:'expense'};
  response=await financePost(f.request('/api/v1/finance',input));
  assert.equal(response.status,409);
  assert.equal((await response.json()).code,'FINANCE_PREVIEW_REQUIRED');
  assert.ok(!f.commands.some(command=>String(command[1]).startsWith('sweetfun-os:payments:')||
    String(command[1]).startsWith('sweetfun-os:finance:v1:')));
  delete process.env.IRON_GATE_OFFLAND_SSOT_FINANCE_GRANT;
  response=await financePost(f.request('/api/v1/finance',input));
  assert.equal(response.status,503);
  assert.ok(!f.commands.some(command=>command[0]==='SET'));
});

test('pending slots stay separate and Offland preview and recovery enforce the selected property',async t=>{
  const f=await setup(t);
  const base={year:2026,action:'create',kind:'expense',expected_version:0,
    projection_version:'synthetic',request_id:id(51)};
  await reservePendingOsFinance({...base,property_id:'offland'},'offland',f.actor);
  await reservePendingOsFinance({...base,property_id:'sweetfun'},'sweetfun',f.actor);
  assert.equal((await readPendingOsFinance('offland',f.actor)).property_id,'offland');
  assert.equal((await readPendingOsFinance('sweetfun',f.actor)).property_id,'sweetfun');
  let response=await pendingGet(f.request('/api/v1/finance/pending?property=offland'));
  assert.equal(response.status,200);
  assert.equal((await response.json()).pending.request_id,id(51));
  response=await previewPost(f.request('/api/v1/finance/preview',{...base,property_id:'offland'}));
  assert.equal(response.status,409);
  assert.equal((await response.json()).code,'FINANCE_PENDING_REQUEST');
  for(const property of ['sweetfun','unknown']){
    assert.equal((await pendingGet(f.request(`/api/v1/finance/pending?property=${property}`))).status,403);
    assert.equal((await previewPost(f.request('/api/v1/finance/preview',{...base,property_id:property}))).status,403);
  }
  process.env.OS_OFFLAND_FINANCE_SSOT_ENABLED='false';
  assert.equal((await pendingGet(f.request('/api/v1/finance/pending?property=offland'))).status,403);
});
