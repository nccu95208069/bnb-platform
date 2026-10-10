import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { legacyArrivals, nativeArrivals, reminderText, taipeiDay } from '../src/lib/arrival-reminders/domain.ts';
import { claimReminder, acknowledgeReminder, arrivalView, markHandled } from '../src/lib/arrival-reminders/service.ts';
import { reminderWorker, workerOperation } from '../src/lib/arrival-reminders/worker.ts';
import { customerList, legacyList } from '../src/lib/arrival-reminders/source.ts';
import { fixture } from './helpers/calendar-fixture.mjs';
const now = new Date('2026-10-10T01:00:00Z');
const recipient = 'U' + 'a'.repeat(32);
function list() {
  return { scope: 'workspace:calendar-inn:property', day: '2026-10-10', checkedAt: now.toISOString(), propertyName: 'Synthetic inn', arrivals: [{ id: randomUUID(), guest: 'Synthetic guest', checkIn: '2026-10-10', checkOut: '2026-10-12', rooms: ['101'], notes: '需要嬰兒床', fingerprint: 'a'.repeat(64), href: '/w/calendar-inn/orders' }] };
}
const row = (start, end, extra = {}) => ({ id: start, property_id: 'sweetfun', order_id: 'same-order', check_in: start, check_out: end, room_number: '101', guest_name: 'Synthetic', source_order_linked: true, reservation_status: 'confirmed', source_notes: [{ text: '需要嬰兒床' }], ...extra });
test('legacy arrivals group all nights, exclude stayovers/checkouts and deduplicate notes', () => {
  assert.deepEqual(legacyArrivals([row('2026-10-09','2026-10-10'),row('2026-10-10','2026-10-11')], 'sweetfun', '2026-10-10'), []);
  const result = legacyArrivals([row('2026-10-10','2026-10-11'),row('2026-10-11','2026-10-12'),row('2026-10-10','2026-10-11',{room_number:'102'})], 'sweetfun', '2026-10-10');
  assert.equal(result.length,1); assert.equal(result[0].checkOut,'2026-10-12'); assert.equal(result[0].notes,'需要嬰兒床'); assert.deepEqual(result[0].rooms,['101','102']);
  for (const invalid of [{source_notes_unconfirmed:true},{source_order_linked:false},{source_conflict:true},{snapshot_only:true}]) assert.throws(()=>legacyArrivals([row('2026-10-10','2026-10-11',invalid)],'sweetfun','2026-10-10'),/UNCONFIRMED/);
});
test('native reminders exclude holds/cancelled/foreign properties and preserve nullable guest names', () => {
  const booking = {id:randomUUID(),propertyId:'property',guestName:null,checkIn:'2026-10-10',checkOut:'2026-10-11',roomIds:['101'],notes:'晚到',status:'confirmed'};
  const p = {id:'property',rooms:[{id:'101',name:'101'}]};
  const result = nativeArrivals([booking,...['held','cancelled'].map(status=>({...booking,id:randomUUID(),status})),{...booking,propertyId:'other'},{...booking,checkIn:'2026-10-09'}],p,'calendar-inn','2026-10-10');
  assert.equal(result.length,1); assert.equal(result[0].guest,'未填姓名'); assert.match(result[0].href,/orders\/[a-f0-9-]{36}$/);
  assert.equal(taipeiDay(new Date('2026-12-31T16:00:00Z')),'2027-01-01');
});
test('atomic claims allow only one worker attempt; provider receipt plus independent readback is required', async () => {
  const {store}=fixture(), data=list(), a=randomUUID(), b=randomUUID();
  const claims=await Promise.all([claimReminder(store,'worker','target',recipient,a,data,now),claimReminder(store,'worker','target',recipient,b,data,now)]);
  assert.equal(claims.flatMap(r=>r.jobs).length,1);
  const job=claims.flatMap(r=>r.jobs)[0], attempt=job.attemptId;
  assert.deepEqual((await claimReminder(store,'worker','target',recipient,attempt,data,now)).jobs,[job]);
  await assert.rejects(()=>acknowledgeReminder(store,'worker','target',data.day,attempt,job.id,'sent',undefined,now),/INVALID_INPUT/);
  await assert.rejects(()=>acknowledgeReminder(store,'other','target',data.day,attempt,job.id,'sent','provider-001',now),/NOT_FOUND/);
  assert.equal((await acknowledgeReminder(store,'worker','target',data.day,attempt,job.id,'sent','provider-001',now)).state,'sent');
  assert.equal((await claimReminder(store,'worker','target',recipient,randomUUID(),data,now)).jobs.length,0);
  const proof=await claimReminder(store,'worker','target',recipient,attempt,data,now);
  assert.deepEqual(proof.results,[{jobId:job.id,state:'sent'}]);
  assert.equal((await arrivalView(store,data)).arrivals[0].handledAt,null); // delivered != human handled
});
test('interrupted dispatch becomes unknown and never grants a new send', async () => {
  const {store}=fixture(),data=list(),attempt=randomUUID();
  await claimReminder(store,'worker','target',recipient,attempt,data,now);
  const result=await claimReminder(store,'worker','target',recipient,attempt,data,new Date(now.getTime()+6*60000));
  assert.equal(result.results[0].state,'unknown');
  assert.equal((await claimReminder(store,'worker','target',recipient,randomUUID(),data,now)).jobs.length,0);
});
test('changed notes, revoked recipient and handled items withdraw a claim; changed notes reopen preparation', async () => {
  for (const change of ['notes','recipient','handled']) {
    const {store}=fixture(),data=list(),attempt=randomUUID(),item=data.arrivals[0];
    await claimReminder(store,'worker','target',recipient,attempt,data,now);
    if(change==='notes') item.fingerprint='b'.repeat(64);
    if(change==='handled') await markHandled(store,data,'owner',item.id,item.fingerprint,now);
    const result=await claimReminder(store,'worker','target',change==='recipient'?'U'+'b'.repeat(32):recipient,attempt,data,now);
    assert.equal(result.results[0].state,'superseded');
  }
  const {store}=fixture(),data=list(),item=data.arrivals[0];
  await markHandled(store,data,'owner',item.id,item.fingerprint,now);
  assert.ok((await arrivalView(store,data)).arrivals[0].handledAt);
  item.fingerprint='b'.repeat(64); assert.equal((await arrivalView(store,data)).arrivals[0].handledAt,null);
  await assert.rejects(()=>markHandled(store,data,'owner',item.id,'a'.repeat(64),now),/VERSION_CONFLICT/);
});
test('LINE payload remains bounded and preserves a full-order link', () => {
  const data=list();data.arrivals[0].notes='長備註😀'.repeat(4000);
  const text=reminderText(data,data.arrivals[0]); assert.ok(text.length<5000);assert.match(text,/其餘備註/);assert.match(text,/https:\/\/sweetfun-os.vercel.app/);
});
test('worker capability is separate, scope exact and outside-window claims do no source I/O',async()=>{
  const token='synthetic-arrival-token-at-least-32-characters';
  const config=[{id:'line',token_sha256:createHash('sha256').update(token).digest('hex'),targets:[{id:'sweetfun',kind:'legacy',propertyId:'sweetfun',recipientId:recipient,verifiedAt:'2026-10-01T00:00:00Z',verifiedBy:'owner-pairing'}]}];
  const worker=reminderWorker('Bearer '+token,JSON.stringify(config),now);
  assert.throws(()=>reminderWorker('Bearer '+token+'x',JSON.stringify(config),now),/UNAUTHORIZED/);
  assert.throws(()=>reminderWorker('Bearer '+token,JSON.stringify([...config,...config]),now),/CONFIG/);
  const {store}=fixture();let reads=0;const load=async()=>{reads++;return {list:list(),recipient};};
  await assert.rejects(()=>workerOperation(store,worker,{action:'claim',targetId:'foreign',attemptId:randomUUID()},now,load),/FORBIDDEN/);
  assert.equal((await workerOperation(store,worker,{action:'claim',targetId:'sweetfun',attemptId:randomUUID()},new Date('2026-10-10T00:59:00Z'),load)).status,'outside_window');assert.equal(reads,0);
  assert.equal((await workerOperation(store,worker,{action:'claim',targetId:'sweetfun',attemptId:randomUUID()},now,load)).jobs.length,1);assert.equal(reads,1);
});
test('native source revalidates membership, property grants and connected-calendar freshness',async()=>{
  const {store,workspace}=fixture();const key=`workspace:${workspace.id}`;
  const save=async()=>{const old=await store.read(key);await store.commit([{key,before:old.raw,after:workspace}]);};
  workspace.properties[0].setup=undefined;await save();
  assert.equal((await customerList(store,'calendar-owner',workspace.slug,'property',now)).arrivals.length,0);
  await assert.rejects(()=>customerList(store,'foreign',workspace.slug,'property',now),/NOT_FOUND/);
  workspace.members[0].role='viewer_no_price';await save();await assert.rejects(()=>customerList(store,'calendar-owner',workspace.slug,'property',now),/FORBIDDEN/);
  workspace.members[0].role='owner';workspace.calendarSources=[{propertyId:'property',mode:'connected',lastSuccessfulAt:'2026-10-09T00:00:00Z'}];await save();await assert.rejects(()=>customerList(store,'calendar-owner',workspace.slug,'property',now),/UNCONFIRMED/);
});

