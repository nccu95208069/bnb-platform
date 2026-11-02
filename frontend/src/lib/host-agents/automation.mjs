import {createHash,randomBytes,randomUUID} from 'node:crypto';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const token=()=>randomBytes(24).toString('base64url');
const terminal=j=>!['queued','leased'].includes(j.status);
const MODE='owner_approval_v1',INTERVAL=30000,LIFETIME=86400000;

// The host drives scanning and notification delivery. Guest sends always require
// an exact, versioned owner decision followed by a fresh native conversation read.
export function createAutomation({mutate,get,seal,open,queue,need,now,bridge,notify}){
 const scope=r=>'automation:'+r.owner+':'+r.property;
 const load=r=>Object.assign({baseline:false,seen:{},pending:[],memory:{},events:[],blocked:{},drafts:[],notices:[]},r.autoPrivate?open(r.autoPrivate,scope(r)):{});
 const save=(r,d)=>{r.autoPrivate=seal(d,scope(r));};
 const fresh=r=>r.lastSeen&&now()-Date.parse(r.lastSeen)<60000&&r.status.host_status==='ready';
 const event=(d,v)=>{d.events=[{id:token(),at:new Date(now()).toISOString(),...v},...d.events].slice(0,50);};
 const notice=(d,v)=>{d.notices.push({id:randomUUID(),created:now(),next:now(),...v});d.notices=d.notices.slice(-100);};
 const projection=a=>({id:a.id,version:a.version,name:a.name,question:a.question,reply:a.reply,status:a.status,needs_owner:a.needs_owner,created_at:a.created_at,expires_at:a.expires_at});
 function view(r){const a=r?.automation;if(!a)return {enabled:false,state:'off',mode:MODE,sent:0,handoffs:0};return {...a,enabled:a.enabled&&a.mode===MODE,state:!a.enabled||a.mode!==MODE?'off':!fresh(r)?'needs_connection':a.state};}
 function halt(r,reason){r.automation.state='attention';r.automation.reason=reason;r.automation.nextAt=now()+60000;}
 function invalidate(d,a,reason){a.status='stale';a.version++;notice(d,{kind:'status',draft:projection(a),text:reason});}
 async function command(key,operation,b){
  const r=await get(key);
  if(operation==='automation-knowledge'){need(bridge,'customer_bot_unavailable',409);return bridge.knowledge(b,b.property_id||r?.property||'sweetfun');}
  need(r&&!r.revoked,'not_paired',409);
  if(operation==='automation-events'){const d=load(r);return {automation:view(r),drafts:d.drafts.map(projection),events:d.events,blocked:Object.entries(d.blocked).map(([id,v])=>({id,...v}))};}
  if(operation==='automation-resolve'){
   need(typeof b.guest_ref==='string'&&load(r).blocked[b.guest_ref],'not_found',404);
   await bridge.resolve(b.guest_ref);
   return mutate(key,r=>{const d=load(r);delete d.blocked[b.guest_ref];event(d,{type:'resolved'});save(r,d);return {ok:true};});
  }
  if(operation==='automation-decide')return mutate(key,r=>{
   const d=load(r),a=d.drafts.find(x=>x.id===b.draft_id);need(a,'draft_not_found',404);
   if(b.request_id&&a.last_action_id===b.request_id)return {draft:projection(a)};
   need(a.version===b.version,'draft_changed',409);
   need(['awaiting_approval','approved'].includes(a.status)&&a.expires_at>now(),'draft_expired',409);
   need(['approve','edit','takeover'].includes(b.action),'invalid_request');
   if(b.action==='edit'){
    need(a.status==='awaiting_approval','draft_already_approved',409);
    need(typeof b.text==='string'&&b.text.trim()&&b.text.length<=1000&&!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(b.text),'invalid_customer_input');
    a.reply=b.text.trim();a.version++;a.edited=true;
    notice(d,{kind:'draft',draft:projection(a)});
   }else if(b.action==='approve'){
    need(r.automation?.enabled&&r.automation.mode===MODE,'automation_paused',409);
    need(a.reply?.trim(),'reply_required',409);a.status='approved';a.approved_at=now();a.approved_version=a.version;
    r.automation.nextAt=now();
   }else{
    a.status='dismissed';a.version++;d.blocked[a.guest_ref]={name:a.name,reason:'owner_takeover'};
    event(d,{type:'takeover',name:a.name});
   }
   a.last_action_id=b.request_id||null;save(r,d);return {draft:projection(a)};
  });
  if(operation!=='automation-set')return undefined;
  need(typeof b.enabled==='boolean','invalid_request');
  const config=b.enabled?await bridge.config(b.bot_id||'concierge',r.property):null;
  return mutate(key,r=>{
   const d=load(r);
   if(!b.enabled){
    if(r.automation)r.automation.enabled=false;
    for(const j of r.jobs)if(j.automation&&j.status==='queued'){j.status='blocked';j.error_code='automation_paused';}
    for(const a of d.drafts)if(['approved','checking','sending'].includes(a.status)){a.status='uncertain';a.version++;}
    save(r,d);return {automation:view(r)};
   }
   need(fresh(r),'line_login_required',409);need(r.status.automation_protocol===1,'automation_host_update_required',409);
   need(!r.jobs.some(j=>!terminal(j)&&Date.parse(j.approval_expires_at)>now()),'job_in_progress',409);
   r.automation={id:token(),mode:MODE,enabled:true,bot_id:config.bot_id,bot_name:config.bot_name,state:'starting',sent:r.automation?.sent||0,handoffs:r.automation?.handoffs||0,nextAt:now(),started_at:new Date(now()).toISOString()};
   for(const a of d.drafts)if(['awaiting_approval','approved','checking'].includes(a.status))invalidate(d,a,'監控重新啟用，請以新草稿為準。');
   d.baseline=false;d.seen={};d.pending=[];delete d.thinking;save(r,d);return {automation:view(r)};
  });
 }
 async function add(r,d,action,payload,context={}){
  const j=await queue(r,action,payload,{policy_id:r.automation.id,bot_id:r.automation.bot_id,bot_version:context.bot_version||''});
  j.auto_context=seal(context,scope(r)+':'+j.job_id);r.automation.active_job=j.job_id;
  r.automation.state=action==='oa_reply'?'sending':action==='oa_read_conversation'?'reading':'watching';save(r,d);return j;
 }
 // Called in the same CAS commit that accepts the host's result.
 async function ingest(r,j,status,output,error){
  if(!j.automation||!r.automation||j.automation.policy_id!==r.automation.id)return;
  const a=r.automation,d=load(r),c=open(j.auto_context,scope(r)+':'+j.job_id);a.active_job=null;
  const draft=c.draft_id?d.drafts.find(x=>x.id===c.draft_id):null;
  if(status!=='succeeded'){
   if(draft){draft.status=j.action==='oa_reply'?'uncertain':'stale';draft.version++;notice(d,{kind:'status',draft:projection(draft),text:j.action==='oa_reply'?'送出結果待確認，請查看 LINE，勿重複送出。':'重新核對未完成，尚未送出。'});}
   event(d,{type:'attention',guest_ref:c.guest_ref,name:c.name,reason:error||'operation_unconfirmed'});
   if(c.guest_ref)d.blocked[c.guest_ref]={name:c.name,reason:error||'operation_unconfirmed'};
   halt(r,error||'operation_unconfirmed');delete d.thinking;save(r,d);return;
  }
  if(j.action==='oa_list_conversations'){
   const rows=output.conversations||[],counts=new Map();for(const row of rows)counts.set(row.display_name,(counts.get(row.display_name)||0)+1);
   for(const row of rows){
    const id=hash([r.property,row.display_name]),revision=row.revision||hash([row.display_name,row.preview]);
    if(d.baseline&&d.seen[id]!==revision){
     for(const old of d.drafts)if(old.guest_ref===id&&['awaiting_approval','approved'].includes(old.status))invalidate(d,old,'對話已更新，原草稿失效，正在重新整理。');
     if(counts.get(row.display_name)===1&&!d.blocked[id]&&!d.pending.some(p=>p.guest_ref===id))d.pending.push({name:row.display_name,guest_ref:id});
    }
    d.seen[id]=revision;
   }
   if(Object.keys(d.seen).length>500){a.enabled=false;halt(r,'contact_capacity');}
   d.baseline=true;a.state='watching';a.nextAt=d.pending.length?now():now()+INTERVAL;
  }else if(j.action==='oa_read_conversation'){
   const fingerprint=hash(output.messages);
   if(draft){
    // Owner approval survives waiting, but never survives changed content/policy.
    if(!a.enabled||a.mode!==MODE||draft.status!=='checking'||draft.version!==c.version||draft.expires_at<=now()||draft.fingerprint!==fingerprint){
     invalidate(d,draft,'對話已變更或核准已失效，尚未送出。');
     if(a.enabled&&output.messages?.at(-1)?.direction==='incoming')d.thinking={token:token(),conversation:output,guest_ref:c.guest_ref,name:c.name,fingerprint};
     a.nextAt=now();save(r,d);return;
    }
    draft.status='sending';
    await add(r,d,'oa_reply',{display_name:draft.name,conversation_ref:output.conversation_ref,text:draft.reply},{draft_id:draft.id,version:draft.version,name:draft.name,guest_ref:draft.guest_ref,bot_version:draft.bot_version});return;
   }
   if(!output.messages?.length||output.messages.at(-1).direction!=='incoming'||d.memory[c.guest_ref]?.fingerprint===fingerprint){a.nextAt=now();save(r,d);return;}
   d.thinking={token:token(),conversation:output,guest_ref:c.guest_ref,name:c.name,fingerprint};a.state='planning';a.nextAt=now();
  }else if(j.action==='oa_reply'&&draft){
   draft.status='sent';draft.sent_at=now();a.sent++;a.state='watching';a.nextAt=now()+1000;
   const memory=d.memory[draft.guest_ref]||{turns:[]};
   d.memory[draft.guest_ref]={fingerprint:output.conversation?hash(output.conversation.messages):draft.fingerprint,turns:[...memory.turns,{direction:'incoming',text:draft.question},{direction:'outgoing',text:draft.reply}].slice(-6),at:now()};
   event(d,{type:'replied',guest_ref:draft.guest_ref,name:draft.name,question:draft.question,reply:draft.reply});
   notice(d,{kind:'status',draft:projection(draft),text:'已從這間民宿的 LINE 帳號送出，主機已核對回覆內容。'});
  }
  save(r,d);
 }
 async function flush(key){
  if(!notify)return;
  let work;
  await mutate(key,r=>{
   work=null;const d=load(r);
   d.notices=d.notices.filter(n=>now()-n.created<LIFETIME);
   const n=d.notices.find(n=>!n.done&&n.next<=now());
   if(n){n.next=now()+60000;work={owner:r.owner,property:r.property,notice:structuredClone(n)};}
   save(r,d);
  });
  if(!work)return;
  let delivered=false,failed=false;try{delivered=await notify(work)}catch{failed=true;}
  await mutate(key,r=>{const d=load(r);if(delivered)d.notices=d.notices.filter(n=>n.id!==work.notice.id);if(r.automation)r.automation.notification_status=delivered?'accepted':failed?'retrying':'needs_manager_connection';save(r,d);});
 }
 async function tick(key){
  let planning=null;
  await mutate(key,async r=>{
   planning=null;const a=r.automation;
   // Legacy automatic-send policies are never silently migrated to approval mode.
   if(a?.enabled&&a.mode!==MODE){a.enabled=false;a.state='off';for(const j of r.jobs)if(j.automation&&j.status==='queued'){j.status='blocked';j.error_code='owner_approval_required';}return;}
   if(!a?.enabled||!fresh(r)||a.nextAt>now())return;
   if(r.jobs.some(j=>!terminal(j)&&Date.parse(j.approval_expires_at)>now()))return;
   const d=load(r);
   if(a.active_job){const old=r.jobs.find(j=>j.job_id===a.active_job);if(old&&!terminal(old)){old.status='owner_required';old.error_code='action_outcome_uncertain';await ingest(r,old,'owner_required',null,old.error_code);return;}a.active_job=null;}
   for(const draft of d.drafts)if(['awaiting_approval','approved'].includes(draft.status)&&draft.expires_at<=now()){draft.status='expired';draft.version++;}
   const approved=d.drafts.find(x=>x.status==='approved');
   if(approved){approved.status='checking';await add(r,d,'oa_read_conversation',{display_name:approved.name},{draft_id:approved.id,version:approved.version,name:approved.name,guest_ref:approved.guest_ref});return;}
   if(d.thinking){
    if(d.thinking.claimedUntil>now())return;
    if(d.thinking.claimedUntil){event(d,{type:'attention',name:d.thinking.name,reason:'generation_interrupted'});delete d.thinking;halt(r,'generation_interrupted');save(r,d);return;}
    d.thinking.claimedUntil=now()+90000;planning={...d.thinking,policy_id:a.id,bot_id:a.bot_id,property:r.property,memory:d.memory[d.thinking.guest_ref]?.turns||[]};save(r,d);return;
   }
   const next=d.pending.shift();
   if(next&&!d.blocked[next.guest_ref])await add(r,d,'oa_read_conversation',{display_name:next.name},next);
   else await add(r,d,'oa_list_conversations',{});
  });
  if(planning){
   let result,error;
   try{result=await bridge.plan(planning.bot_id,{messages:planning.conversation.messages,memory:planning.memory},planning.property);}
   catch(e){error=['provider_error','provider_not_configured','invalid_model_output'].includes(e.message)?e.message:'bot_unavailable';}
   await mutate(key,r=>{
    const a=r.automation,d=load(r);if(a?.id!==planning.policy_id||d.thinking?.token!==planning.token)return;
    delete d.thinking;if(!a.enabled||r.revoked){save(r,d);return;}
    if(d.drafts.some(x=>x.guest_ref===planning.guest_ref&&x.fingerprint===planning.fingerprint&&['awaiting_approval','approved','checking','sending','sent'].includes(x.status))){a.nextAt=now();save(r,d);return;}
    for(const old of d.drafts)if(old.guest_ref===planning.guest_ref&&['awaiting_approval','approved'].includes(old.status))invalidate(d,old,'對話已有新版草稿。');
    const questions=planning.conversation.messages.filter(m=>m.direction==='incoming').slice(-3).map(m=>m.text).join('\n');
    const draft={id:token(),version:1,guest_ref:planning.guest_ref,name:planning.name,question:questions,fingerprint:planning.fingerprint,reply:error||result.needs_owner?'':result.reply,needs_owner:!!error||result.needs_owner,bot_version:result?.bot_version||'',status:'awaiting_approval',created_at:now(),expires_at:now()+LIFETIME};
    // Bound history while retaining outstanding approval work.
    d.drafts=d.drafts.filter(x=>['awaiting_approval','approved','checking','sending','uncertain'].includes(x.status)||x.created_at>now()-LIFETIME);
    if(d.drafts.length>=100){a.enabled=false;halt(r,'approval_capacity');save(r,d);return;}
    d.drafts.push(draft);if(draft.needs_owner)a.handoffs++;
    notice(d,{kind:'draft',draft:projection(draft)});event(d,{type:'drafted',name:draft.name,question:draft.question,reply:draft.reply});
    a.state='watching';a.nextAt=now();save(r,d);
   });
  }
  await flush(key);
 }
 async function permit(r,j){
  need(j?.automation&&r.automation?.enabled&&r.automation.mode===MODE&&r.automation.id===j.automation.policy_id,'automation_paused',409);need(fresh(r),'line_login_required',409);
  if(j.action==='oa_reply'){
   const c=open(j.auto_context,scope(r)+':'+j.job_id),draft=load(r).drafts.find(x=>x.id===c.draft_id);
   need(draft?.status==='sending'&&draft.version===c.version&&draft.approved_version===c.version&&draft.expires_at>now(),'owner_approval_required',409);
   if(!draft.edited){const config=await bridge.config(j.automation.bot_id,r.property);need(config.version===draft.bot_version,'knowledge_changed',409);}
  }
  return true;
 }
 return {command,tick,ingest,permit,view};
}
