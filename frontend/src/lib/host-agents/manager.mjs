import {createHash,createHmac,timingSafeEqual,randomBytes,randomUUID} from 'node:crypto';
import {customerCrypto} from './customer.mjs';
import {PAGE_SIZE,action,button,text,categories,overview,visible,bucket,pageMessages,inboxCard,quickNav} from './manager-inbox.mjs';
import {menuImage} from './manager-menu-image.mjs';
const PREFIX='sweetfun-os:customer-manager:v1:',DAY=86400;
const CAS="if (redis.call('GET',KEYS[1]) or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
const hash=v=>createHash('sha256').update(v).digest('hex');
const need=(ok,code,status=400)=>{if(!ok){const e=new Error(code);e.code=code;e.status=status;throw e;}};
const idOK=v=>typeof v==='string'&&/^[a-z0-9][a-z0-9_-]{0,49}$/.test(v);
const clip=(v,n)=>String(v||'').slice(0,n);
export function createManager(redis,{secret=process.env.CALENDAR_OWNER_SESSION_SECRET,now=()=>Date.now(),fetcher=fetch}={}){
 const vault=()=>customerCrypto(secret),channel=owner=>hash('manager:'+owner).slice(0,32);
 const key=owner=>PREFIX+'owner:'+channel(owner);
 const empty=owner=>({owner,properties:[{id:'sweetfun',name:'水芳民宿',oa_id:'@sweetfuntw'}]});
 const read=async owner=>{const raw=await redis(['GET',key(owner)]);return raw?vault().open(raw,key(owner)):empty(owner);};
 async function mutate(owner,fn){for(let i=0;i<8;i++){const raw=await redis(['GET',key(owner)]),d=raw?vault().open(raw,key(owner)):empty(owner),result=await fn(d);if(await redis(['EVAL',CAS,1,key(owner),raw||'',vault().seal(d,key(owner))])===1)return result;}need(false,'busy',409);}
 const safe=d=>({channel_id:channel(d.owner),configured:!!d.accessToken,name:d.name||'客服經理',basic_id:d.basicId||'',bound:!!d.ownerUserId,binding_revision:d.bindingRevision||0,webhook_verified:!!d.webhookVerified,menu_ready:d.inboxMenuRevision===d.bindingRevision&&!!d.inboxMenuId,inbox_version:3,properties:d.properties});
 async function line(d,path,body,retryKey){
  const res=await fetcher('https://api.line.me/v2/bot/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+d.accessToken,'Content-Type':'application/json',...(retryKey?{'X-Line-Retry-Key':retryKey}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
  if(res.status===409&&retryKey&&res.headers.get('x-line-accepted-request-id'))return {};
  if(!res.ok){const e=new Error('line_api_unavailable');e.code='line_api_unavailable';e.status=502;e.providerStatus=res.status;throw e;}return res.status===204?{}:res.json();
 }
 function card(property,draft){
  if(draft.contract_version===3)return {type:'flex',altText:clip(`${property.name}｜${draft.name}：待處理`,400),contents:inboxCard(property,draft)};
  const labels={awaiting_approval:'等待核准',approved:'已核准，等待重新核對',checking:'正在重新核對',sending:'正在送出',sent:'已送出',stale:'已失效',uncertain:'結果待確認',expired:'已過期',dismissed:'已交由你處理'};
  const message=`${property.name}｜${draft.name}\n${labels[draft.status]||draft.status}\n客人訊息${draft.question.length>700?'（節錄）':''}：\n${clip(draft.question,700)}\n\n${draft.binding?'訂單已確認：'+draft.binding.labels.map(l=>l.label).join('、')+'（Daili）\n\n':draft.identity?.summary?clip(draft.identity.summary,900)+'\n\n':''}${draft.reply?'建議回覆：\n'+draft.reply:'這個問題需要你判斷，請修改回覆或自行接手。'}`;
  const actions=['awaiting_approval','sent'].includes(draft.status)&&!['requested','binding','uncertain'].includes(draft.binding_state)?[
   ...(draft.identity?.selected&&!draft.binding?[{label:'確認訂單（不傳訊息）',a:'bind'}]:[]),
   ...(draft.status==='awaiting_approval'?[...(draft.reply?[{label:'核准送出訊息',a:'approve'}]:[]),{label:'修改回覆',a:'edit'},{label:'自行接手',a:'takeover'}]:[])
  ].map(x=>({type:'button',style:x.a==='approve'?'primary':'secondary',action:{type:'postback',label:x.label,data:new URLSearchParams({a:x.a,p:property.id,d:draft.id,v:String(draft.version)}).toString()}})):[];
  return {type:'flex',altText:clip(`${property.name}｜${draft.name}：${labels[draft.status]||draft.status}`,400),contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[{type:'text',text:message,wrap:true,size:'sm'}]},...(actions.length?{footer:{type:'box',layout:'vertical',spacing:'sm',contents:actions}}:{})}};
 }
 async function inbox(owner,readDrafts){
  const state=await read(owner),rows=[],warnings=[],times=[];
  for(const property of state.properties){
   try{const result=await readDrafts(owner,property.id);for(const draft of result.drafts)if(visible(draft))rows.push({property,draft});if(result.last_sync)times.push(result.last_sync);if(result.error||!result.enabled)warnings.push(`${property.name}：${!result.enabled?'整理已暫停':'同步待恢復'}`);}
   catch(e){if(e.code!=='not_paired')warnings.push(`${property.name}：暫時無法讀取`);}
  }
  rows.sort((a,b)=>(a.draft.created_at||0)-(b.draft.created_at||0));
  return {rows,now:now(),warning:warnings.join('；'),refreshedAt:times.length?Math.min(...times):null};
 }
 async function openInbox(owner,category,readDrafts,reviewCards){
  need(Object.hasOwn(categories,category),'invalid_action');
  const data=await inbox(owner,readDrafts);
  if(category==='all')return overview(data.rows,data);
  const rows=data.rows.filter(({draft})=>bucket(draft,now())===category),token=randomBytes(12).toString('hex');
  await mutate(owner,d=>{d.views=Object.fromEntries(Object.entries(d.views||{}).filter(([,v])=>v.until>now()).slice(-19));d.views[token]={category,until:now()+DAY*1000,items:rows.map(({property,draft})=>({p:property.id,id:draft.id})),pages:{}};});
  return showPage(owner,token,0,readDrafts,reviewCards);
 }
 async function showPage(owner,token,page,readDrafts,reviewCards){
  need(/^[a-f0-9]{24}$/.test(token||'')&&Number.isSafeInteger(page)&&page>=0,'invalid_action');
  const state=await read(owner),view=state.views?.[token];need(view&&view.until>now()&&page<Math.max(1,Math.ceil(view.items.length/PAGE_SIZE)),'view_expired');
  const data=await inbox(owner,readDrafts),rows=view.items.slice(page*PAGE_SIZE,page*PAGE_SIZE+PAGE_SIZE).flatMap(ref=>data.rows.filter(row=>row.property.id===ref.p&&row.draft.id===ref.id));
  await mutate(owner,d=>{if(d.views?.[token])d.views[token].pages[page]=rows.map(({property,draft})=>({p:property.id,id:draft.id,v:draft.version}));});
  if(reviewCards)for(const property of new Set(rows.filter(r=>r.draft.contract_version===3).map(r=>r.property.id)))await reviewCards(owner,property,rows.filter(r=>r.property.id===property).map(r=>({id:r.draft.id,v:r.draft.version})));
  return pageMessages(rows,{token,page,total:view.items.length,category:view.category});
 }
 async function batchPreview(owner,q,readDrafts){
  const state=await read(owner),view=state.views?.[q.get('t')],page=Number(q.get('n')),refs=view?.pages?.[page],mode=q.get('mode')==='no_reply'?'no_reply':'approve';
  need(view?.until>now()&&refs?.length&&refs.length<=5,'view_expired');
  const data=await inbox(owner,readDrafts),rows=refs.map(ref=>data.rows.find(row=>row.property.id===ref.p&&row.draft.id===ref.id&&row.draft.version===ref.v));
  need(rows.every(row=>row&&bucket(row.draft,now())===(mode==='approve'?'ready':'no_reply')),'draft_changed');
  const token=randomBytes(12).toString('hex');
  await mutate(owner,d=>{d.batches=Object.fromEntries(Object.entries(d.batches||{}).filter(([,b])=>b.until>now()).slice(-9));d.batches[token]={items:refs,mode,until:now()+600000,results:[],bindingRevision:d.bindingRevision};});
  return {type:'flex',altText:'確認本組操作',contents:{type:'bubble',body:{type:'box',layout:'vertical',spacing:'md',contents:[text(mode==='approve'?`送出這 ${rows.length} 位客人剛才顯示的各自草稿？`:`這 ${rows.length} 位客人這次都不用回？`,{weight:'bold'}),...rows.map(row=>text(`${row.property.name}｜${row.draft.name}`)),text('內容有更新的項目會跳過，保留給你重新確認。',{size:'xs'})]},footer:{type:'box',layout:'vertical',spacing:'sm',contents:[button(mode==='approve'?'確認送出':'確認不用回',{a:'batch_confirm',t:token},true),button('返回總覽',{a:'inbox',c:'all'})]}}};
 }
 async function confirmBatch(owner,token,eventId,decide){
  const work=await mutate(owner,d=>{const b=d.batches?.[token];need(b&&b.until>now()&&b.bindingRevision===d.bindingRevision,'view_expired');need(!b.claim||b.claim===eventId,'already_processed');b.claim=eventId;return structuredClone(b);});
  for(let i=work.results.length;i<work.items.length;i++){
   const ref=work.items[i];let result;
   try{await decide(owner,ref.p,{draft_id:ref.id,version:ref.v,action:work.mode,request_id:`${eventId}:${i}`});result='accepted';}catch(e){if(!e.status||e.status>=500)throw e;result='changed';}
   await mutate(owner,d=>{const b=d.batches?.[token];need(b?.claim===eventId,'view_expired');if(b.results.length===i)b.results.push(result);});
  }
  const final=(await read(owner)).batches[token],accepted=final.results.filter(x=>x==='accepted').length;
  return {type:'text',text:`已接受 ${accepted} 筆${work.mode==='approve'?'核准，重新核對後逐位送出':'不用回覆的決定'}。${final.results.length>accepted?`\n${final.results.length-accepted} 筆狀態已變，請重新查看。`:''}`};
 }
 return {
  properties:async owner=>(await read(owner)).properties,
  async ensureMenu(owner){
   const d=await read(owner);if(!d.ownerUserId||!d.accessToken||!d.webhookVerified||d.inboxMenuRevision===d.bindingRevision)return;
   const lease=key(owner)+':menu-lease',claim=randomUUID();if(await redis(['SET',lease,claim,'NX','EX',45])!=='OK')return;
   try{
    const name='客服經理・待辦 v3',existing=await line(d,'richmenu/list');
    let menu=existing.richmenus?.find(m=>m.name===name),hasImage=false;
    if(menu){const content=await fetcher(`https://api-data.line.me/v2/bot/richmenu/${menu.richMenuId}/content`,{headers:{Authorization:'Bearer '+d.accessToken},signal:AbortSignal.timeout(8000)});hasImage=content.ok;need(content.ok||content.status===404,'menu_unavailable',503);await content.body?.cancel();}
    if(!menu)menu=await line(d,'richmenu',{size:{width:2500,height:843},selected:true,name,chatBarText:'客服待辦',areas:['all','ready','decision','snoozed'].map((c,i)=>({bounds:{x:i*625,y:0,width:625,height:843},action:action(categories[c],{a:'inbox',c})}))});
    if(!hasImage){const uploaded=await fetcher(`https://api-data.line.me/v2/bot/richmenu/${menu.richMenuId}/content`,{method:'POST',headers:{Authorization:'Bearer '+d.accessToken,'Content-Type':'image/png'},body:menuImage,signal:AbortSignal.timeout(8000)});
    need(uploaded.ok,'menu_unavailable',503);}
    const current=await read(owner);need(current.bindingRevision===d.bindingRevision&&current.ownerUserId===d.ownerUserId,'binding_changed');
    await line(d,`user/${d.ownerUserId}/richmenu/${menu.richMenuId}`,{});
    const linked=await line(d,`user/${d.ownerUserId}/richmenu`);need(linked.richMenuId===menu.richMenuId,'menu_unavailable',503);
    await mutate(owner,s=>{if(s.bindingRevision===d.bindingRevision){s.inboxMenuRevision=d.bindingRevision;s.inboxMenuId=menu.richMenuId;}});
   }finally{await redis(['EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",1,lease,claim]);}
  },
  async owner(owner,operation,b={}){
   if(operation==='status')return safe(await read(owner));
   if(operation==='property-add'){
    need(idOK(b.id)&&b.id!=='owner','invalid_property');need(typeof b.name==='string'&&b.name.trim()&&b.name.length<=80,'invalid_property');need(typeof b.oa_id==='string'&&/^@[\w.-]{1,64}$/.test(b.oa_id),'invalid_oa_id');
    return mutate(owner,d=>{need(!d.properties.some(p=>p.id===b.id||p.oa_id===b.oa_id),'property_exists',409);need(d.properties.length<10,'property_capacity',409);d.properties.push({id:b.id,name:b.name.trim(),oa_id:b.oa_id});return safe(d);});
   }
   if(operation==='configure'){
    need(typeof b.access_token==='string'&&b.access_token.length>=20&&b.access_token.length<=3000&&!/\s/.test(b.access_token),'invalid_channel_token');
    need(typeof b.channel_secret==='string'&&/^[a-fA-F0-9]{32}$/.test(b.channel_secret),'invalid_channel_secret');
    const info=await line({accessToken:b.access_token},'info');need(/^U[a-f0-9]{32}$/.test(info.userId||''),'invalid_channel');
    const result=await mutate(owner,d=>{
     if(d.botUserId!==info.userId||d.channelSecret!==b.channel_secret)d.bindingRevision=(d.bindingRevision||0)+1;
     if(d.botUserId!==info.userId){delete d.ownerUserId;delete d.editFocus;delete d.pairHash;delete d.webhookVerified;}
     if(d.channelSecret!==b.channel_secret)delete d.webhookVerified;
     d.accessToken=b.access_token;d.channelSecret=b.channel_secret;d.botUserId=info.userId;d.name=info.displayName;d.basicId=info.basicId;
     return safe(d);
    });
    await redis(['SET',PREFIX+'route:'+channel(owner),owner]);return result;
   }
   if(operation==='pair-code'){
    const code=randomBytes(16).toString('hex');
    await mutate(owner,d=>{need(d.accessToken,'manager_not_configured',409);d.pairHash=hash(code);d.pairExpires=now()+600000;});
    // Route directory contains owner routing only, never tokens or guest content.
    await redis(['SET',PREFIX+'route:'+channel(owner),owner]);
    return {command:'綁定 '+code,expires_at:now()+600000};
   }
   if(operation==='unbind')return mutate(owner,d=>{d.bindingRevision=(d.bindingRevision||0)+1;delete d.ownerUserId;delete d.editFocus;delete d.pairHash;return safe(d);});
   need(false,'not_found',404);
  },
  async notify({owner,property,notice}){
   const d=await read(owner),p=d.properties.find(p=>p.id===property);
   if(!d.accessToken||!d.ownerUserId||!d.webhookVerified||!p)return false;
   if(notice.kind==='media'){
    const a=notice.attachment,m=notice.media;
    const time=new Date(m.occurred_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'});
    const header=`${p.name}｜${m.name}\n客人${m.kind==='image'?'圖片':'貼圖'} · ${time}`;
    let messages=[{type:'text',text:header}];
    if(a.kind==='image'){
     const valid=url=>{try{const u=new URL(url);return u.origin==='https://bnb-reply-copilot-2efedcw3vq-de.a.run.app'&&u.pathname.startsWith('/api/v1/customer-manager/image/');}catch{return false;}};
     need(valid(a.original_url)&&valid(a.preview_url),'invalid_media',502);
     if(a.native)messages.push({type:'image',originalContentUrl:a.original_url,previewImageUrl:a.preview_url});
     else messages.push({type:'text',text:'圖片超過 LINE 轉傳大小限制，點此查看完整原圖（連結有效 24 小時）：\n'+a.original_url});
    }else if(a.kind==='sticker_image'){
     need(/^https:\/\/stickershop\.line-scdn\.net\/stickershop\/v1\/sticker\/[0-9]{1,20}\/android\/sticker\.png$/.test(a.url),'invalid_sticker_media',502);
     messages[0].text+='\n'+a.note;
     messages.push({type:'image',originalContentUrl:a.url,previewImageUrl:a.url});
    }else if(a.kind==='sticker')messages.push(a.message);
    else messages.push({type:'text',text:clip(a.reason||'媒體暫時無法提供，請查看原對話。',1500)});
    try{await line(d,'message/push',{to:d.ownerUserId,messages},notice.id);}
    catch(e){
     // A definite validation rejection means none of the batch was accepted.
     // Never fall back after timeouts/5xx, which may already have delivered.
     if(e.providerStatus!==400)throw e;
     await line(d,'message/push',{to:d.ownerUserId,messages:[{type:'text',text:header+'\nLINE 不支援轉傳這份原始媒體，請查看原對話。'}]},notice.id);
    }
    return true;
   }
   const message=notice.kind==='draft'?card(p,notice.draft):{type:'text',text:`${p.name}｜${notice.draft.name}\n${notice.text}\n${notice.kind==='binding_status'||notice.draft.status==='dismissed'?'':notice.draft.reply||''}`};
   await line(d,'message/push',{to:d.ownerUserId,messages:[message]},notice.id);return true;
  },
  async digest(owner,readDrafts){
   const data=await inbox(owner,readDrafts),state=await read(owner);
   if(!state.ownerUserId||!state.accessToken||!state.webhookVerified)return;
   const active=data.rows.filter(({draft})=>bucket(draft,now())!=='snoozed');
   const fingerprint=hash(JSON.stringify(active.map(({property,draft})=>[property.id,draft.id,draft.version,draft.snoozed_until||0]).sort()));
   if(!active.length||state.digestSignature===fingerprint||state.digestSentAt>now()-600000)return;
   const lease=key(owner)+':digest-lease',claim=randomUUID();
   if(await redis(['SET',lease,claim,'NX','EX',30])!=='OK')return;
   try{
    const pending=await mutate(owner,d=>{if(!d.digestPending||d.digestPending.revision!==d.bindingRevision)d.digestPending={id:randomUUID(),signature:fingerprint,revision:d.bindingRevision,message:overview(data.rows,data)};return structuredClone(d.digestPending);});
    const current=await read(owner);need(current.bindingRevision===pending.revision&&current.ownerUserId,'binding_changed');
    await line(current,'message/push',{to:current.ownerUserId,messages:[pending.message]},pending.id);
    await mutate(owner,d=>{if(d.digestPending?.id===pending.id){d.digestSignature=pending.signature;d.digestSentAt=now();delete d.digestPending;}});
   }finally{await redis(['EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",1,lease,claim]);}
  },
  async webhook(channelId,raw,signature,decide,readDrafts,getContext,reviewCards){
   need(/^[a-f0-9]{32}$/.test(channelId),'not_found',404);
   const owner=await redis(['GET',PREFIX+'route:'+channelId]);need(owner,'not_found',404);
   const d=await read(owner);need(d.channelSecret,'manager_not_configured',409);
   const expected=createHmac('sha256',d.channelSecret).update(raw).digest('base64');
   need(typeof signature==='string'&&signature.length===expected.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(signature)),'invalid_signature',401);
   let body;try{body=JSON.parse(raw)}catch{need(false,'invalid_json');}
   need(body&&typeof body==='object'&&body.destination===d.botUserId&&Array.isArray(body.events)&&body.events.length<=20,'invalid_webhook');
   await mutate(owner,s=>{s.webhookVerified=now();});
   for(const event of body.events){
    if(event.source?.type!=='user'||!/^U[a-f0-9]{32}$/.test(event.source.userId||''))continue;
    const eventId=event.webhookEventId;need(typeof eventId==='string'&&eventId.length<100,'invalid_event');
    const eventKey=PREFIX+'event:'+hash(channelId+'|'+eventId);
    if(await redis(['GET',eventKey])==='done')continue;
    // Fence concurrent delivery; a failed request is retried after this short lease.
    if(await redis(['SET',eventKey,'working','NX','EX',60])!=='OK')need(false,'event_busy',503);
    try{
     let current=await read(owner),reply=null;
     const value=event.type==='message'&&event.message?.type==='text'?event.message.text.trim():'';
     const pairing=/^綁定 ([a-f0-9]{32})$/.exec(value);
     if(pairing){
      await mutate(owner,s=>{need(s.pairHash===hash(pairing[1])&&s.pairExpires>now(),'pairing_expired',409);s.bindingRevision=(s.bindingRevision||0)+1;s.ownerUserId=event.source.userId;delete s.pairHash;delete s.editFocus;});
      reply={type:'text',text:'已連接客服經理。按下「待辦總覽」查看分類，再用卡片按鈕處理；同一位客人的連續訊息會合併整理。'};
     }else if(current.ownerUserId===event.source.userId){
      if(event.type==='postback'){
       const q=new URLSearchParams(event.postback?.data||''),a=q.get('a'),p=q.get('p'),id=q.get('d'),version=Number(q.get('v'));
       if(a==='inbox')reply=await openInbox(owner,q.get('c')||'all',readDrafts,reviewCards);
       else if(a==='page')reply=await showPage(owner,q.get('t'),Number(q.get('n')),readDrafts,reviewCards);
       else if(a==='batch_preview')reply=await batchPreview(owner,q,readDrafts);
       else if(a==='batch_confirm')reply=await confirmBatch(owner,q.get('t'),eventId,decide);
       else if(a==='cancel_edit'){await mutate(owner,s=>{delete s.editFocus;});reply={type:'text',text:'已取消修改，原草稿保留。'};}
       else {
       need(current.properties.some(x=>x.id===p)&&typeof id==='string'&&/^[\w-]{32}$/.test(id)&&Number.isSafeInteger(version),'invalid_action');
       if(a==='context'){
        need(getContext,'context_unavailable');const result=await getContext(owner,p,id,q.get('before'));
        const full=result.messages.map(m=>`${m.role==='CUSTOMER'?'客人':m.role==='OWNER'?'民宿':'自動訊息'} · ${new Date(m.at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}\n${m.text}`).join('\n\n');
        const chars=[...full];reply=[];for(let pos=0;pos<chars.length;pos+=4000)reply.push({type:'text',text:chars.slice(pos,pos+4000).join('')});
        need(reply.length<=4,'context_page_too_large');
        if(result.before)reply.push({type:'flex',altText:'對話分頁',contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[text('已顯示本頁對話')]},footer:{type:'box',layout:'vertical',contents:[button('更早的對話',{a:'context',p,d:id,v:String(version),before:result.before})]}}});if(!reply.length)reply={type:'text',text:'目前沒有可顯示的對話。'};
       }else if(a==='edit'){
        const rows=await readDrafts(owner,p),draft=rows.drafts.find(x=>x.id===id);need(draft?.version===version&&draft.status==='awaiting_approval','draft_changed',409);
        await mutate(owner,s=>{s.editFocus={property:p,id,version,until:now()+600000};});
        reply={type:'text',text:`修改「${current.properties.find(x=>x.id===p).name}｜${draft.name}」的回覆。\n送出到這裡只會儲存草稿，還需要按「核准送出」才會傳給客人。`,quickReply:{items:[{type:'action',action:action('取消修改',{a:'cancel_edit'})}]}};
       }else{
        need(['approve','bind','takeover','no_reply','snooze','unsnooze'].includes(a),'invalid_action');
        const result=await decide(owner,p,{draft_id:id,version,action:a,request_id:eventId});
        reply={type:'text',text:a==='bind'?'已收到訂單確認，會核對後建立 Daili 關聯；不會傳訊息給客人。':a==='approve'?'已收到核准，重新核對最新訊息後送出；完成後向你回報。':a==='no_reply'?'已收到「這次不用回」，核對後結案；客人之後有新訊息仍會整理。':a==='snooze'?'已延後 1 小時，隨時可按「稍後處理」找回。':a==='unsnooze'?'已恢復到待辦。':'已交由你處理，這位客人的後續訊息暫停整理。'};
        if(a==='unsnooze')reply=[reply,card(current.properties.find(x=>x.id===p),result.draft)];
       }
       }
      }else if(value==='取消修改'){
       await mutate(owner,s=>{delete s.editFocus;});reply={type:'text',text:'已取消修改，原草稿保留。'};
      }else if(current.editFocus&&value&&!['待辦','待辦總覽'].includes(value)){
       const focus=current.editFocus;need(focus.until>now(),'edit_expired',409);
       const result=await decide(owner,focus.property,{draft_id:focus.id,version:focus.version,action:'edit',text:value,request_id:eventId});
       await mutate(owner,s=>{if(s.editFocus?.id===focus.id&&s.editFocus?.version===focus.version)delete s.editFocus;});
       reply=[{type:'text',text:'草稿已更新，請查看並按「核准送出」。'},card(current.properties.find(x=>x.id===focus.property),result.draft)];
      }else if(['待辦','待辦總覽'].includes(value))reply=await openInbox(owner,'all',readDrafts,reviewCards);
      else if(value)reply={type:'text',text:'按下方「待辦總覽」查看分類，再左右滑動卡片處理。需要修改草稿時才需輸入文字。'};
     }
     current=await read(owner);
     if(reply&&event.replyToken){const messages=Array.isArray(reply)?reply:[reply];messages.at(-1).quickReply||=quickNav();await line(current,'message/reply',{replyToken:event.replyToken,messages});}
     await redis(['SET',eventKey,'done','EX',DAY*7]);
    }catch(e){
     if(e.status&&e.status<500){
      if(event.replyToken)await line(await read(owner),'message/reply',{replyToken:event.replyToken,messages:[{type:'text',text:'這個操作已處理或內容有更新。請按「待辦總覽」取得最新內容；已受理的送出會另外回報結果。',quickReply:quickNav()}]}).catch(()=>{});
      await redis(['SET',eventKey,'done','EX',DAY*7]);
     }else{await redis(['DEL',eventKey]);throw e;}
    }
   }
   return {ok:true};
  }
 };
}
