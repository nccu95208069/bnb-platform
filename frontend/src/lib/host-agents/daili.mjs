import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {customerCrypto} from './customer.mjs';
const PREFIX='sweetfun-os:daili-manager:v1:',DAY=86400000;
const MEDIA_START='2026-09-28T09:04:05.000Z';
const CAS="if (redis.call('GET',KEYS[1]) or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
const hash=v=>createHash('sha256').update(v).digest('hex');
const need=(ok,code,status=409)=>{if(!ok){const e=new Error(code);e.code=code;e.status=status;throw e;}};
export function dailiConfig(){
 if(!process.env.DAILI_MANAGER_CONNECTION)return null;
 const c=JSON.parse(process.env.DAILI_MANAGER_CONNECTION);
 need(/^[a-f0-9]{32}$/.test(c.channel)&&typeof c.token==='string'&&c.token.length>=32&&Number.isFinite(Date.parse(c.starts_at))&&Array.isArray(c.properties)&&c.properties.length>0&&c.properties.length<=10,'daili_config_invalid');
 for(const p of c.properties)need(/^[a-z0-9_-]{1,50}$/.test(p.id)&&/^[a-f0-9-]{36}$/.test(p.daili_property_id),'daili_config_invalid');
 return c;
}
export function dailiProperty(owner,property){const c=dailiConfig();return c&&c.channel===hash('manager:'+owner).slice(0,32)?c.properties.find(p=>p.id===property):null;}
export function createDaili(redis,manager,{now=()=>Date.now(),fetcher=fetch}={}){
 const vault=()=>customerCrypto(process.env.CALENDAR_OWNER_SESSION_SECRET);
 const key=(owner,p)=>PREFIX+hash(owner+'|'+p);
 const fresh=()=>({enabled:true,drafts:[],notices:[],muted:[],offset:0});
 const read=async(owner,p)=>{const k=key(owner,p),raw=await redis(['GET',k]);return raw?vault().open(raw,k):fresh();};
 async function mutate(owner,p,fn){const k=key(owner,p);for(let i=0;i<8;i++){const raw=await redis(['GET',k]),d=raw?vault().open(raw,k):fresh(),result=fn(d);if(await redis(['EVAL',CAS,1,k,raw||'',vault().seal(d,k)])===1)return result;}need(false,'busy');}
 function notice(d,a,kind='draft',text=''){d.notices.push({id:randomUUID(),draft_id:a.id,version:a.version,kind,text,created_at:now()});}
 const project=a=>({id:a.id,name:a.name,question:a.question,reply:a.reply,version:a.version,status:a.status,identity:a.identity||null,binding:a.binding||null,binding_state:a.binding_state||null,created_at:a.created_at,expires_at:a.expires_at});
 async function api(path,body){
  const c=dailiConfig();need(c,'daili_not_configured');
  const r=await fetcher('https://bnb-reply-copilot-2efedcw3vq-de.a.run.app/api/v1/customer-manager/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(22000)});
  if(!r.ok){const e=new Error('daili_unavailable');e.code='daili_unavailable';e.status=503;e.upstreamStatus=r.status;throw e;}return r.json();
 }
 const sameSource=(a,b)=>a.conversation_id===b.conversation_id&&a.stamp===b.stamp&&a.suggestion_id===b.suggestion_id&&a.source_hash===b.source_hash;
 function expire(d){for(const a of d.drafts){
  if(a.oa_tag&&!['verified','needs_attention','disabled'].includes(a.oa_tag.status))a.oa_tag.status='disabled';
  if(a.identity&&a.contract_version!==2&&['awaiting_approval','approved'].includes(a.status)){a.status='stale';a.version++;}
  if(a.binding_state==='binding'&&a.binding_at+90000<now()){a.binding_state='uncertain';notice(d,a,'status','訂單確認結果待核對，尚未傳送訊息，請到 Daili 查看。');}
 if(!a.identity&&['awaiting_approval','approved'].includes(a.status)&&d.drafts.some(b=>b.status==='sent'&&!b.identity&&sameSource(a,b)))a.status='stale';if(a.expires_at<=now()&&['awaiting_approval','approved'].includes(a.status))a.status='expired';if(a.status==='sending'&&a.sending_at+90000<now()){a.status='uncertain';notice(d,a,'status','傳送結果尚未確認，請在 Daili 查看，勿重複送出。');}}}
 async function activity(owner,p){need(dailiProperty(owner,p),'daili_not_configured');return mutate(owner,p,d=>{expire(d);return {drafts:d.drafts.map(project),enabled:d.enabled,last_sync:d.last_sync||null,error:d.error||null,source:'daili',media_enabled:true,media_sync:d.media_sync||null,media_pending:d.notices.filter(n=>n.kind==='media').length,muted:d.muted.map(id=>({id,name:d.drafts.find(a=>a.conversation_id===id)?.name||'已接手的客人'}))};});}
 async function decide(owner,p,b){need(dailiProperty(owner,p),'daili_not_configured');const binding=await manager.owner(owner,'status');need(binding.bound&&binding.webhook_verified,'manager_not_configured');return mutate(owner,p,d=>{
  expire(d);const a=d.drafts.find(x=>x.id===b.draft_id);need(a,'draft_not_found',404);
  if(b.request_id&&a.last_action_id===b.request_id)return {draft:project(a)};
  need(a.version===b.version&&(a.status==='awaiting_approval'||(b.action==='bind'&&a.status==='sent'))&&a.expires_at>now(),'draft_changed');
  need(!['requested','binding','uncertain'].includes(a.binding_state),'binding_in_progress');
  if(b.action==='edit'){need(typeof b.text==='string'&&b.text.trim()&&b.text.length<=1000&&!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(b.text),'invalid_customer_input');a.reply=b.text.trim();a.edited=true;a.version++;notice(d,a);}
  else if(b.action==='bind'){need(d.enabled,'automation_paused');need(a.identity?.selected&&!a.binding,'booking_confirmation_unavailable');a.binding_state='requested';a.bind_id=randomUUID();a.bind_owner_revision=binding.binding_revision;a.version++;}
  else if(b.action==='approve'){need(d.enabled,'automation_paused');need(a.reply.trim(),'reply_required');a.status='approved';a.binding_revision=binding.binding_revision;a.approved_at=now();a.send_id=randomUUID();}
  else if(b.action==='takeover'){a.status='dismissed';if(!d.muted.includes(a.conversation_id))d.muted.push(a.conversation_id);}
  else need(false,'invalid_action');
  a.last_action_id=b.request_id;return {draft:project(a)};
 });}
 async function resume(owner,p,id){need(dailiProperty(owner,p)&&typeof id==='string','invalid_request');return mutate(owner,p,d=>{need(d.muted.includes(id),'not_found',404);d.muted=d.muted.filter(x=>x!==id);for(const a of d.drafts)if(a.conversation_id===id&&a.status==='dismissed')a.signature='resumed:'+a.id;return {ok:true};});}
 async function toggle(owner,p,enabled){need(dailiProperty(owner,p)&&typeof enabled==='boolean','invalid_request');return mutate(owner,p,d=>{d.enabled=enabled;if(!enabled)for(const a of d.drafts)if(a.status==='approved')a.status='awaiting_approval';return {enabled};});}
 async function sync(owner,p,deadline){
  const mapping=dailiProperty(owner,p);need(mapping,'daili_not_configured');
  // A function lease bounds overlapping cron invocations. All owner actions
  // still use CAS independently; external side effects never run inside CAS.
  const lease=key(owner,p)+':lease',leaseId=randomUUID();
  if(await redis(['SET',lease,leaseId,'NX','EX',70])!=='OK')return;
  try{
   let d=await read(owner,p);const connection=await manager.owner(owner,'status');if(!d.enabled||!connection.bound||!connection.webhook_verified)return;
   await mutate(owner,p,s=>{expire(s);});
   d=await read(owner,p);
   for(const a of d.drafts.filter(x=>x.binding_state==='requested')){
    if(now()>deadline-24000)break;
    const approved=await mutate(owner,p,s=>{const x=s.drafts.find(x=>x.id===a.id);if(!s.enabled||x?.binding_state!=='requested')return null;if(x.bind_owner_revision!==connection.binding_revision||x.expires_at<=now()){x.binding_state='stale';x.version++;notice(s,x);return null;}x.binding_state='binding';x.binding_at=now();return structuredClone(x);});
    if(!approved)continue;
    let result;try{result=await api('bind',{request_id:approved.bind_id,property_id:mapping.daili_property_id,conversation_id:approved.conversation_id,identity_snapshot:approved.identity.snapshot,reservation_id:approved.identity.selected.reservation_id});}catch{result={status:'uncertain'};}
    await mutate(owner,p,s=>{const x=s.drafts.find(x=>x.id===a.id);if(x?.binding_state!=='binding')return;x.binding_state=result.status;x.version++;
     if(result.status==='bound')x.binding=result.identity;
     if(result.status==='stale')x.status='stale';
     notice(s,x,'binding_status',result.status==='bound'?`訂單已確認，Daili 住宿標記：${result.identity.labels.map(l=>l.label).join('、')}。尚未因本次確認傳送任何訊息。${result.identity.sheet_writeback==='SUCCESS'?'訂單表關聯已更新。':'訂單表回寫待處理。'}`:result.status==='stale'?'訂單或證據已更新，這次沒有綁定，請查看最新卡片。':'訂單確認結果待核對，尚未傳送訊息，請到 Daili 查看。');
     if(result.status==='bound')notice(s,x);
    });
   }
   d=await read(owner,p);
   for(const a of d.drafts.filter(x=>x.status==='approved')){
    if(now()>deadline-24000)break;
    const approved=await mutate(owner,p,s=>{const x=s.drafts.find(x=>x.id===a.id);if(!s.enabled||x?.status!=='approved'||x.expires_at<=now())return null;if(x.binding_revision!==connection.binding_revision){x.status='awaiting_approval';x.version++;notice(s,x);return null;}x.status='sending';x.sending_at=now();return structuredClone(x);});
    if(!approved)continue;
    let result;try{result=await api('send',{request_id:approved.send_id,property_id:mapping.daili_property_id,conversation_id:approved.conversation_id,stamp:approved.stamp,suggestion_id:approved.suggestion_id,source_hash:approved.source_hash,text:approved.reply,contract_version:2,...(approved.identity?{identity_snapshot:approved.identity.snapshot,reservation_id:approved.identity.selected?.reservation_id||null,...(approved.binding?.request_id?{binding_request_id:approved.binding.request_id}:{})}:{})});}catch{result={status:'uncertain'};}
    await mutate(owner,p,s=>{const x=s.drafts.find(x=>x.id===approved.id);if(x.status!=='sending')return;x.status=['sent','stale'].includes(result.status)?result.status:'uncertain';x.message_id=result.message_id||null;
     notice(s,x,'status',x.status==='sent'?'LINE 已接受傳送，請到與原民宿帳號的聊天查看；此回報不代表手機已顯示，若未收到請勿重複核准。':x.status==='stale'?'客人訊息或回覆內容已更新，這次沒有送出，請查看最新草稿。':'傳送結果尚未確認，請在 Daili 查看，勿重複送出。');if(x.status==='sent'&&x.identity?.selected&&!x.binding)notice(s,x);});
   }
   d=await read(owner,p);
   if(d.enabled&&now()<deadline-24000){
    const page=await api('queue?'+new URLSearchParams({property_id:mapping.daili_property_id,since:new Date(Math.max(Date.parse(dailiConfig().starts_at),now()-7*DAY)).toISOString(),offset:String(d.offset||0),limit:'5'}));
    await mutate(owner,p,s=>{
     if(!s.enabled)return;
     const retired=new Set(page.retired_suggestion_ids||[]);
     for(const old of s.drafts)if(retired.has(old.suggestion_id)&&['awaiting_approval','approved'].includes(old.status))old.status='stale';
     for(const item of page.items){
      need(item.property_id===mapping.daili_property_id,'daili_scope_mismatch');
      if(s.muted.includes(item.conversation_id)||s.drafts.some(a=>a.conversation_id===item.conversation_id&&['sending','uncertain'].includes(a.status)))continue;
      const signature=hash(JSON.stringify([item.conversation_id,item.stamp,item.suggestion_id,item.source_hash,...(item.identity?[item.identity.snapshot,item.question]:[])]));
      if(s.drafts.some(a=>a.conversation_id===item.conversation_id&&a.stamp===item.stamp&&(a.binding||['requested','binding','uncertain'].includes(a.binding_state))))continue;
      if(s.drafts.some(a=>a.signature===signature||(!item.identity&&!a.identity&&sameSource(a,item))))continue;
      for(const old of s.drafts.filter(a=>a.conversation_id===item.conversation_id&&['awaiting_approval','approved'].includes(a.status)))old.status='stale';
      const a={contract_version:2,id:randomBytes(24).toString('base64url'),signature,conversation_id:item.conversation_id,stamp:item.stamp,suggestion_id:item.suggestion_id,source_hash:item.source_hash,identity:item.identity||null,name:String(item.name).slice(0,100),question:String(item.question).slice(0,2000),reply:item.reply.length<=1000?item.reply:'',version:1,status:'awaiting_approval',created_at:now(),expires_at:now()+DAY};
      s.drafts.push(a);notice(s,a);
     }
     s.offset=page.next_offset;s.last_sync=now();s.error=null;
     s.drafts=s.drafts.filter(a=>a.created_at>now()-7*DAY||['approved','sending','uncertain'].includes(a.status)||['requested','binding','uncertain'].includes(a.binding_state));
    });
   }
   d=await read(owner,p);
   if(d.enabled&&now()<deadline-24000&&d.notices.filter(n=>n.kind==='media').length<30){
    const since=new Date(Math.max(Date.parse(MEDIA_START),Date.parse(dailiConfig().starts_at))).toISOString();
    const cursor=d.media_cursor||{at:since,id:''};
    const feed=await api('attachments?'+new URLSearchParams({property_id:mapping.daili_property_id,since,after:cursor.at,after_id:cursor.id,limit:'10'}));
    await mutate(owner,p,s=>{
     if(!s.enabled)return;
     for(const item of feed.items){
      if(!s.muted.includes(item.conversation_id))s.notices.push({id:randomUUID(),expired_notice_id:randomUUID(),kind:'media',media:item,created_at:now()});
      s.media_cursor={at:item.created_at,id:item.id};
     }
     s.media_sync=now();
    });
   }
   d=await read(owner,p);
   for(const n of d.notices.slice(0,5)){
    if(n.kind==='media'){
     if(now()>deadline-31000)break;
     const latest=await read(owner,p);if(!latest.enabled)break;
     if(!latest.muted.includes(n.media.conversation_id)){
      const expired=n.created_at+DAY<now();let attachment;
      if(expired)attachment={kind:'unavailable',reason:'這則媒體通知已逾 24 小時；為避免重複轉傳，請回民宿原對話查看。'};
      else try{attachment=await api('attachment/'+encodeURIComponent(n.media.id)+'?'+new URLSearchParams({property_id:mapping.daili_property_id}));}
      catch(e){if(e.upstreamStatus!==404)throw e;attachment={kind:'unavailable',reason:'這則媒體已無法取得，請回民宿原對話查看。'};}
      if(!await manager.notify({owner,property:p,notice:{...n,id:expired?n.expired_notice_id:n.id,attachment}}))break;
     }
     await mutate(owner,p,s=>{s.notices=s.notices.filter(x=>x.id!==n.id);});
     continue;
    }

    if(now()>deadline-9000)break;
    const latest=await read(owner,p),a=latest.drafts.find(x=>x.id===n.draft_id);
    const obsolete=!a||a.version!==n.version||(n.kind==='draft'&&a.status!=='awaiting_approval'&&!(a.status==='sent'&&a.identity?.selected&&!a.binding))||n.created_at+DAY<now();
    if(!obsolete&&!await manager.notify({owner,property:p,notice:{...n,draft:project(a)}}))break;
    await mutate(owner,p,s=>{s.notices=s.notices.filter(x=>x.id!==n.id);});
   }
  }catch(e){await mutate(owner,p,s=>{s.error=e.code||'daili_unavailable';});throw e;}
  finally{await redis(['EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",1,lease,leaseId]);}
 }
 return {activity,decide,toggle,resume,sync,async run(){const c=dailiConfig();if(!c)return {configured:false};const owner=await redis(['GET','sweetfun-os:customer-manager:v1:route:'+c.channel]);need(owner,'manager_not_configured');const registered=await manager.properties(owner),deadline=now()+50000;const rotation=Math.floor(now()/60000)%c.properties.length;const ordered=[...c.properties.slice(rotation),...c.properties.slice(0,rotation)];for(const p of ordered){need(registered.some(x=>x.id===p.id),'property_not_configured');if(now()<deadline-10000)await sync(owner,p.id,deadline);}return {configured:true};}};
}
