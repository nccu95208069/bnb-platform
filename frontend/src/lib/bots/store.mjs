import {randomUUID} from 'node:crypto';
import {roles,defaultTemplates} from './catalog.mjs';
// Request-local working copy. Only the fenced Redis commit makes changes durable.
export function openStore(snapshot=null){
 let data=snapshot?structuredClone(snapshot):{schema:1,objects:{},audit:[],effects:{}};
 if(data.schema!==1||!data.objects||!Array.isArray(data.audit)||!data.effects)throw Error('STORE_INVALID');
 const copy=v=>v==null?null:structuredClone(v);
 const s={all(kind){return Object.values(data.objects[kind]||{}).map(copy)},get(kind,id){return copy(Object.hasOwn(data.objects[kind]||{},id)?data.objects[kind][id]:null)},put(kind,v){data.objects[kind]??={};data.objects[kind][v.id]=copy(v);return v},audit(v){data.audit.push({seq:(data.audit.at(-1)?.seq||0)+1,at:new Date().toISOString(),...copy(v)});data.audit=data.audit.slice(-500)},audits(){return copy(data.audit.slice(-150).reverse())},tx(fn){const before=copy(data);try{return fn()}catch(e){data=before;throw e}},close(){},snapshot(){return copy(data)},db:{prepare(sql){if(sql==='SELECT * FROM effects WHERE key=?')return {get(key){return copy(Object.hasOwn(data.effects,key)?data.effects[key]:null)}};if(sql==='INSERT INTO effects VALUES(?,?,?)')return {run(key,fingerprint,result){if(data.effects[key])throw Error('DUPLICATE_EFFECT');data.effects[key]={key,fingerprint,result}}};throw Error('UNSUPPORTED_QUERY')}}};
 if(!s.get('meta','seed'))seed(s);return s;
}
export const uid=(prefix)=>prefix+'-'+randomUUID().slice(0,8);
export const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Taipei'});
export function seed(s){s.tx(()=>{
 for(const [id,r] of Object.entries(roles))s.put('bots',{id,role:id,name:r.name,mission:r.mission,read:r.read,write:r.write,tools:r.tools,active:true,version:1});
 for(const t of defaultTemplates)s.put('templates',t);
 const month=today().slice(0,7);s.put('meta',{id:'seed',month});
 const orders=[['S-1001','101','03','06','示範旅客 A',9600,'direct'],['S-1002','102','05','07','示範旅客 B',5400,'booking'],['S-1003','201','12','15','示範旅客 C',12600,'agoda'],['S-1004','202','18','20','示範旅客 D',7600,'direct'],['S-1005','101','26','28','示範旅客 E',8200,'booking'],['S-1006','301','27','29','示範旅客 F',null,'direct'],['O-1001','villa','18','20','包棟示範旅客',24000,'direct']];
 for(const [id,room,a,b,guest,total,channel] of orders)s.put('orders',{id,property:room==='villa'?'offland':'sweetfun',room,start:month+'-'+a,end:month+'-'+b,guest,total,channel,status:'active',version:1});
 s.put('payments',{id:'P-1001',property:'sweetfun',orderId:'S-1001',amount:3000,method:'transfer',receivedAt:month+'-01',type:'receipt',version:1});
 for(const p of ['sweetfun','offland'])for(const [category,title,content] of [['sop','共同作業規範','先確認來源、期間與據點。未知金額不可視為零。訂單取消保留紀錄，收款更正採沖銷。正式資料只讀。'],['operations','每日營運檢查','確認今日到退房、備品與待辦。異常交給對應負責人。'],['finance','收款核對說明','表載房費、客人付款與平台入帳是不同口徑。先確認款項對應訂單。'],['reservations','訂房作業手冊','新增或改期先檢查可用房間。入住日包含，退房日不包含。'],['analysis','分析架構說明','依核准模板呈現房晚、房費、房間與通路，不推論未被資料證實的原因。'],['market','競品可比條件','保留來源、擷取時間、入住日、人數、晚數、稅費與取消條件。']])s.put('documents',{id:uid('D'),property:p,dataset:'sandbox',category,title,content,version:1,archived:false,updatedAt:new Date().toISOString()});
 s.put('tasks',{id:'T-1001',property:'sweetfun',title:'確認週末備品與房間準備',assignee:'concierge',due:today(),status:'todo',version:1});
 });}
