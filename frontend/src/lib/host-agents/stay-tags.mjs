// Owner-approved native OA tags. Each side effect has a persisted stage/receipt.
// A verified read of the exact conversation precedes the single-use write.
export async function advanceStayTag({owner,property,draft,relay,save,validate}) {
 const t=draft.oa_tag;
 if(!t||['verified','needs_attention'].includes(t.status))return;
 const call=(op,b={})=>relay.owner(owner,op,{property_id:property,...b});
 const stop=async(code)=>save({status:'needs_attention',error:code});
 try{
  if(t.status!=='writing'&&!await validate())return stop('booking_changed');
  if(t.status==='pending'){
   const r=await call('customer-read',{action:'oa_read_conversation',payload:{display_name:t.prefixed_name?`${t.label} ${draft.name}`:draft.name},request_id:t.read_id});
   await save({status:'reading',read_job_id:r.job_id});return;
  }
  if(t.status==='reading'){
   const r=await call('customer-result',{job_id:t.read_job_id});
   if(['queued','leased'].includes(r.status))return;
   if(r.status!=='succeeded'||!r.output){
    if(r.error_code==='recipient_not_visible'&&!t.prefixed_name){await save({status:'pending',prefixed_name:true,read_id:t.read_id+'-prefixed'});return;}
    return stop(r.error_code||'conversation_read_unavailable');
   }
   const c=r.output;
   const normalize=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'').trim();
   // OA does not expose a Messaging API user ID. Never rely on name alone.
   if(![draft.name,`${t.label} ${draft.name}`].includes(c.display_name)||!c.messages.some(m=>m.direction==='outgoing'&&normalize(m.text)===normalize(draft.reply)))return stop('recipient_evidence_not_visible');
   const prepared=await call('customer-prepare',{action:'oa_set_tag',read_job_id:t.read_job_id,payload:{tag:t.label}});
   await save({status:'prepared',draft_id:prepared.draft_id});return;
  }
  if(t.status==='prepared'){
   const r=await call('customer-confirm',{draft_id:t.draft_id,confirmed:true});
   await save({status:'writing',write_job_id:r.job_id});return;
  }
  if(t.status==='writing'){
   const r=await call('customer-result',{job_id:t.write_job_id});
   if(['queued','leased'].includes(r.status))return;
   if(r.status==='succeeded'&&r.output?.verified===true)await save({status:'verified',error:null});
   else await stop(r.error_code||'tag_write_unverified');
  }
 }catch(e){
  if(['host_offline','not_paired','line_login_required','job_in_progress','busy','automation_pause_required'].includes(e.code)){
   await save({error:e.code});return;
  }
  // Unknown write outcomes must not cause a second unreviewed operation.
  if(['prepared','writing'].includes(t.status))await stop(e.code||'tag_write_uncertain');
  else await stop(e.code||'tag_read_unavailable');
 }
}
export function tagStatusText(tag){
 if(tag.status==='verified')return `LINE 原生標籤已確認：「${tag.label}」。`;
 if(tag.status==='needs_attention'){
  const detail={booking_changed:'訂單或綁定已更新，原標記停止套用',tag_not_available:'LINE 尚未建立這個標籤',recipient_evidence_not_visible:'尚未在主機畫面核對到該次確認訊息',tag_write_unverified:'畫面未能確認儲存結果',customer_expired:'主機操作逾時'}[tag.error]||'主機未能確認標記結果';
  return `Daili 已綁定；LINE 標籤「${tag.label}」尚未確認：${detail}。請在 LINE 後台核對，不會重送客人訊息。`;
 }
 return `Daili 已綁定；LINE 標籤「${tag.label}」等待主機處理。`;
}
