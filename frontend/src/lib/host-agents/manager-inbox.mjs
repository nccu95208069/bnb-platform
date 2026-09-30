// Native LINE chat presentation. No URI actions or webview navigation.
export const PAGE_SIZE=3;
export const categories={all:'待辦總覽',ready:'草稿已備妥',decision:'需要你決定',no_reply:'建議不用回',snoozed:'稍後處理'};
const clip=(value,n)=>String(value||'').slice(0,n);
export const action=(label,params,extra={})=>({type:'postback',label,data:new URLSearchParams(params).toString(),...extra});
export const button=(label,params,primary=false,extra={})=>({type:'button',style:primary?'primary':'secondary',height:'sm',action:action(label,params,extra)});
export const text=(value,extra={})=>({type:'text',text:String(value||'—'),wrap:true,size:'sm',...extra});
export function quickNav(){return {items:['all','ready','decision','no_reply','snoozed'].map(c=>({type:'action',action:action(categories[c],{a:'inbox',c})}))};}
export function bucket(draft,now){return draft.snoozed_until>now?'snoozed':draft.category||(!draft.reply?'decision':'ready');}
export function visible(draft){return draft.status==='awaiting_approval';}
export function overview(rows,{now=Date.now(),warning='',refreshedAt=null}={}){
 const counts=Object.fromEntries(Object.keys(categories).map(k=>[k,0]));
 for(const {draft} of rows)if(visible(draft)){const c=bucket(draft,now);counts[c]++;if(c!=='snoozed')counts.all++;}
 const updated=refreshedAt?new Date(refreshedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}):'尚未同步';
 return {type:'flex',altText:`客服待辦：${counts.all} 位待處理，${counts.snoozed} 位稍後處理`,contents:{type:'bubble',body:{type:'box',layout:'vertical',spacing:'md',contents:[
  text('客服待辦',{size:'xl',weight:'bold'}),text(`${counts.all} 位客人待處理`,{size:'lg'}),
  ...['ready','decision','no_reply','snoozed'].map(c=>text(`${categories[c]}　${counts[c]} 位`)),
  text(`依已同步資料整理 · ${updated}`,{size:'xs',color:'#777777'}),
  ...(warning?[text(warning,{size:'xs',color:'#AA5500'})]:[]),
 ]},footer:{type:'box',layout:'vertical',spacing:'sm',contents:['ready','decision','no_reply','snoozed'].map(c=>button(`${categories[c]}（${counts[c]}）`,{a:'inbox',c},c==='ready'))}},quickReply:quickNav()};
}
export function inboxCard(property,draft){
 const params={p:property.id,d:draft.id,v:String(draft.version)};
 const summary=draft.questions?.length?draft.questions.map((q,i)=>`${i+1}. ${q}`).join('\n'):draft.question;
 const locked=['requested','binding','uncertain'].includes(draft.binding_state),pending=draft.status==='awaiting_approval';
 const status=locked?'訂單確認處理中，請等候結果':draft.status==='sent'?'訊息已送出':draft.snoozed_until>Date.now()?'稍後處理':categories[draft.category]||'待處理';
 const body=[text(`${property.name}｜${draft.name}`,{weight:'bold',size:'md'}),text(status,{color:'#657080'}),
  text(`客人訊息（合併 ${draft.message_count||1} 則）`,{weight:'bold'}),text(clip(draft.question,650)+(draft.question?.length>650?'\n…按「查看對話」閱讀全文':'')),
  ...(draft.questions?.length?[text('待處理問題',{weight:'bold'}),text(clip(summary,650))]:[]),
  ...(draft.prior_reply?[text('之前已送出',{weight:'bold'}),text(clip(draft.prior_reply,500))]:[]),
  ...(draft.edit_needs_review?[text('客人有補充；已保留你的修改，請重新核對。',{color:'#AA5500'})]:[]),
  ...(draft.identity?.summary?[text(clip(draft.identity.summary,700))]:[]),
  ...(draft.binding?[text('訂單已確認：'+draft.binding.labels.map(l=>l.label).join('、'))]:[]),
  ...(draft.manual_reason?[text(draft.manual_reason,{color:'#AA5500'})]:[]),
  ...(draft.reply?[text('建議回覆',{weight:'bold'}),text(draft.reply)]:[text('可修改草稿、選擇這次不用回，或稍後處理。')]),
 ];
 const actions=[];
 if(pending&&!locked&&draft.reply)actions.push(button('核准送出',{...params,a:'approve'},true));
 const prefill=draft.reply&&[...draft.reply].length<=300?{inputOption:'openKeyboard',fillInText:draft.reply}:{inputOption:'openKeyboard'};
 if(pending&&!locked){
 actions.push(button('修改草稿',{...params,a:'edit'},false,prefill));
 if(draft.contract_version===3){actions.push(button('這次不用回',{...params,a:'no_reply'}));
 actions.push(button(draft.snoozed_until>Date.now()?'恢復處理':'稍後 1 小時',{...params,a:draft.snoozed_until>Date.now()?'unsnooze':'snooze'}));}
 }
 actions.push(button('查看對話',{...params,a:'context'}));
 if(['awaiting_approval','sent'].includes(draft.status)&&!locked&&draft.identity?.selected&&!draft.binding)actions.push(button('確認訂單（不傳訊息）',{...params,a:'bind'}));
 return {type:'bubble',size:'mega',body:{type:'box',layout:'vertical',spacing:'sm',contents:body},footer:{type:'box',layout:'vertical',spacing:'sm',contents:actions}};
}
export function pageMessages(rows,{token,page,total,category}){
 const result=[];
 if(rows.length)result.push({type:'flex',altText:`${categories[category]} · 第 ${page+1} 組`,contents:{type:'carousel',contents:rows.map(({property,draft})=>inboxCard(property,draft))}});
 const controls=[];
 if(page>0)controls.push(button('上一組',{a:'page',t:token,n:String(page-1)}));
 if((page+1)*PAGE_SIZE<total)controls.push(button('下一組',{a:'page',t:token,n:String(page+1)},true));
 const available=rows.length&&rows.every(({draft})=>draft.contract_version===3&&!['requested','binding','uncertain'].includes(draft.binding_state));
 if(available&&rows.every(({draft})=>draft.reply&&draft.category==='ready'))controls.push(button('本組全部核准',{a:'batch_preview',t:token,n:String(page)}));
 if(available&&rows.every(({draft})=>draft.category==='no_reply'))controls.push(button('本組都不用回',{a:'batch_preview',t:token,n:String(page),mode:'no_reply'}));
 controls.push(button('更新待辦總覽',{a:'inbox',c:'all'}));
 result.push({type:'flex',altText:'待辦分組操作',contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[text(rows.length?`左右滑動查看本組 ${rows.length} 位客人。`:'本組已處理，請查看下一組或更新總覽。'),text(`第 ${page+1} 組，共 ${Math.max(1,Math.ceil(total/PAGE_SIZE))} 組`,{size:'xs'})]},footer:{type:'box',layout:'vertical',spacing:'sm',contents:controls}},quickReply:quickNav()});
 return result;
}
