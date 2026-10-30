import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {POST as previewPost} from '../src/app/api/v1/finance/preview/route.ts';
import {GET as historyGet} from '../src/app/api/v1/finance/legacy/route.ts';
import {GET as financeGet,POST as financePost} from '../src/app/api/v1/finance/route.ts';
import {GET as summaryGet} from '../src/app/api/v1/finance-summary/route.ts';
import {GET as calendarGet} from '../src/app/api/v1/bookings/calendar/route.ts';
import {POST as legacyPost} from '../src/app/api/v1/order-payments/route.ts';
import {createMemberSession,MEMBER_COOKIE} from '../src/lib/workspace-auth/session.ts';
const id=n=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const grant={workspaceId:id(1),propertyId:id(2),credentialId:id(3),clientId:id(4),token:'o'.repeat(43)};
test('Offland finance, summary and calendar read the same ledger without Sheet access or legacy writes',async t=>{
 const old={...process.env};t.after(()=>{for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);});
 Object.assign(process.env,{CALENDAR_SOURCE:'sheet_snapshot',BOOKING_SHEET_SOURCES:'sweetfun,offland',
  CALENDAR_OWNER_CODE_HASH:'a'.repeat(64),CALENDAR_OWNER_SESSION_SECRET:'b'.repeat(64),
  UPSTASH_REDIS_REST_URL:'https://redis.example',UPSTASH_REDIS_REST_TOKEN:'synthetic',
  OS_OFFLAND_FINANCE_SSOT_ENABLED:'true',OS_SWEETFUN_FINANCE_SSOT_ENABLED:'false',
  IRON_GATE_OFFLAND_CALENDAR_ENABLED:'true',IRON_GATE_OFFLAND_CALENDAR_PREVIEW_ENABLED:'false',
  IRON_GATE_OFFLAND_CALENDAR_GRANT:JSON.stringify(grant),
  IRON_GATE_OFFLAND_SSOT_FINANCE_GRANT:JSON.stringify({...grant,credentialId:id(5)}),
  IRON_GATE_OFFLAND_ROOM_IDS:JSON.stringify({'包棟':id(6)}),
  IRON_GATE_OFFLAND_OS_PROOF_SECRET:'synthetic-offland-proof-secret-32-bytes-long',
  IRON_GATE_OFFLAND_BASE_URL:'https://ig.example',IRON_GATE_OFFLAND_AUTHORITY_EPOCH:'1'});
 const archived={id:'old-expense',property_id:'offland',kind:'expense',category:'other',amount_cents:500,date:'2026-10-01',created_at:'2026-10-01T01:00:00Z',status:'active',source:'manual'};
 const member={id:'c'.repeat(32),displayName:'Synthetic operator',role:'admin',status:'active',
  allProperties:false,propertyIds:['offland'],credential:{schema:1,kind:'password',revision:'d'.repeat(64),salt:'e'.repeat(32),hash:'f'.repeat(128)}};
 let review=false;const commands=[];
 let activeReads=0,maxActiveReads=0,trackReads=true;
 const booking=()=>({id:id(7),workspaceId:id(1),propertyId:id(2),version:1,status:'confirmed',
  source:review?'external':'line',sourceReviewRequired:false,currency:'TWD',totalCents:200000,
  createdAt:'2026-10-28T01:00:00.000Z',channelSyncState:'not_required',guestName:'Synthetic guest',
  stays:[{checkIn:'2026-11-01',checkOut:'2026-11-02',roomIds:[id(6)]}],
  paymentSummary:{receivedCents:0,refundedCents:0,netReceivedCents:0},
  paymentReview:{status:'unknown',source:'unknown'},
  ...(review?{sourceCalendar:{platform:'LINE',sourceOrderRef:'Q:SYNTHETIC'}}:{})});
 const event={id:id(8),document_id:id(9),revision_version:1,current_version:1,change_seq:1,
  document_status:'active',event_kind:'property_receipt',amount_cents:200000,cash_effect_cents:200000,
  effective_on:'2026-10-28',cash_on:'2026-10-28',category_code:'lodging',receipt_purpose:'room',
  payment_method_code:'cash',source_system:'line_finance',source_instance_id:id(10),
  source_record_id:'synthetic-line-income',actor_ref:'operator',created_at:'2026-10-28T01:00:00Z',
  booking_allocations:[{booking_id:id(7),amount_cents:200000,allocation_kind:'room'}],expense_attributions:[]};
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url)==='https://redis.example'){
   const command=JSON.parse(options.body);commands.push(command);
   if(command[0]==='GET')return Response.json({result:command[1].includes(':workspace-auth:')?JSON.stringify({version:1,members:[member]}):command[1]==='sweetfun-os:finance:v1:offland:2026'?JSON.stringify({version:1,entries:[archived],operations:[]}):null});
   if(command[0]==='SCAN'){assert.ok(command[3].startsWith('sweetfun-os:payments:v1:offland:'));return Response.json({result:['0',[]]});}
   if(command[0]==='EVAL'&&command[1].includes('INCR'))return Response.json({result:1});
   throw Error('Unexpected Redis write');
  }
  const target=new URL(url);assert.equal(target.origin,'https://ig.example','No Sheet or other source access');
  assert.ok(target.pathname.startsWith(`/v1/properties/${id(2)}/`));
  if(trackReads){activeReads++;maxActiveReads=Math.max(maxActiveReads,activeReads);
   await new Promise(resolve=>setImmediate(resolve));activeReads--;}
  const suffix=target.pathname.split('/').at(-1);
  const envelope={propertyId:id(2),workspaceId:id(1),inventoryVersion:7,authorityEpoch:1,readOnly:false};
  if(suffix==='bookings')return Response.json({...envelope,snapshot:null,nextCursor:null,bookings:[booking()]});
  if(suffix==='calendar-snapshot')return Response.json({...envelope,from:'2026-11-01',to:'2026-11-02',
   bookings:[booking()],cells:[{roomId:id(6),date:'2026-11-01',state:'sold'}]});
  if(suffix==='ledger')return Response.json({events:[event],as_of_change_seq:1,current_change_seq:1,unsequenced_event_count:0,next_cursor:null});
  const keys={accounts:'accounts',categories:'categories','recurring-rules':'recurring_rules','payout-rules':'payout_rules','source-links':'source_links'};
  assert.ok(keys[suffix],`Unexpected ${suffix}`);return Response.json({[keys[suffix]]:[]});
 });
 const request=(path,body)=>new NextRequest(`https://os.example${path}`,{method:body?'POST':'GET',
  headers:{origin:'https://os.example',host:'os.example',cookie:`${MEMBER_COOKIE}=${createMemberSession(member)}`},
  ...(body?{body:JSON.stringify(body)}:{})});
 const response=await financeGet(request('/api/v1/finance?property=offland&year=2026'));
 trackReads=false;assert.equal(maxActiveReads,1,'Offland finance read must not fan out backend connections');
 assert.equal(response.status,200);const report=await response.json();
 assert.equal(report.history_status,'not_imported');assert.equal(report.ssot_enabled,true);assert.equal(report.entries.length,1);
 assert.equal(report.entries[0].ssot_source_system,'line_finance');assert.equal(report.orders[0].received,200000);
 const summary=await summaryGet(request('/api/v1/finance-summary?property=offland'));
 assert.equal(summary.status,200);assert.equal((await summary.json()).orders[0].recorded_received_cents,200000);
 const calendarRequest=()=>request('/api/v1/bookings/calendar?start=2026-11-01&end=2026-11-02&properties=offland');
 const calendar=await calendarGet(calendarRequest());assert.equal(calendar.status,200);
 const data=await calendar.json();assert.deepEqual(data.finance_ssot_properties,['offland']);
 assert.equal(data.bookings[0].payment_status,'paid');assert.equal(data.source_summary.missing_payment_status,0);
 review=true;
 const unknown=await (await calendarGet(calendarRequest())).json();
 assert.equal(unknown.bookings[0].payment_status,'unknown');assert.equal(unknown.source_summary.missing_payment_status,1);
 const legacy=await legacyPost(request('/api/v1/order-payments',{property_id:'offland',order_id:`IG-${id(7)}`}));
 assert.equal(legacy.status,409);assert.equal((await legacy.json()).code,'FINANCE_SSOT_ORDER_PAYMENT_MOVED');
 const archive=await historyGet(request('/api/v1/finance/legacy?property=offland&year=2026'));
 assert.equal(archive.status,200);const archiveBody=await archive.json();assert.equal(archiveBody.read_only,true);assert.deepEqual(archiveBody.entries,[archived]);
 assert.equal((await historyGet(request('/api/v1/finance/legacy?property=sweetfun&year=2026'))).status,403);
 assert.equal((await historyGet(request('/api/v1/finance/legacy?property=offland&year=oops'))).status,400);
 assert.equal((await historyGet(new NextRequest('https://os.example/api/v1/finance/legacy?property=offland&year=2026'))).status,401);
 assert.ok(!commands.some(command=>command[0]==='SET'));
 assert.equal((await financeGet(request('/api/v1/finance?property=sweetfun&year=2026'))).status,403);
 process.env.OS_OFFLAND_FINANCE_WRITES_PAUSED='true';
 const paused=await financePost(request('/api/v1/finance',{property_id:'offland',year:2026,action:'create'}));
 assert.equal(paused.status,503);assert.equal((await paused.json()).code,'FINANCE_WRITES_PAUSED');
 const stillReadable=await financeGet(request('/api/v1/finance?property=offland&year=2026'));assert.equal(stillReadable.status,200);assert.equal((await stillReadable.json()).writes_paused,true);
 assert.equal((await historyGet(request('/api/v1/finance/legacy?property=offland&year=2026'))).status,200);
 process.env.OS_OFFLAND_FINANCE_WRITES_PAUSED='false';process.env.OS_OFFLAND_FINANCE_GENERAL_ONLY='true';
 for(const input of [{action:'create',kind:'income',category:'lodging'},{action:'payout_rule'},{action:'create',kind:'expense',allocations:[{order_id:'IG-'+id(7),amount_cents:100}]}]){
  for(const handler of [financePost,previewPost]){const blocked=await handler(request('/api/v1/finance',{property_id:'offland',year:2026,...input}));assert.equal(blocked.status,403);assert.equal((await blocked.json()).code,'FINANCE_GENERAL_ONLY');}
 }
 const limited=await (await financeGet(request('/api/v1/finance?property=offland&year=2026'))).json();assert.equal(limited.general_only,true);assert.ok(limited.orders.every(order=>order.ssot_command_eligible===false));
});