test('unfinished onboarding and calendar coverage gaps cannot become a reassuring empty reminder list',async()=>{
  const f=fixture(),w=await f.current();
  await assert.rejects(()=>customerList(f.store,'calendar-owner',w.slug,'property',now),/UNCONFIRMED/);
  w.properties[0].setup={mode:'calendar',readyAt:now.toISOString(),unresolvedCount:0,coverageFrom:'2026-10-01',coverageTo:'2026-10-11'};await f.put(w);
  await assert.rejects(()=>customerList(f.store,'calendar-owner',w.slug,'property',now),/UNCONFIRMED/);
  w.properties[0].setup.coverageTo='2026-10-12';await f.put(w);
  assert.equal((await customerList(f.store,'calendar-owner',w.slug,'property',now)).arrivals.length,0);
});

test('legacy reminder reads full authoritative notes and refuses absent or duplicated note columns',async t=>{
  const prior=[process.env.CALENDAR_SOURCE,process.env.BOOKING_SHEET_SOURCES];
  process.env.CALENDAR_SOURCE='sheet_snapshot';process.env.BOOKING_SHEET_SOURCES='sweetfun';
  t.after(()=>{for(const [i,key] of ['CALENDAR_SOURCE','BOOKING_SHEET_SOURCES'].entries()){if(prior[i]===undefined)delete process.env[key];else process.env[key]=prior[i];}});
  const {HEADERS}=await import('../src/lib/sheet-monitor/reconcile.ts');
  const cells=['301','Synthetic','Agoda','2026/10/10','2026/10/11','2026/10/1','2500','done','OK','synthetic-row','完整備註\n需要嬰兒床','synthetic-order','2'];
  const result=await legacyList('sweetfun',now,async()=>[HEADERS,cells]);
  assert.equal(result.arrivals.length,1);assert.equal(result.arrivals[0].notes,cells[10]);
  for(const columns of [HEADERS.map(h=>h==='備註'?'不存在':h),[...HEADERS,'備註']]) await assert.rejects(()=>legacyList('sweetfun',now,async()=>[columns,cells]),/UNCONFIRMED/);
});

test('two target bindings cannot send the same property order twice in one day',async()=>{
  const {store}=fixture(),data=list();
  const results=await Promise.all(['first-binding','second-binding'].map(target=>claimReminder(store,'worker',target,recipient,randomUUID(),data,now)));
  assert.equal(results.flatMap(r=>r.jobs).length,1);
  assert.equal((await claimReminder(store,'worker','third-binding',recipient,randomUUID(),data,now)).jobs.length,0);
});
