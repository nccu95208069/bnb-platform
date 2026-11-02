import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDaili} from '../src/lib/host-agents/daili.mjs';
import {bucket,inboxCard,pageMessages,sendBlocked,statusCard} from '../src/lib/host-agents/manager-inbox.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex');
const property={id:'synthetic',name:'合成民宿'};
const propertyId='10000000-0000-4000-8000-000000000001';
const base=()=>({id:'d'.repeat(32),name:'合成旅客',question:'入住時間？',reply:'下午三點。',version:1,status:'awaiting_approval',category:'ready',questions:['入住時間'],contract_version:3,channel_kind:'instagram',history_partial:true,reply_deadline:new Date(Date.now()+60000).toISOString()});
const actions=value=>JSON.stringify(value).match(/"label":"([^"]+)"/g)||[];

test('IG cards identify source, deadline and partial history',()=>{
 const card=JSON.stringify(inboxCard(property,base()));
 assert.match(card,/IG · 合成旅客/);assert.match(card,/IG 可回覆至/);assert.match(card,/歷史紀錄可能不完整/);assert.match(card,/核准送出/);
 assert.match(JSON.stringify(statusCard(property,{...base(),status:'sent'})),/Instagram 已接受傳送/);
});

test('expired and missing IG deadlines cannot offer single or batch approval',()=>{
 for(const deadline of [null,'bad-date',new Date(Date.now()-1).toISOString()]){
  const draft={...base(),reply_deadline:deadline};
  assert.equal(sendBlocked(draft),true);assert.equal(bucket(draft,Date.now()),'decision');
  assert.ok(!actions(inboxCard(property,draft)).some(x=>x.includes('核准送出')));
  const page=pageMessages([{property,draft}],{token:'synthetic',page:0,total:1,category:'ready',renderToken:'render'});
  assert.ok(!actions(page).some(x=>x.includes('全部核准')));
 }
 assert.equal(sendBlocked({...base(),channel_kind:'line',reply_deadline:null}),false);
});

function setup(t,{queuePage}={}){
 const names=['DAILI_MANAGER_CONNECTION','CALENDAR_OWNER_SESSION_SECRET'];
 const before=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 t.after(()=>{for(const n of names)if(before[n]===undefined)delete process.env[n];else process.env[n]=before[n];});
 process.env.CALENDAR_OWNER_SESSION_SECRET='synthetic-secret-'.repeat(5);
 process.env.DAILI_MANAGER_CONNECTION=JSON.stringify({channel:hash('manager:synthetic-owner').slice(0,32),token:'synthetic-token-'.repeat(3),starts_at:'2026-01-01T00:00:00Z',properties:[{id:property.id,daili_property_id:propertyId}]});
 let time=Date.now();const values=new Map(),sends=[],queueOffsets=[];
 const redis=async([op,...a])=>{
  if(op==='GET')return values.get(a[0])||null;
  if(op==='SET'){if(a.includes('NX')&&values.has(a[0]))return null;values.set(a[0],a[1]);return 'OK';}
  if(op==='EVAL'){
   const [script,,key,old,next]=a;
   if(script.includes("redis.call('DEL'")){if(values.get(key)!==old)return 0;values.delete(key);return 1;}
   if((values.get(key)||'')!==old)return 0;values.set(key,next);return 1;
  }
  throw Error('unexpected redis operation');
 };
 const item={...base(),property_id:propertyId,conversation_id:'20000000-0000-4000-8000-000000000002',stamp:'s'.repeat(64),source_hash:hash('下午三點。'),inbox_snapshot:'a'.repeat(64),suggestion_ids:[],messages:[]};
 const fetcher=async(url,options)=>({ok:true,json:async()=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/queue')){const offset=Number(new URL(url).searchParams.get('offset'));queueOffsets.push(offset);return queuePage?queuePage({offset,item,call:queueOffsets.length}):{items:[item],next_offset:0};}
  if(path.endsWith('/attachments'))return {items:[]};
  if(path.endsWith('/send')){sends.push(JSON.parse(options.body));return {status:'sent',message_id:'synthetic-message'};}
  throw Error('unexpected API path');
 }});
 const manager={owner:async()=>({bound:true,webhook_verified:true,binding_revision:1}),notify:async()=>true};
 const daili=createDaili(redis,manager,{now:()=>time,fetcher});
 return {daili,item,sends,queueOffsets,advance:ms=>time+=ms,sync:()=>daili.sync('synthetic-owner',property.id,time+50000),activity:()=>daili.activity('synthetic-owner',property.id),decide:b=>daili.decide('synthetic-owner',property.id,b)};
}

test('IG messages settling during the first poll are picked up before the older queue finishes',async t=>{
 const f=setup(t,{queuePage:({offset,item,call})=>({items:offset===0&&call>1?[item]:[],next_offset:offset===0?3:0})});
 await f.sync();assert.equal((await f.activity()).drafts.length,0);
 f.advance(31000);await f.sync();
 assert.deepEqual(f.queueOffsets,[0,0,3]);
 const [draft]=(await f.activity()).drafts;
 assert.equal(draft.channel_kind,'instagram');assert.equal(draft.status,'awaiting_approval');
 assert.equal(f.sends.length,0);
});

test('IG byte limit and owner approval are enforced in persisted bridge state',async t=>{
 const f=setup(t);await f.sync();let [draft]=(await f.activity()).drafts;
 assert.equal(draft.channel_kind,'instagram');assert.equal(f.sends.length,0);
 await assert.rejects(f.decide({draft_id:draft.id,version:draft.version,action:'edit',text:'字'.repeat(334)}),/instagram_text_too_long/);
 const edited=await f.decide({draft_id:draft.id,version:draft.version,action:'edit',text:'字'.repeat(333)});
 draft=edited.draft;
 await f.decide({draft_id:draft.id,version:draft.version,action:'approve'});await f.sync();
 assert.equal(f.sends.length,1);assert.equal(f.sends[0].text,'字'.repeat(333));
});

test('approval expiring before dispatch returns to review without a send',async t=>{
 const f=setup(t);await f.sync();const [draft]=(await f.activity()).drafts;
 await f.decide({draft_id:draft.id,version:draft.version,action:'approve'});
 f.advance(61000);await f.sync();const [current]=(await f.activity()).drafts;
 assert.equal(f.sends.length,0);assert.equal(current.status,'awaiting_approval');
 assert.equal(current.send_blocked,'INSTAGRAM_REPLY_WINDOW_CLOSED');
 await assert.rejects(f.decide({draft_id:current.id,version:current.version,action:'approve'}),/instagram_reply_window_closed/);
});
