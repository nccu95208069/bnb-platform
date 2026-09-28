import {createHash,createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {customerCrypto} from './customer.mjs';
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
 const safe=d=>({channel_id:channel(d.owner),configured:!!d.accessToken,name:d.name||'客服經理',basic_id:d.basicId||'',bound:!!d.ownerUserId,binding_revision:d.bindingRevision||0,webhook_verified:!!d.webhookVerified,properties:d.properties});
 async function line(d,path,body,retryKey){
  const res=await fetcher('https://api.line.me/v2/bot/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+d.accessToken,'Content-Type':'application/json',...(retryKey?{'X-Line-Retry-Key':retryKey}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
  if(res.status===409&&retryKey&&res.headers.get('x-line-accepted-request-id'))return {};
  if(!res.ok){const e=new Error('line_api_unavailable');e.code='line_api_unavailable';e.status=502;e.providerStatus=res.status;throw e;}return res.status===204?{}:res.json();
 }
 function card(property,draft){
  const labels={awaiting_approval:'等待核准',approved:'已核准，等待重新核對',checking:'正在重新核對',sending:'正在送出',sent:'已送出',stale:'已失效',uncertain:'結果待確認',expired:'已過期',dismissed:'已交由你處理'};
  const message=`${property.name}｜${draft.name}\n${labels[draft.status]||draft.status}\n客人訊息${draft.question.length>700?'（節錄）':''}：\n${clip(draft.question,700)}\n\n${draft.binding?'訂單已確認：'+draft.binding.labels.map(l=>l.label).join('、')+'（Daili）\n\n':draft.identity?.summary?clip(draft.identity.summary,900)+'\n\n':''}${draft.reply?'建議回覆：\n'+draft.reply:'這個問題需要你判斷，請修改回覆或自行接手。'}`;
  const actions=['awaiting_approval','sent'].includes(draft.status)&&!['requested','binding','uncertain'].includes(draft.binding_state)?[
   ...(draft.identity?.selected&&!draft.binding?[{label:'確認訂單（不傳訊息）',a:'bind'}]:[]),
   ...(draft.status==='awaiting_approval'?[...(draft.reply?[{label:'核准送出訊息',a:'approve'}]:[]),{label:'修改回覆',a:'edit'},{label:'自行接手',a:'takeover'}]:[])
  ].map(x=>({type:'button',style:x.a==='approve'?'primary':'secondary',action:{type:'postback',label:x.label,data:new URLSearchParams({a:x.a,p:property.id,d:draft.id,v:String(draft.version)}).toString()}})):[];
  return {type:'flex',altText:clip(`${property.name}｜${draft.name}：${labels[draft.status]||draft.status}`,400),contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[{type:'text',text:message,wrap:true,size:'sm'}]},...(actions.length?{footer:{type:'box',layout:'vertical',spacing:'sm',contents:actions}}:{})}};
 }
 return {
  properties:async owner=>(await read(owner)).properties,
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
   const message=notice.kind==='draft'?card(p,notice.draft):{type:'text',text:`${p.name}｜${notice.draft.name}\n${notice.text}\n${notice.kind==='binding_status'?'':notice.draft.reply||''}`};
   await line(d,'message/push',{to:d.ownerUserId,messages:[message]},notice.id);return true;
  },
  async webhook(channelId,raw,signature,decide,readDrafts){
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
      reply={type:'text',text:'已連接客服經理。新訊息會整理成草稿交給你核准；你也可以傳「待辦」查看目前待處理項目。'};
     }else if(current.ownerUserId===event.source.userId){
      if(event.type==='postback'){
       const q=new URLSearchParams(event.postback?.data||''),a=q.get('a'),p=q.get('p'),id=q.get('d'),version=Number(q.get('v'));
       need(current.properties.some(x=>x.id===p)&&typeof id==='string'&&/^[\w-]{32}$/.test(id)&&Number.isSafeInteger(version),'invalid_action');
       if(a==='edit'){
        const rows=await readDrafts(owner,p),draft=rows.drafts.find(x=>x.id===id);need(draft?.version===version&&draft.status==='awaiting_approval','draft_changed',409);
        await mutate(owner,s=>{s.editFocus={property:p,id,version,until:now()+600000};});
        reply={type:'text',text:`請輸入「${current.properties.find(x=>x.id===p).name}｜${draft.name}」的新回覆。\n只會更新草稿，仍需再次按「核准送出」。輸入「取消修改」可退出。`};
       }else{
        need(['approve','bind','takeover'].includes(a),'invalid_action');
        await decide(owner,p,{draft_id:id,version,action:a,request_id:eventId});
        reply={type:'text',text:a==='bind'?'已收到訂單確認，會核對後建立 Daili 關聯與住宿標記；這個操作不會傳訊息給客人。':a==='approve'?'已收到核准，會重新核對客人的最新訊息再送出；完成後向你回報。':'已交由你處理，這位客人的後續訊息暫停整理。可在工作台恢復。'};
       }
      }else if(value==='取消修改'){
       await mutate(owner,s=>{delete s.editFocus;});reply={type:'text',text:'已取消修改，原草稿保留。'};
      }else if(current.editFocus&&value&&value!=='待辦'){
       const focus=current.editFocus;need(focus.until>now(),'edit_expired',409);
       const result=await decide(owner,focus.property,{draft_id:focus.id,version:focus.version,action:'edit',text:value,request_id:eventId});
       await mutate(owner,s=>{if(s.editFocus?.id===focus.id&&s.editFocus?.version===focus.version)delete s.editFocus;});
       reply={type:'text',text:`已儲存第 ${result.draft.version} 版草稿，稍後會收到新的核准卡片，尚未送出。`};
      }else if(value==='待辦'){
       const rows=[];for(const p of current.properties){try{const result=await readDrafts(owner,p.id);for(const draft of result.drafts.filter(x=>x.status==='awaiting_approval'))rows.push(card(p,draft));}catch(e){if(e.code!=='not_paired')throw e;}}
       reply=rows.length?rows.slice(0,5):{type:'text',text:'目前沒有待核准的草稿。'};
      }else if(value)reply={type:'text',text:'傳「待辦」查看待核准草稿，或直接使用卡片上的核准、修改、接手按鈕。'};
     }
     current=await read(owner);
     if(reply&&event.replyToken)await line(current,'message/reply',{replyToken:event.replyToken,messages:Array.isArray(reply)?reply:[reply]});
     await redis(['SET',eventKey,'done','EX',DAY*7]);
    }catch(e){
     if(e.status&&e.status<500){
      if(event.replyToken)await line(await read(owner),'message/reply',{replyToken:event.replyToken,messages:[{type:'text',text:'這份草稿、修改或綁定已失效，沒有送出新訊息。請傳「待辦」取得最新草稿，或回工作台重新綁定。'}]}).catch(()=>{});
      await redis(['SET',eventKey,'done','EX',DAY*7]);
     }else{await redis(['DEL',eventKey]);throw e;}
    }
   }
   return {ok:true};
  }
 };
}
