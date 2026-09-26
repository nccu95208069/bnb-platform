import {createHash} from 'node:crypto';
import {roles,categories,metrics,products,toolHelp} from './catalog.mjs';
import {context,execute,saveBot,saveTemplate,fail} from './core.mjs';
import {runAgent,loadKey,model,authorizedHistory} from './agent.mjs';
import {uid} from './store.mjs';
import {setupState,saveSetup,importData,importedSnapshot} from './onboarding.mjs';
export async function dispatch(s,operation,method,a,id,readSource){
 if(method==='GET'){
  if(operation==='bootstrap')return {csrf:'same-origin',owner:'Sweetfun 業主',mode:'production'};
  if(operation==='state'){
   let history;try{const h=await readSource();history={available:true,asof:h.source.sync.last_checked_at,rows:h.bookings.length,version:h.source.snapshot_version,property:'sweetfun',mode:'live'}}catch{history={available:false,mode:'unavailable'}}
   return {setup:setupState(s),bots:s.all('bots'),roles,categories,metrics,templates:s.all('templates'),products,toolHelp,provider:{configured:!!loadKey(),model},history,sandboxMonth:s.get('meta','seed').month};
  }
  if(operation==='audit')return {rows:s.audits()};
  if(operation==='conversations')return {rows:s.all('conversations').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(({messages,...v})=>({...v,count:messages.length}))};
  if(operation==='conversation'){const v=s.get('conversations',id);if(!v)fail('not_found','對話不存在。',404);return v;}
 }else if(method==='POST'){
  if(operation==='onboarding')return saveSetup(s,a);
  if(operation==='import')return importData(s,a);
  if(operation==='bots')return saveBot(s,a);
  if(operation==='templates')return saveTemplate(s,a);
  if(!['tool','chat'].includes(operation))fail('not_found','找不到此操作。',404);
  const c=context(s,a.botId,a.property,a.dataset);
  if(c.dataset==='live')s.live=await readSource();
  if(c.dataset==='imported')s.live=importedSnapshot(s,a.property);
  if(operation==='tool'){
   if(typeof a.key!=='string'||!a.key||a.key.length>100)fail('invalid_input','缺少操作識別碼。');
   return execute(s,c,a.tool,a.args,a.key);
  }
  if(typeof a.message!=='string'||!a.message.trim()||a.message.length>5000)fail('invalid_input','請輸入 1–5000 字的訊息。');
  if(typeof a.requestId!=='string'||!a.requestId||a.requestId.length>100)fail('invalid_input','缺少請求識別碼。');
  let conv=a.conversationId?s.get('conversations',a.conversationId):null;
  if(a.conversationId&&!conv)fail('not_found','對話不存在。',404);
  if(conv&&(conv.botId!==a.botId||conv.property!==a.property||conv.dataset!==a.dataset))fail('scope_mismatch','對話範圍不同，請開新對話。',409);
  const requestKey='chat:'+a.requestId;
  const fingerprint=createHash('sha256').update(JSON.stringify([a.botId,a.property,a.dataset,a.message,a.conversationId])).digest('hex');
  const old=s.get('requests',requestKey);
  if(old){if(old.fingerprint!==fingerprint)fail('idempotency_conflict','請求識別碼已使用。',409);return old.result;}
  if(conv?.messages.length>=80)fail('conversation_full','此對話已達上限，請開啟新對話。',409);
  if(!conv)conv={id:uid('chat'),botId:a.botId,property:a.property,dataset:a.dataset,title:a.message.slice(0,32),messages:[],updatedAt:new Date().toISOString()};
  const prev=authorizedHistory(conv.messages,c.bot.version,c.dataset);
  conv.messages.push({id:uid('msg'),role:'user',policyVersion:c.bot.version,text:a.message,at:new Date().toISOString()});
  let result;try{result=await runAgent(s,c,a.message,prev)}catch(e){result={message:e.code?e.message:'處理暫時失敗，請稍後重試。',cards:[],trace:[],error:{code:e.code||'internal_error'}};}
  const reply={id:uid('msg'),role:'assistant',policyVersion:c.bot.version,text:result.message,cards:result.cards,trace:result.trace.map(({tool,status})=>({tool,status})),usage:result.usage,error:result.error,at:new Date().toISOString()};
  conv.messages.push(reply);conv.updatedAt=new Date().toISOString();s.put('conversations',conv);
  const response={conversation:conv};s.put('requests',{id:requestKey,fingerprint,result:response});return response;
 }
 fail('not_found','找不到此操作。',404);
}
