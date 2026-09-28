import {createAutomation} from './automation.mjs';
import {randomBytes,createHash} from 'node:crypto';
import {suggestReply} from './suggest.mjs';
import {polishReply} from './polish.mjs';
import {customerCrypto,customerPayload,customerOutput,OA_ACTIONS,READ_ACTIONS,WRITE_ACTIONS} from './customer.mjs';
export const AGENT='bnb-customer-service',VERSION='1.0';
const TTL=30*86400,PREFIX='sweetfun-os:host-relay:v1:';
export class RelayError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
const need=(ok,code='invalid_request',status=400)=>{if(!ok)throw new RelayError(code,status)};
const hash=x=>createHash('sha256').update(x).digest('hex');
const opaque=()=>randomBytes(24).toString('base64url');
const identifier=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(x);
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const CAS="if (redis.call('GET',KEYS[1]) or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1";
export const REDEEM="local p=redis.call('GET',KEYS[1]); if not p or p~=ARGV[1] then return 0 end; if redis.call('EXISTS',KEYS[2])==1 then return -1 end; if (redis.call('GET',KEYS[4]) or '')~=ARGV[6] then return -2 end; redis.call('DEL',KEYS[1]); redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[4]); redis.call('SET',KEYS[3],ARGV[3],'EX',ARGV[4]); redis.call('SET',KEYS[4],ARGV[5],'EX',ARGV[4]); return 1";
export function createRelay(redis,now=()=>Date.now(),options={}){
 const vault=()=>customerCrypto(options.secret||process.env.CALENDAR_OWNER_SESSION_SECRET);
 const iso=ms=>new Date(ms??now()).toISOString();
 const get=async k=>{const r=await redis(['GET',PREFIX+k]);return r?JSON.parse(r):null};
 async function mutate(key,fn){for(let i=0;i<8;i++){const raw=await redis(['GET',PREFIX+key]);const v=raw?JSON.parse(raw):null;need(v,'not_found',404);const result=await fn(v);if(await redis(['EVAL',CAS,1,PREFIX+key,raw,JSON.stringify(v),TTL])===1)return result;}throw new RelayError('busy',409)}
 const binding=(owner,property)=>hash(owner+'|'+property);
 function property(p){need(p==='sweetfun','property_not_configured',409)}
 function header(h,name){return h.get(name)||''}
 async function auth(h,b){
  const token=header(h,'authorization').replace(/^Bearer /,'');need(/^[\w-]{32}$/.test(token),'unauthorized',401);
  const t=await get('token:'+hash(token));need(t,'unauthorized',401);const r=await get('host:'+t.binding);need(r&&!r.revoked&&r.tokenHash===hash(token)&&Date.parse(r.expiresAt)>now(),'unauthorized',401);
  need(b.protocol_version===VERSION&&header(h,'x-protocol-version')===VERSION,'protocol_mismatch');
  for(const [k,v]of Object.entries({host_id:r.hostId,agent_id:AGENT,property_id:r.property}))need(b[k]===v&&header(h,'x-'+k.replace('_','-'))===v,'scope_mismatch',403);
  need(typeof b.nonce==='string'&&/^[\w-]{16,128}$/.test(b.nonce)&&header(h,'x-request-nonce')===b.nonce,'invalid_nonce');
  need(await redis(['SET',PREFIX+'nonce:'+hash(token+'|'+b.nonce),'1','NX','EX',300])==='OK','replayed_nonce',409);
  return {r,key:'host:'+t.binding,tokenHash:hash(token)};
 }
 const receipt=(b,extra)=>({protocol_version:VERSION,nonce:b.nonce,...extra});
 const current=(r,t)=>need(r&&!r.revoked&&r.tokenHash===t&&Date.parse(r.expiresAt)>now(),'unauthorized',401);
 function status(r){if(!r||r.revoked)return {agent_id:AGENT,host_status:'offline',paired:false,messaging_api_status:'not_configured'};const fresh=r.lastSeen&&now()-Date.parse(r.lastSeen)<60000;return {agent_id:AGENT,host_id:r.hostId,property_id:r.property,paired:true,host_status:fresh?r.status.host_status:'offline',last_verified_at:r.lastSeen||null,emulator:fresh?r.status.emulator:null,messaging_api_status:'not_configured',capabilities:{connection_probe:!!fresh,...Object.fromEntries(OA_ACTIONS.map(a=>[a,!!fresh&&r.status.actions?.includes(a)]))},automation:auto.view(r),jobs:(r.jobs||[]).slice(-5).map(j=>({job_id:j.job_id,status:Date.parse(j.approval_expires_at)<=now()&&['queued','leased'].includes(j.status)?'expired':j.status,action:j.action,created_at:j.created_at,error_code:j.error_code||null,evidence:j.evidence||[]}))};}
 async function privateGet(key,scope){const v=await get(key);need(v&&Date.parse(v.expiresAt)>now(),'customer_expired',409);return vault().open(v.sealed,scope);}
 async function privatePut(key,value,scope){await redis(['SET',PREFIX+key,JSON.stringify({expiresAt:iso(now()+300000),sealed:vault().seal(value,scope)}),'EX',300]);}
 const ready=r=>{need(r&&!r.revoked,'not_paired',409);need(r.lastSeen&&now()-Date.parse(r.lastSeen)<60000,'host_offline',409);need(r.status.host_status==='ready','line_login_required',409);};
 async function queueCustomer(key,owner,action,payload,requestId){
  need(typeof requestId==='string'&&/^[\w-]{8,128}$/.test(requestId),'invalid_request_id');
  const scope=binding(owner,'sweetfun'),digest=hash(canonical({action,payload})),jobId=opaque();
  return mutate(key,async r=>{ready(r);need(r.status.actions?.includes(action),'capability_unavailable',409);
   if(r.automation?.enabled)throw new RelayError('automation_pause_required',409);
   r.customerRequests??={};const old=r.customerRequests[requestId];if(old){need(old.digest===digest,'request_conflict',409);return {job_id:old.jobId,status:r.jobs.find(j=>j.job_id===old.jobId)?.status||'expired'};}
   need(!r.jobs.some(j=>['queued','leased'].includes(j.status)&&Date.parse(j.approval_expires_at)>now()),'job_in_progress',409);
   for(const [id,v]of Object.entries(r.customerRequests))if(now()-v.at>TTL*1000)delete r.customerRequests[id];
   need(Object.keys(r.customerRequests).length<5000,'request_capacity',429);
   await privatePut('customer-payload:'+jobId,payload,scope+':'+jobId);
   const j={job_id:jobId,idempotency_key:requestId,agent_id:AGENT,property_id:'sweetfun',action,approval_id:opaque(),approval_expires_at:iso(now()+300000),approval_action_sha256:hash(canonical({agent_id:AGENT,property_id:'sweetfun',action,payload})),status:'queued',created_at:iso()};
   r.jobs=r.jobs.slice(-49);r.jobs.push(j);r.customerRequests[requestId]={jobId,digest,at:now()};return {job_id:jobId,status:'queued'};
  });
 }

 const auto=createAutomation({mutate,get,need,now,bridge:options.guest,
  seal:(value,scope)=>vault().seal(value,scope),open:(value,scope)=>vault().open(value,scope),
  queue:async(r,action,payload,automation)=>{
   need(r.status.actions?.includes(action),'capability_unavailable',409);
   const id=opaque();await privatePut('customer-payload:'+id,customerPayload(action,payload),binding(r.owner,r.property)+':'+id);
   const j={job_id:id,idempotency_key:'auto-'+id,agent_id:AGENT,property_id:r.property,action,automation,approval_id:automation.policy_id,approval_expires_at:iso(now()+300000),approval_action_sha256:hash(canonical({agent_id:AGENT,property_id:r.property,action,payload})),status:'queued',created_at:iso()};
   r.jobs=r.jobs.slice(-49);r.jobs.push(j);return j;
  }});

 return {
 async owner(owner,operation,b={}){
  property(b.property_id||'sweetfun');const key='host:'+binding(owner,'sweetfun');
  if(operation==='status')return status(await get(key));
  if(operation.startsWith('automation-')){const result=await auto.command(key,operation,b);if(result!==undefined)return result;}
  if(operation==='session-resume'){need(b.owner_confirmed===true,'confirmation_required',409);return mutate(key,r=>{need(r&&!r.revoked,'not_paired',409);need(r.lastSeen&&now()-Date.parse(r.lastSeen)<60000,'host_offline',409);need(!r.jobs.some(j=>['queued','leased'].includes(j.status)&&Date.parse(j.approval_expires_at)>now()),'job_in_progress',409);const payload={owner_confirmed:true},j={job_id:opaque(),idempotency_key:'resume-'+opaque(),agent_id:AGENT,property_id:r.property,action:'session_attest',payload,approval_id:opaque(),approval_expires_at:iso(now()+300000),approval_action_sha256:hash(canonical({agent_id:AGENT,property_id:r.property,action:'session_attest',payload})),status:'queued',created_at:iso()};r.jobs.push(j);return {job_id:j.job_id,status:j.status};});}
  if(operation==='pairing'){
   const old=await get(key);need(!old||old.revoked,'already_paired',409);
   const code=opaque(),data={owner,property:'sweetfun',binding:binding(owner,'sweetfun'),expiresAt:iso(now()+300000)};
   await redis(['SET',PREFIX+'pair:'+hash(code),JSON.stringify(data),'EX',300]);return {pairing_code:code,expires_at:data.expiresAt,property_id:'sweetfun',agent_id:AGENT};
  }
  if(operation==='disconnect')return mutate(key,r=>{need(r.owner===owner,'forbidden',403);r.revoked=true;r.jobs=[];return {revoked:true}});
  if(operation==='customer-suggest'){
   const r=await get(key);ready(r);const j=r.jobs?.find(j=>j.job_id===b.read_job_id&&j.action==='oa_read_conversation'&&j.status==='succeeded');need(j,'read_required',409);
   const c=await privateGet('customer-result:'+j.job_id,binding(owner,'sweetfun'));need(Number.isInteger(b.message_index)&&b.message_index>=0,'invalid_customer_input');const m=c.messages[b.message_index];need(m&&m.direction==='incoming','incoming_message_required',409);
   try{return options.guest?await options.guest.plan('concierge',{messages:c.messages.slice(0,b.message_index+1),memory:[]}):await (options.suggest||suggestReply)(m.text)}catch(e){throw new RelayError(['provider_not_configured','provider_error','invalid_model_output'].includes(e.message)?e.message:'invalid_customer_input',400)}
  }
  if(operation==='customer-polish'){try{return await (options.polish||polishReply)(b.text)}catch(e){throw new RelayError(['provider_not_configured','provider_error','invalid_model_output','draft_facts_changed'].includes(e.message)?e.message:'invalid_customer_input',400)}}
  if(operation==='customer-read'){
   need(READ_ACTIONS.includes(b.action),'invalid_customer_action');let payload;try{payload=customerPayload(b.action,b.payload||{})}catch{throw new RelayError('invalid_customer_input')}
   return queueCustomer(key,owner,b.action,payload,b.request_id);
  }
  if(operation==='customer-result'){
   need(typeof b.job_id==='string'&&/^[\w-]{32}$/.test(b.job_id),'invalid_job_id');const r=await get(key);need(r&&!r.revoked,'not_paired',409);const j=r.jobs?.find(j=>j.job_id===b.job_id);need(j&&OA_ACTIONS.includes(j.action),'job_not_found',404);
   const pending=['queued','leased'].includes(j.status),expired=pending&&Date.parse(j.approval_expires_at)<=now();
   let output=null;if(j.status==='succeeded'||j.status==='partial_success'){try{output=await privateGet('customer-result:'+j.job_id,binding(owner,'sweetfun'))}catch(e){if(e.code!=='customer_expired')throw e;}}
   return {job_id:j.job_id,action:j.action,status:expired?'expired':j.status,error_code:j.error_code||null,output,expired:!pending&&!output};
  }
  if(operation==='customer-prepare'){
   const r=await get(key);ready(r);need(WRITE_ACTIONS.includes(b.action)&&r.status.actions?.includes(b.action),'capability_unavailable',409);
   const readJob=r.jobs?.find(j=>j.job_id===b.read_job_id&&j.action==='oa_read_conversation'&&j.status==='succeeded');need(readJob,'read_required',409);
   const conversation=await privateGet('customer-result:'+readJob.job_id,binding(owner,'sweetfun'));need(conversation.expires_at&&Date.parse(conversation.expires_at)>now(),'customer_expired',409);
   let payload;try{payload=customerPayload(b.action,{...(b.payload||{}),conversation_ref:conversation.conversation_ref,display_name:conversation.display_name})}catch{throw new RelayError('invalid_customer_input')}
   const draftId=opaque(),draft={action:b.action,payload,requestId:'draft-'+draftId,hostToken:r.tokenHash};await privatePut('customer-draft:'+draftId,draft,binding(owner,'sweetfun'));
   return {draft_id:draftId,action:b.action,display_name:conversation.display_name,text:payload.text||payload.tag||payload.new_name,expires_at:iso(now()+300000)};
  }
  if(operation==='customer-confirm'){
   need(b.confirmed===true,'confirmation_required',409);need(typeof b.draft_id==='string'&&/^[\w-]{32}$/.test(b.draft_id),'invalid_draft');const draft=await privateGet('customer-draft:'+b.draft_id,binding(owner,'sweetfun'));const r=await get(key);ready(r);need(r.tokenHash===draft.hostToken,'customer_expired',409);
   return queueCustomer(key,owner,draft.action,draft.payload,draft.requestId);
  }
  if(operation==='probe'){
   need(typeof b.request_id==='string'&&/^[\w-]{8,128}$/.test(b.request_id),'invalid_request_id');
   return mutate(key,r=>{need(r.owner===owner&&!r.revoked,'not_paired',409);need(r.lastSeen&&now()-Date.parse(r.lastSeen)<60000,'host_offline',409);r.jobs??=[];const old=r.jobs.find(j=>j.idempotency_key===b.request_id);if(old)return {job_id:old.job_id,status:old.status};need(!r.jobs.some(j=>['queued','leased'].includes(j.status)&&Date.parse(j.approval_expires_at)>now()),'job_in_progress',409);
    const job={job_id:opaque(),idempotency_key:b.request_id,agent_id:AGENT,property_id:'sweetfun',action:'ui_snapshot',payload:{},approval_id:opaque(),approval_expires_at:iso(now()+300000),approval_action_sha256:hash(canonical({agent_id:AGENT,property_id:'sweetfun',action:'ui_snapshot',payload:{}})),status:'queued',created_at:iso()};
    // Retain idempotency receipts separately for 30 days; keep this bounded status list small.
    r.jobs=r.jobs.slice(-19);r.jobs.push(job);return {job_id:job.job_id,status:job.status};
   });
  }
  throw new RelayError('not_found',404);
 },
 async host(path,h,b){
  if(path==='pairing/redeem'){
   need(b.protocol_version===VERSION&&header(h,'x-protocol-version')===VERSION,'protocol_mismatch');
   need(typeof b.nonce==='string'&&/^[\w-]{16,128}$/.test(b.nonce)&&b.nonce===header(h,'x-request-nonce'),'invalid_nonce');
   need(identifier(b.host_id)&&b.agent_id===AGENT&&b.property_id==='sweetfun','scope_mismatch',403);
   need(typeof b.pairing_code==='string'&&/^[\w-]{32}$/.test(b.pairing_code),'pairing_invalid',401);
   const pk=PREFIX+'pair:'+hash(b.pairing_code),raw=await redis(['GET',pk]);need(raw,'pairing_expired',401);const pair=JSON.parse(raw);need(Date.parse(pair.expiresAt)>now(),'pairing_expired',401);
   const existingRaw=await redis(['GET',PREFIX+'host:'+pair.binding]);const existing=existingRaw?JSON.parse(existingRaw):null;need(!existing||existing.revoked,'already_paired',409);
   const token=opaque(),tokenHash=hash(token),expiresAt=iso(now()+TTL*1000);
   const record={owner:pair.owner,property:pair.property,hostId:b.host_id,tokenHash,expiresAt,revoked:false,sequence:0,lastSeen:null,status:{host_status:'offline'},jobs:[]};
   // Unique generation key makes consuming the code and issuing a token one atomic operation.
   const used=PREFIX+'redeemed:'+hash(b.pairing_code);
   const out=await redis(['EVAL',REDEEM,4,pk,used,PREFIX+'token:'+tokenHash,PREFIX+'host:'+pair.binding,raw,'1',JSON.stringify({binding:pair.binding}),TTL,JSON.stringify(record),existingRaw||'']);
   need(out===1,'pairing_used',409);
   return receipt(b,{host_token:token,token_expires_at:expiresAt,host_id:b.host_id,agent_id:AGENT,property_id:'sweetfun',scope:['heartbeat','jobs:claim','jobs:result','host:revoke','ui:read','ui:operate']});
  }
  const {key,tokenHash}=await auth(h,b);
  if(path==='heartbeat'){
   need(Number.isSafeInteger(b.sequence)&&b.sequence>0,'invalid_sequence');need(Number.isFinite(Date.parse(b.sent_at))&&Math.abs(now()-Date.parse(b.sent_at))<300000,'stale_heartbeat');
   const st=b.status||{};need(['offline','login_required','ready','needs_reauth','error'].includes(st.host_status),'invalid_status');
   const clean={automation_protocol:st.automation_protocol===1?1:0,actions:OA_ACTIONS.filter(a=>Array.isArray(st.workflow_actions)&&st.workflow_actions.includes(a)),host_status:st.host_status,emulator:Object.fromEntries(['boot_completed','app_installed','app_foreground'].map(k=>[k,st.emulator?.[k]===true]))};
   if(clean.host_status==='ready'&&!Object.values(clean.emulator).every(Boolean))clean.host_status='error';
   return mutate(key,r=>{current(r,tokenHash);need(b.sequence>r.sequence,'stale_sequence',409);r.sequence=b.sequence;r.lastSeen=iso();r.status=clean;return receipt(b,{host_id:r.hostId,sequence:r.sequence,accepted:true,server_time:iso()})});
  }
  if(path==='disconnect')return mutate(key,r=>{current(r,tokenHash);r.revoked=true;r.jobs=[];return receipt(b,{revoked:true})});
  if(path==='automation/permit'){const r=await get(key);current(r,tokenHash);const j=r.jobs.find(j=>j.job_id===b.job_id&&j.lease_id===b.lease_id&&j.status==='leased');need(j&&Date.parse(j.lease_expires_at)>now(),'lease_expired',409);await auto.permit(r,j);return receipt(b,{allowed:true,job_id:j.job_id});}
  if(path==='jobs/claim'){
   need(Number.isInteger(b.wait_seconds)&&b.wait_seconds>=0&&b.wait_seconds<=20,'invalid_wait');
   need(Array.isArray(b.capabilities)&&b.capabilities.includes('ui:read'),'capability_missing',403);
   const deadline=Date.now()+b.wait_seconds*1000;await auto.tick(key);do{const claimed=await mutate(key,async r=>{current(r,tokenHash);if(!r.lastSeen||now()-Date.parse(r.lastSeen)>60000)return null;
    if(r.jobs.some(j=>j.status==='leased'&&Date.parse(j.lease_expires_at)>now()))return null;
    const j=r.jobs.find(j=>['queued','leased'].includes(j.status)&&Date.parse(j.approval_expires_at)>now());if(!j)return null;if(WRITE_ACTIONS.includes(j.action)&&!b.capabilities.includes('ui:operate'))return null;
    if(j.automation){try{await auto.permit(r,j);}catch(e){j.status='blocked';j.error_code=e.code||'customer_bot_unavailable';auto.ingest(r,j,'blocked',null,j.error_code);return null;}}
    j.status='leased';j.lease_id=opaque();j.lease_expires_at=iso(now()+90000);
    const {status,created_at,auto_context,...wire}=j;void status;void created_at;void auto_context;if(OA_ACTIONS.includes(j.action)){try{wire.payload=await privateGet('customer-payload:'+j.job_id,binding(r.owner,r.property)+':'+j.job_id)}catch(e){if(e.code!=='customer_expired')throw e;j.status='blocked';j.error_code='customer_expired';return null;}}return receipt(b,wire);
   });if(claimed)return claimed;if(Date.now()>=deadline)return null;await new Promise(resolve=>setTimeout(resolve,1000));}while(Date.now()<=deadline);return null;
  }
  const match=/^jobs\/([\w-]{32})\/result$/.exec(path);
  if(match){
   need(match[1]===b.job_id&&['succeeded','owner_required','needs_reauth','blocked','failed','partial_success','unavailable'].includes(b.status),'invalid_result');
   const resultKey='receipt:'+hash(tokenHash+'|'+b.job_id+'|'+b.idempotency_key);
   // Hash complete response only; never persist screenshot bytes, UI nodes or guest text.
   const digest=hash(canonical({job_id:b.job_id,lease_id:b.lease_id,idempotency_key:b.idempotency_key,status:b.status,output:b.output,evidence:b.evidence,error_code:b.error_code,completed_at:b.completed_at}));
   const saved=await get(resultKey);if(saved){need(saved.digest===digest,'result_conflict',409);return receipt(b,{job_id:b.job_id,idempotency_key:b.idempotency_key,accepted:true,duplicate:true})}
   let customerResult=null,customerScope=null;
   const out=await mutate(key,r=>{current(r,tokenHash);const j=r.jobs.find(j=>j.job_id===b.job_id);need(j&&j.idempotency_key===b.idempotency_key,'job_not_found',404);
    if(j.resultDigest){need(j.resultDigest===digest,'result_conflict',409);if(OA_ACTIONS.includes(j.action)&&['succeeded','partial_success'].includes(b.status)){customerResult=customerOutput(j.action,b.output);customerScope=binding(r.owner,r.property);}return receipt(b,{job_id:j.job_id,idempotency_key:j.idempotency_key,accepted:true,duplicate:true})}
    need(j.status==='leased'&&j.lease_id===b.lease_id&&Date.parse(j.lease_expires_at)>now(),'lease_expired',409);
    if(OA_ACTIONS.includes(j.action)&&['succeeded','partial_success'].includes(b.status)){try{customerResult=customerOutput(j.action,b.output);customerScope=binding(r.owner,r.property)}catch{throw new RelayError('invalid_customer_result')}if(WRITE_ACTIONS.includes(j.action)&&b.status==='succeeded')need(customerResult.verified===true,'unverified_result',409);}
    j.status=b.status;j.resultDigest=digest;j.completed_at=iso();j.error_code=typeof b.error_code==='string'&&/^[a-z_]{1,80}$/.test(b.error_code)?b.error_code:null;
    auto.ingest(r,j,b.status,customerResult,j.error_code);
    j.evidence=Array.isArray(b.evidence)?b.evidence.slice(0,3).map(e=>({screenshot_sha256:typeof e.screenshot_sha256==='string'&&/^[a-f0-9]{64}$/.test(e.screenshot_sha256)?e.screenshot_sha256:null,visible_effect_confirmed:e.visible_effect_confirmed===true})):[];
    return receipt(b,{job_id:j.job_id,idempotency_key:j.idempotency_key,accepted:true});
   });
   if(customerResult)await privatePut('customer-result:'+b.job_id,customerResult,customerScope);
   await redis(['SET',PREFIX+resultKey,JSON.stringify({digest}),'EX',TTL]);return out;
  }
  throw new RelayError('not_found',404);
 }
 };
}
