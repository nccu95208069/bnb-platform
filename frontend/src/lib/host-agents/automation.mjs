import {createHash,randomBytes} from 'node:crypto';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const token=()=>randomBytes(24).toString('base64url');
const terminal=j=>!['queued','leased'].includes(j.status);
const INFLIGHT=90000,INTERVAL=30000;

// The paired host drives this durable state machine by polling. Nothing depends
// on an open owner browser or a Vercel background timer staying alive.
export function createAutomation({mutate,get,seal,open,queue,need,now,bridge}){
 const scope=r=>'automation:'+r.owner+':'+r.property;
 const load=r=>r.autoPrivate?open(r.autoPrivate,scope(r)):{baseline:false,seen:{},pending:[],memory:{},events:[],blocked:{}};
 const save=(r,d)=>{r.autoPrivate=seal(d,scope(r));};
 const event=(d,value)=>{d.events=[{id:token(),at:new Date(now()).toISOString(),...value},...d.events].slice(0,50);};
 const fresh=r=>r.lastSeen&&now()-Date.parse(r.lastSeen)<60000&&r.status.host_status==='ready';
 function view(r){const a=r?.automation;if(!a)return {enabled:false,state:'off',sent:0,handoffs:0};return {...a,state:!a.enabled?'off':!fresh(r)?'needs_connection':a.state};}
 function halt(r,reason){if(r.automation){r.automation.state='attention';r.automation.reason=reason;r.automation.nextAt=now()+60000;}}
 async function command(key,operation,b){
  if(operation==='automation-knowledge'){need(bridge,'customer_bot_unavailable',409);return bridge.knowledge(b);}
  if(operation==='automation-events'){const r=await get(key);need(r&&!r.revoked,'not_paired',409);const d=load(r);return {automation:view(r),events:d.events,blocked:Object.entries(d.blocked).map(([id,v])=>({id,...v}))};}
  if(operation==='automation-resolve'){
   const r=await get(key);need(r&&!r.revoked,'not_paired',409);need(typeof b.guest_ref==='string'&&load(r).blocked[b.guest_ref],'not_found',404);
   await bridge.resolve(b.guest_ref);
   return mutate(key,r=>{const d=load(r);delete d.blocked[b.guest_ref];event(d,{type:'resolved'});save(r,d);return {ok:true};});
  }
  if(operation!=='automation-set')return undefined;
  need(typeof b.enabled==='boolean','invalid_request');
  let config;
  if(b.enabled){need(bridge,'customer_bot_unavailable',409);config=await bridge.config(b.bot_id||'concierge');}
  return mutate(key,r=>{
   need(!r.revoked,'not_paired',409);
   if(!b.enabled){if(r.automation)r.automation.enabled=false;for(const j of r.jobs)if(j.automation&&j.status==='queued'){j.status='blocked';j.error_code='automation_paused';}return {automation:view(r)};}
   need(fresh(r),'line_login_required',409);
   need(r.status.automation_protocol===1,'automation_host_update_required',409);
   need(!r.jobs.some(j=>!terminal(j)&&Date.parse(j.approval_expires_at)>now()),'job_in_progress',409);
   const previous=load(r);
   r.automation={id:token(),enabled:true,bot_id:config.bot_id,bot_name:config.bot_name,state:'starting',sent:r.automation?.sent||0,handoffs:r.automation?.handoffs||0,nextAt:now(),started_at:new Date(now()).toISOString()};
   save(r,{baseline:false,seen:{},pending:[],memory:previous.memory,events:previous.events,blocked:previous.blocked});
   return {automation:view(r)};
  });
 }
 async function add(r,d,action,payload,context={}){
  const j=await queue(r,action,payload,{policy_id:r.automation.id,bot_id:r.automation.bot_id,bot_version:context.bot_version||''});
  j.auto_context=seal(context,scope(r)+":"+j.job_id);r.automation.active_job=j.job_id;r.automation.state=action==='oa_reply'?'sending':action==='oa_read_conversation'?'reading':'watching';save(r,d);
 }
 function ingest(r,j,status,output,error){
  if(!j.automation||!r.automation||j.automation.policy_id!==r.automation.id)return;
  const a=r.automation,d=load(r),jobContext=open(j.auto_context,scope(r)+":"+j.job_id);a.active_job=null;
  if(status!=='succeeded'){
   event(d,{type:'attention',guest_ref:jobContext.guest_ref,name:jobContext.name,reason:error||'operation_unconfirmed'});
   if(jobContext.guest_ref)d.blocked[jobContext.guest_ref]={name:jobContext.name,reason:error||'operation_unconfirmed'};
   halt(r,error||'operation_unconfirmed');delete d.thinking;save(r,d);return;
  }
  if(j.action==='oa_list_conversations'){
   const rows=output.conversations||[],counts=new Map();for(const row of rows)counts.set(row.display_name,(counts.get(row.display_name)||0)+1);
   for(const row of rows){
    const id=hash(row.display_name),revision=row.revision||hash([row.display_name,row.preview]);
    if(d.baseline&&counts.get(row.display_name)===1&&!d.blocked[id]&&d.seen[id]!==revision&&!d.pending.some(p=>p.guest_ref===id))d.pending.push({name:row.display_name,guest_ref:id});
    d.seen[id]=revision;
   }
   // Keep bounded encrypted identifiers; new arrivals move to the recent list.
   if(Object.keys(d.seen).length>500){halt(r,'contact_capacity');a.enabled=false;}
   d.baseline=true;a.state='watching';a.nextAt=d.pending.length?now():now()+INTERVAL;
  }else if(j.action==='oa_read_conversation'){
   const {guest_ref,name}=jobContext;
   const fingerprint=hash(output.messages);
   if(!output.messages?.length||output.messages.at(-1).direction!=='incoming'||d.memory[guest_ref]?.fingerprint===fingerprint){a.nextAt=now();save(r,d);return;}
   d.thinking={token:token(),conversation:output,guest_ref,name,fingerprint};a.state='planning';a.nextAt=now();
  }else if(j.action==='oa_reply'){
   const c=jobContext;a.sent++;a.state='watching';a.nextAt=now()+1000;
   const memory=d.memory[c.guest_ref]||{turns:[]};
   d.memory[c.guest_ref]={fingerprint:output.conversation?hash(output.conversation.messages):c.fingerprint,turns:[...memory.turns,{direction:'incoming',text:c.question},{direction:'outgoing',text:c.reply}].slice(-6),at:now()};
   event(d,{type:c.handoff?'handoff':'replied',guest_ref:c.guest_ref,name:c.name,question:c.question,reply:c.reply});
  }
  save(r,d);
 }
 async function tick(key){
  let planning=null;
  await mutate(key,async r=>{
   planning=null;
   const a=r.automation;if(!a?.enabled||!fresh(r)||a.nextAt>now())return;
   if(r.jobs.some(j=>!terminal(j)&&Date.parse(j.approval_expires_at)>now()))return;
   const d=load(r);
   // A lost write receipt is never reissued as a fresh send.
   if(a.active_job){const old=r.jobs.find(j=>j.job_id===a.active_job);if(old&&!terminal(old)){old.status='owner_required';old.error_code='action_outcome_uncertain';ingest(r,old,'owner_required',null,'action_outcome_uncertain');return;}a.active_job=null;}
   if(d.thinking){
    if(d.thinking.claimedUntil>now())return;
    if(d.thinking.claimedUntil){d.blocked[d.thinking.guest_ref]={name:d.thinking.name,reason:'generation_interrupted'};event(d,{type:'attention',name:d.thinking.name,reason:'generation_interrupted'});delete d.thinking;halt(r,'generation_interrupted');save(r,d);return;}
    d.thinking.claimedUntil=now()+INFLIGHT;
    planning={...d.thinking,policy_id:a.id,bot_id:a.bot_id,memory:d.memory[d.thinking.guest_ref]?.turns||[]};save(r,d);return;
   }
   const next=d.pending.shift();
   if(next&&!d.blocked[next.guest_ref])await add(r,d,'oa_read_conversation',{display_name:next.name},next);
   else await add(r,d,'oa_list_conversations',{});
  });
  if(!planning)return;
  let result,error;
  try{
   need(bridge,'customer_bot_unavailable',409);
   result=await bridge.plan(planning.bot_id,{messages:planning.conversation.messages,memory:planning.memory});
   // Persist real handoff in the shared Bot workspace before promising it to guest.
   await bridge.record({id:planning.token,bot_id:planning.bot_id,guest_ref:planning.guest_ref,status:result.needs_owner?'needs_owner':'prepared',handoff:result.needs_owner});
  }catch(e){error=['customer_bot_unavailable','provider_error','provider_not_configured','invalid_model_output'].includes(e.message)?e.message:'bot_unavailable';}
  await mutate(key,async r=>{
   const a=r.automation,d=load(r);
   if(a?.id!==planning.policy_id||d.thinking?.token!==planning.token)return;
   delete d.thinking;
   if(!a.enabled||r.revoked){save(r,d);return;}
   if(error){d.blocked[planning.guest_ref]={name:planning.name,reason:error};event(d,{type:'attention',name:planning.name,reason:error});halt(r,error);save(r,d);return;}
   if(result.needs_owner){d.blocked[planning.guest_ref]={name:planning.name,reason:'needs_owner'};a.handoffs++;}
   const question=planning.conversation.messages.filter(m=>m.direction==='incoming').slice(-1)[0].text;
   const context={name:planning.name,guest_ref:planning.guest_ref,fingerprint:planning.fingerprint,question,reply:result.reply,handoff:result.needs_owner,bot_version:result.bot_version};
   await add(r,d,'oa_reply',{display_name:planning.name,conversation_ref:planning.conversation.conversation_ref,text:result.reply},context);
  });
 }
 async function permit(r,j){
  need(j?.automation&&r.automation?.enabled&&r.automation.id===j.automation.policy_id,'automation_paused',409);
  need(fresh(r),'line_login_required',409);
  if(j.action==='oa_reply'){const config=await bridge.config(j.automation.bot_id);need(config.version===j.automation.bot_version,'knowledge_changed',409);}
  return true;
 }
 return {command,tick,ingest,permit,view};
}
