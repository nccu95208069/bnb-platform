// Native LINE chat presentation. No URI actions or webview navigation.
import {clearLabels,channelLabel} from './manager-channels.mjs';
export const PAGE_SIZE=5;
const CAROUSEL_BYTES=48000,BUBBLE_BYTES=30000;
const jsonBytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const fit=(ok)=>{if(!ok){const e=new Error('line_card_too_large');e.code='line_card_too_large';e.status=400;throw e;}};
export const categories={all:'待辦總覽',ready:'草稿已備妥',decision:'需要你決定',no_reply:'建議不用回',snoozed:'稍後處理'};
const clip=(value,n)=>String(value||'').slice(0,n);
export const action=(label,params,extra={})=>({type:'postback',label,data:new URLSearchParams(params).toString(),displayText:clip(label,300),...extra});
export const button=(label,params,primary=false,extra={})=>({type:'button',style:primary?'primary':'secondary',height:'sm',action:action(label,params,extra)});
export const text=(value,extra={})=>({type:'text',text:String(value||'—'),wrap:true,size:'sm',...extra});
export const clearButton=(channel='all')=>button(clearLabels[channel],{a:'clear_preview',ch:channel});
const clearButtons=()=>['line','instagram','all'].map(channel=>clearButton(channel));
export function clearStatusCard({token,total,channel='all',closed=0,changed=0,pending=0,unaccepted=0,excluded=0,property='',warning=''}){
 const remaining=pending+unaccepted,title=unaccepted?'待辦清理尚未完成':pending?'正在清空待辦':changed||excluded?'待辦清理完成，部分保留':'本次待辦已標為已處理';
 return {type:'flex',altText:`${property?property+'｜':''}${channelLabel(channel)}｜${title}`,contents:{type:'bubble',body:{type:'box',layout:'vertical',spacing:'md',contents:[text(`${property?property+'｜':''}${clearLabels[channel]}`,{weight:'bold'}),text(title,{size:'lg',weight:'bold',color:'#176B54'}),text(`本次共 ${total} 筆\n已處理 ${closed} 筆${pending?'\n核對中 '+pending+' 筆':''}${unaccepted?'\n待繼續確認 '+unaccepted+' 筆':''}${changed?'\n本次未結案，保留 '+changed+' 筆':''}${excluded?'\n另有 '+excluded+' 筆暫時無法結案，仍保留':''}`),...(warning?[text(warning,{size:'xs',color:'#AA5500'})]:[]),...(changed?[text('保留項目請更新待辦重新查看。',{size:'xs'})]:[]),text('這次操作不會傳送訊息給客人。之後的新訊息仍會列入待辦。',{size:'xs'})]},footer:{type:'box',layout:'vertical',spacing:'sm',contents:[...(unaccepted?[button('繼續清理',{a:'clear_confirm',t:token},true)]:[]),...(remaining?[button('查看清理進度',{a:'clear_status',t:token})]:[]),button('更新待辦總覽',{a:'inbox',c:'all'})]}},quickReply:quickNav()};
}
export function quickNav(){return {items:['all','ready','decision','no_reply','snoozed'].map(c=>({type:'action',action:action(categories[c],{a:'inbox',c})}))};}
export function sendBlocked(draft,now=Date.now()){return !!draft.send_blocked||(draft.channel_kind==='instagram'&&!(Date.parse(draft.reply_deadline)>now));}
export function bucket(draft,now){return draft.snoozed_until>now?'snoozed':sendBlocked(draft,now)?'decision':draft.category||(!draft.reply?'decision':'ready');}
export function visible(draft){return draft.status==='awaiting_approval';}
export function questionTopics(questions=[]){
 // Summaries can be route labels shared by several distinct obligations.
 // Group labels for presentation only; approval still binds every original ID.
 return [...new Set((Array.isArray(questions)?questions:[]).filter(q=>typeof q==='string').map(q=>q.normalize('NFKC').replace(/\s+/gu,' ').trim()).filter(Boolean))];
}
export function statusCard(property,draft,{duplicate=false,note='',binding=false}={}){
 const states={approved:['已受理，等待核對送出','完成後會再回報，無需重複核准。'],sending:['正在核對並送出','完成後會再回報，無需重複核准。'],sent:['LINE 已接受傳送','請到民宿原對話查看；此狀態不代表客人已讀。'],dismiss_requested:['已受理，正在核對結案','這次不用回覆的決定已記錄，完成後會再回報。'],dismissed:['這次已結案','沒有因這次結案傳送訊息。'],stale:['內容已更新','請更新待辦，重新查看最新內容。'],expired:['這張卡片已過期','請更新待辦，查看最新內容。'],uncertain:['傳送結果待確認','請到民宿原對話或 Daili 核對，勿重複送出。']};
 let [title,detail]=states[draft.status]||['仍待你處理','可查看最新卡片繼續處理。'];
 if(draft.channel_kind==='instagram'&&draft.status==='sent')title='Instagram 已接受傳送';
 if(draft.channel_kind==='instagram'&&draft.status==='awaiting_approval'&&sendBlocked(draft))[title,detail]=['IG 回覆期限已過','請至 Instagram 原對話處理；客人有新訊息後可重新整理回覆。'];
 if(draft.status==='awaiting_approval'&&draft.snoozed_until>Date.now())[title,detail]=['已移到稍後處理',`將於 ${new Date(draft.snoozed_until).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} 恢復待辦，也可隨時按「恢復處理」。`];
 if(['requested','binding','uncertain'].includes(draft.binding_state)||binding){
  [title,detail]=({requested:['已受理，等待確認訂單','本次操作只確認訂單，不會傳訊息給客人。'],binding:['正在確認訂單','本次操作只確認訂單，不會傳訊息給客人。'],bound:['訂單已確認','本次確認沒有傳訊息；回覆仍需另外核准。'],stale:['訂單內容已更新','請更新待辦，重新查看訂單資料。'],uncertain:['訂單確認結果待核對','請到 Daili 查看；本次確認沒有傳訊息。']})[draft.binding_state]||[title,detail];
 }
 const params={p:property.id,d:draft.id,v:String(draft.version)};
 return {type:'flex',altText:clip(`${property.name}｜${draft.name}：${title}`,400),contents:{type:'bubble',body:{type:'box',layout:'vertical',spacing:'md',contents:[text(`${property.name}｜${draft.name}`,{weight:'bold'}),text(title,{size:'lg',weight:'bold',color:'#176B54'}),...(duplicate?[text('已收到過這個操作，以下是目前狀態。',{size:'xs'})]:[]),text(detail),...(note?[text(clip(note,1200),{size:'xs'})]:[])]},footer:{type:'box',layout:'vertical',spacing:'sm',contents:[...(draft.status==='awaiting_approval'&&draft.snoozed_until>Date.now()?[button('恢復處理',{...params,a:'unsnooze'},true)]:[]),button(draft.status==='awaiting_approval'?'查看最新卡片':'查看進度',{...params,a:'status'}),button('更新待辦總覽',{a:'inbox',c:'all'})]}},quickReply:quickNav()};
}
export function overview(rows,{now=Date.now(),warning='',refreshedAt=null,clearing=null,clearings=clearing?[clearing]:[]}={}){
 const counts=Object.fromEntries(Object.keys(categories).map(k=>[k,0]));
 for(const {draft} of rows)if(visible(draft)){const c=bucket(draft,now);counts[c]++;if(c!=='snoozed')counts.all++;}
 const updated=refreshedAt?new Date(refreshedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}):'尚未同步';
 return {type:'flex',altText:`客服待辦：${counts.all} 位待處理，${counts.snoozed} 位稍後處理`,contents:{type:'bubble',body:{type:'box',layout:'vertical',spacing:'md',contents:[
  text('客服待辦',{size:'xl',weight:'bold'}),text(`${counts.all} 位客人待處理`,{size:'lg'}),
  ...clearings.map(b=>text(`${channelLabel(b.channel||'all')} 清理尚有 ${b.count} 筆待確認，可查看進度。`)),
  ...['ready','decision','no_reply','snoozed'].map(c=>text(`${categories[c]}　${counts[c]} 位`)),
  text(`依已同步資料整理 · ${updated}`,{size:'xs',color:'#777777'}),
  ...(warning?[text(warning,{size:'xs',color:'#AA5500'})]:[]),
 ]},footer:{type:'box',layout:'vertical',spacing:'sm',contents:[...['ready','decision','no_reply','snoozed'].map(c=>button(`${categories[c]}（${counts[c]}）`,{a:'inbox',c},c==='ready')),...clearings.map(b=>button(`${channelLabel(b.channel||'all')} 清理進度`,{a:'clear_status',t:b.token})),...clearButtons()]}},quickReply:quickNav()};
}
export function inboxCard(property,draft){
 const params={p:property.id,d:draft.id,v:String(draft.version)};
 const topics=questionTopics(draft.questions),summary=topics.map((q,i)=>`${i+1}. ${q}`).join('\n');
 const locked=['requested','binding','uncertain'].includes(draft.binding_state),pending=draft.status==='awaiting_approval';
 const status=locked?'訂單確認處理中，請等候結果':draft.status==='sent'?'訊息已送出':draft.snoozed_until>Date.now()?'稍後處理':categories[draft.category]||'待處理';
 const blocked=sendBlocked(draft);
 const body=[text(`${property.name}｜${draft.channel_kind==='instagram'?'IG · ':''}${draft.name}`,{weight:'bold',size:'md'}),text(status,{color:'#657080'}),
  ...(draft.channel_kind==='instagram'?[text(blocked?'IG 的 24 小時回覆期限已過，請至 Instagram 原對話處理。':`IG 可回覆至 ${new Date(draft.reply_deadline).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}`,{size:'xs',color:blocked?'#AA5500':'#777777'})]:[]),
  ...(draft.history_partial?[text('IG 歷史紀錄可能不完整；附件請至 Instagram 查看。',{size:'xs',color:'#777777'})]:[]),
  text(`客人訊息（合併 ${draft.message_count||1} 則）`,{weight:'bold'}),text(clip(draft.question,650)+(draft.question?.length>650?'\n…按「查看對話」閱讀全文':'')),
  ...(topics.length?[text('待確認主題',{weight:'bold'}),text(clip(summary,650)),...(topics.length<draft.questions.length?[text('相同主題已合併顯示。',{size:'xs',color:'#777777'})]:[])]:[]),
  ...(draft.prior_reply?[text('之前已送出',{weight:'bold'}),text(clip(draft.prior_reply,500))]:[]),
  ...(draft.edit_needs_review?[text('客人有補充；已保留你的修改，請重新核對。',{color:'#AA5500'})]:[]),
  ...(draft.identity?.summary?[text(clip(draft.identity.summary,700))]:[]),
  ...(draft.binding?[text('訂單已確認：'+draft.binding.labels.map(l=>l.label).join('、'))]:[]),
  ...(draft.manual_reason?[text(draft.manual_reason,{color:'#AA5500'})]:[]),
  ...(draft.reply?[text('建議回覆',{weight:'bold'}),text(draft.reply)]:[text('可修改草稿、選擇這次不用回，或稍後處理。')]),
 ];
 const actions=[];
 const tap=(label)=>({displayText:clip(`${draft.name}｜${label}`,300)});
 if(pending&&!locked&&!blocked&&draft.reply)actions.push(button('核准送出',{...params,a:'approve'},true,tap('核准送出')));
 const prefill=draft.reply&&[...draft.reply].length<=300?{inputOption:'openKeyboard',fillInText:draft.reply}:{inputOption:'openKeyboard'};
 if(pending&&!locked){
 actions.push(button('修改草稿',{...params,a:'edit'},false,{...tap('修改草稿'),...prefill}));
 if(draft.contract_version===3){actions.push(button('這次不用回',{...params,a:'no_reply'},false,tap('這次不用回')));
 actions.push(button(draft.snoozed_until>Date.now()?'恢復處理':'稍後處理（1 小時）',{...params,a:draft.snoozed_until>Date.now()?'unsnooze':'snooze'},false,tap(draft.snoozed_until>Date.now()?'恢復處理':'稍後處理（1 小時）')));}
 }
 actions.push(button('查看對話',{...params,a:'context'}));
 if(['awaiting_approval','sent'].includes(draft.status)&&!locked&&draft.identity?.selected&&!draft.binding)actions.push(button('確認訂單（不傳訊息）',{...params,a:'bind'},false,tap('確認訂單（不傳訊息）')));
 return {type:'bubble',size:'mega',body:{type:'box',layout:'vertical',spacing:'sm',contents:body},footer:{type:'box',layout:'vertical',spacing:'sm',contents:actions}};
}
export function pageMessages(rows,{token,page,total,category,pageSize=PAGE_SIZE,renderToken}){
 const result=[];
 // Keep five guests in the logical page, splitting only the LINE payload when
 // necessary. Never truncate the reply the owner is being asked to approve.
 fit(rows.length<=PAGE_SIZE);
 for(const {property,draft} of rows){
  const bubble=inboxCard(property,draft);fit(jsonBytes(bubble)<=BUBBLE_BYTES);
  const last=result.at(-1);
  if(last&&jsonBytes({type:'carousel',contents:[...last.contents.contents,bubble]})<=CAROUSEL_BYTES)last.contents.contents.push(bubble);
  else result.push({type:'flex',altText:`${categories[category]} · 第 ${page+1} 組`,contents:{type:'carousel',contents:[bubble]}});
 }
 const controls=[];
 if(page>0)controls.push(button('上一組',{a:'page',t:token,n:String(page-1)}));
 if((page+1)*pageSize<total)controls.push(button('下一組',{a:'page',t:token,n:String(page+1)},true));
 const available=renderToken&&rows.length&&rows.every(({draft})=>draft.contract_version===3&&draft.status==='awaiting_approval'&&!['requested','binding','uncertain'].includes(draft.binding_state));
 if(available&&category==='ready'&&rows.every(({draft})=>draft.reply&&draft.category==='ready'&&!sendBlocked(draft)))controls.push(button('本組全部核准',{a:'batch_preview',t:token,n:String(page),r:renderToken}));
 if(available&&category==='no_reply'&&rows.every(({draft})=>draft.category==='no_reply'))controls.push(button('本組都不用回',{a:'batch_preview',t:token,n:String(page),r:renderToken,mode:'no_reply'}));
 controls.push(button('更新待辦總覽',{a:'inbox',c:'all'}));
 controls.push(...clearButtons());
 const navigation={type:'flex',altText:'待辦分組操作',contents:{type:'bubble',size:'mega',body:{type:'box',layout:'vertical',contents:[text(rows.length?`左右滑動查看本組 ${rows.length} 位客人${result.length>1?'（分成 '+result.length+' 排卡片）':''}。`:'本組已處理，請查看下一組或更新總覽。'),text(`第 ${page+1} 組，共 ${Math.max(1,Math.ceil(total/pageSize))} 組`,{size:'xs'})]},footer:{type:'box',layout:'vertical',spacing:'sm',contents:controls}},quickReply:quickNav()};
 if(result.length<5)result.push(navigation);
 else{
  // Reply accepts at most five message objects. The last group has one guest
  // bubble in this case, leaving room for the separate navigation bubble.
  const last=result.at(-1);last.contents.contents.push(navigation.contents);last.quickReply=navigation.quickReply;
  fit(jsonBytes(last.contents)<=CAROUSEL_BYTES);
 }
 return result;
}
