import {liveQuery,liveProjection} from './live.mjs';
import {createHash} from 'node:crypto';
import {roles,metrics} from './catalog.mjs';
import {uid,today} from './store.mjs';
export class Fault extends Error{constructor(code,message,status=400){super(message);this.code=code;this.status=status;}}
export const fail=(c,m,s)=>{throw new Fault(c,m,s)};
const need=(yes,message)=>{if(!yes)fail('invalid_input',message)};
const text=(v,n=5000)=>typeof v==='string'&&v.trim()&&v.length<=n;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const days=(a,b)=>(Date.parse(b)-Date.parse(a))/86400000;
const round=v=>v==null?null:Math.round(v*100)/100;
const month=()=>{const m=today().slice(0,7);const d=new Date(m+'-01');d.setUTCMonth(d.getUTCMonth()+1);return {start:m+'-01',end:d.toISOString().slice(0,10)}};
export const rooms={sweetfun:['101','102','201','202','301','302'],offland:['villa']};
export function range(a={}){const r={...month(),...a};need(date(r.start)&&date(r.end)&&days(r.start,r.end)>0&&days(r.start,r.end)<=730,'請提供有效日期區間（最多 730 天，結束日不包含）。');return r;}
export function context(s,botId,property,dataset='sandbox'){
 const bot=s.get('bots',botId);need(bot&&bot.active,'Bot 不存在或已停用。');need(rooms[property],'據點不存在。');need(['sandbox','live','imported'].includes(dataset),'資料來源不存在。');
 if(dataset==='live'&&property!=='sweetfun')fail('not_configured','正式來源目前只開放水芳訂單。',409);
 return {bot,property,dataset,preferences:s.get('onboarding',property+':'+bot.role)};
}
export function authorize(c,tool){if(!roles[c.bot.role].tools.includes(tool)||!c.bot.tools.includes(tool))fail('forbidden','這個 Bot 沒有使用此工具的權限。',403);if(c.dataset!=='sandbox'&&!['overview','orders.list','availability','finance.summary','reports.booking','calculate','organize','delegate'].includes(tool))fail('readonly_source','正式資料唯讀；請切換隔離測試資料進行新增、修改、取消、收款及文件操作。',403);}
function scoped(s,kind,id,c){const v=s.get(kind,id);if(!v||v.property!==c.property)fail('not_found','找不到這個據點的紀錄。',404);return v;}
function docPermit(c,d,mode){const list=mode==='read'?c.bot.read:c.bot.write;if(!list.includes(d.category)||!(mode==='read'?roles[c.bot.role].read:roles[c.bot.role].write).includes(d.category))fail('forbidden','此文件不在 Bot 的授權範圍。',403);if(d.dataset!==c.dataset)fail('readonly_source','此資料來源不允許這項操作。',403);}
function version(v,a){if(a.version!==v.version)fail('version_conflict','資料已更新，請重新讀取後再操作。',409);}
function all(s,kind,c){return s.all(kind).filter(v=>v.property===c.property);}
function receipts(s,id){return s.all('payments').filter(v=>v.orderId===id).reduce((n,v)=>n+Math.round(v.amount*100),0)/100;}
function orderCheck(s,c,v,ignore){need(rooms[c.property].includes(v.room),'房間不屬於目前據點。');range(v);need(text(v.guest,100),'請提供旅客顯示名稱。');need(v.total===null||Number.isFinite(v.total)&&v.total>=0&&v.total<=10000000&&Math.abs(v.total*100-Math.round(v.total*100))<1e-6,'金額必須是 0 至 10,000,000、最多小數兩位，未知使用 null。');need(['direct','booking','agoda','airbnb','other'].includes(v.channel),'請選有效訂房通路。');const conflict=all(s,'orders',c).find(o=>o.id!==ignore&&o.status==='active'&&o.room===v.room&&o.start<v.end&&o.end>v.start);if(conflict)fail('overlap','這個房間在該期間已有有效訂單。',409);if(ignore&&v.total!==null&&receipts(s,ignore)>v.total)fail('payment_conflict','新總額低於已收款，請先由財務處理。',409);}
export function calculate(expression){
 need(text(expression,200),'請提供最多 200 字的算式。');need(/^[\d.\s()+\-*/%]+$/.test(expression),'只允許數字、括號與 + - * / %。');
 const tokens=expression.match(/\d+(?:\.\d+)?|\.\d+|[()+\-*/%]/g)||[];let i=0,depth=0;
 function primary(){need(++depth<40,'括號太多。');let v;if(tokens[i]==='-'){i++;v=-primary();}else if(tokens[i]==='+'){i++;v=primary();}else if(tokens[i]==='('){i++;v=sum();need(tokens[i++ ]===')','括號不完整。');}else{v=Number(tokens[i++]);need(Number.isFinite(v),'算式格式不正確。');}if(tokens[i]==='%'){i++;v/=100;}depth--;return v;}
 function product(){let v=primary();while(['*','/'].includes(tokens[i])){const op=tokens[i++],b=primary();need(op!=='/'||b!==0,'不能除以零。');v=op==='*'?v*b:v/b;}return v;}
 function sum(){let v=product();while(['+','-'].includes(tokens[i])){const op=tokens[i++],b=product();v=op==='+'?v+b:v-b;}return v;}
 const result=sum();need(i===tokens.length&&Number.isFinite(result)&&Math.abs(result)<1e15,'算式無效或結果過大。');return {kind:'calculation',title:'計算結果',expression,result:Math.round(result*1e10)/1e10};
}
export function historySource(s){if(!s.live)fail('source_unavailable','正式訂單來源暫時無法讀取，請稍後重試。',503);return liveProjection(s.live);}
function reportBooking(s,c,a){
 const r=range(a),template=s.get('templates','booking');let rs,roomList,source;
 if(c.dataset!=='sandbox'){const h=historySource(s);rs=h.rows;roomList=h.rooms;source={mode:c.dataset,title:s.live.source.title||'水芳目前訂單・唯讀',asof:h.asof,version:h.hash,warning:'管理系統同步資料；表載房晚占用率未扣停賣，不能推定 OTA 可售庫存。'};}
 else{roomList=rooms[c.property];rs=all(s,'orders',c).filter(o=>o.status==='active').flatMap(o=>{const n=days(o.start,o.end);return Array.from({length:n},(_,i)=>({room:o.room,day:new Date(Date.parse(o.start)+i*86400000).toISOString().slice(0,10),channel:o.channel,fee:o.total===null?null:o.total/n,ambiguous:false}));});source={mode:'sandbox',title:'隔離測試訂單',asof:new Date().toISOString(),warning:'示範資料，僅供操作驗收；非真實營運績效。'};}
 const filtered=rs.filter(x=>x.day>=r.start&&x.day<r.end);
 const outside=c.dataset==='imported'&&(r.start<s.live.period.start||r.end>s.live.period.end); // Current snapshot covers the selected calendar; no bookings means no recorded occupancy.
 const grouped=new Map();for(const x of filtered){const k=x.room+'|'+x.day;if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(x);}
 const normalized=[...grouped.values()].map(xs=>xs.length>1||xs[0].ambiguous?{...xs[0],fee:null,channel:'待確認',ambiguous:true}:xs[0]);
 function values(rows,cap){const occ=rows.length,good=rows.filter(x=>x.fee!==null&&!x.ambiguous),paid=good.filter(x=>x.fee>0);return {occupied:outside?null:occ,capacity:outside?null:cap,occupancy:outside||cap===null?null:round(occ/cap*100),revenue:outside||(!good.length&&occ)?null:round(good.reduce((n,x)=>n+x.fee,0)),adr:outside||!paid.length?null:round(paid.reduce((n,x)=>n+x.fee,0)/paid.length),unknown:outside?null:rows.filter(x=>x.fee===null||x.ambiguous).length,directShare:outside||!occ?null:round(rows.filter(x=>['direct','直客','直訂'].includes(x.channel)).length/occ*100)};}
 const sections=template.sections.map(section=>{const keys=section.group==='all'?['全館']:section.group==='room'?roomList:[...new Set(normalized.map(x=>x.channel))].sort();return {title:section.title,columns:section.metrics.map(m=>({id:m,...metrics[m]})),rows:keys.map(key=>{const subset=section.group==='all'?normalized:normalized.filter(x=>x[section.group]===key);const v=values(subset,section.group==='channel'?null:days(r.start,r.end)*(section.group==='room'?1:roomList.length));return {label:key,values:Object.fromEntries(section.metrics.map(m=>[m,v[m]]))};})};});
 return {kind:'report',title:template.title,templateId:template.id,templateVersion:template.version,range:r,source,sections,note:template.note,warnings:[...(outside?['所選期間超出快照涵蓋範圍，數值保留未知。']:[]),...(normalized.some(x=>x.ambiguous)?['同房同晚衝突已去重占用，衝突金額與通路未納入。']:[]),'退房日不計房晚；表載房費不等於實收／淨利。']};
}
export function execute(s,c,tool,a={},key=uid('op')){
 authorize(c,tool);need(a&&typeof a==='object'&&!Array.isArray(a),'工具參數格式錯誤。');
 if(c.dataset!=='sandbox'&&['overview','orders.list','availability','finance.summary'].includes(tool))return {...liveQuery(s.live,c,tool,range(a),a),tool,property:c.property,dataset:c.dataset};
 const mutate=/\.(create|update|archive|record|reverse|cancel|add)$/.test(tool);
 const fingerprint=createHash('sha256').update(JSON.stringify({bot:c.bot.id,property:c.property,dataset:c.dataset,tool,a})).digest('hex');
 const run=()=>{
 if(mutate){const old=s.db.prepare('SELECT * FROM effects WHERE key=?').get(key);if(old){if(old.fingerprint!==fingerprint)fail('idempotency_conflict','同一操作識別碼不可用於不同內容。',409);return JSON.parse(old.result);}}
 let out,mutationBefore=null;const changed=(kind,v)=>{mutationBefore=s.get(kind,v.id);return s.put(kind,{...v,version:(v.version||0)+1,updatedAt:new Date().toISOString()});};
 if(tool==='calculate')out=calculate(a.expression);
 else if(tool==='organize'){need(Array.isArray(a.rows)&&a.rows.length<=200&&a.rows.every(x=>x&&typeof x==='object'&&!Array.isArray(x)),'提供最多 200 列物件。');need(JSON.stringify(a.rows).length<=25000,'資料過長。');let rows=structuredClone(a.rows);if(a.sortBy)rows.sort((x,y)=>typeof x[a.sortBy]==='number'&&typeof y[a.sortBy]==='number'?x[a.sortBy]-y[a.sortBy]:String(x[a.sortBy]??'').localeCompare(String(y[a.sortBy]??''),'zh-TW'));out={kind:'table',title:'資料整理',rows,groups:a.groupBy?Object.fromEntries([...new Set(rows.map(x=>String(x[a.groupBy]??'未分類')))].map(k=>[k,rows.filter(x=>String(x[a.groupBy]??'未分類')===k).length])):null};}
 else if(tool==='overview')out={kind:'overview',title:'營運工作概況',activeOrders:all(s,'orders',c).filter(x=>x.status==='active').length,openTasks:all(s,'tasks',c).filter(x=>x.status!=='done'),source:'隔離測試資料'};
 else if(tool==='tasks.list')out={kind:'table',title:'營運任務',rows:all(s,'tasks',c)};
 else if(tool==='tasks.create'){need(text(a.title,180)&&s.get('bots',a.assignee)?.active&&date(a.due),'任務需標題、啟用中的負責 Bot 與日期。');out={kind:'record',title:'任務已建立',record:changed('tasks',{id:uid('T'),property:c.property,title:a.title,assignee:a.assignee,due:a.due,status:'todo'})};}
 else if(tool==='tasks.update'){const v=scoped(s,'tasks',a.id,c);version(v,a);need(['todo','doing','done'].includes(a.status),'任務狀態無效。');out={kind:'record',title:'任務已更新',record:changed('tasks',{...v,status:a.status})};}
 else if(tool==='orders.list'){const r=range(a);out={kind:'table',title:'訂單清單',rows:all(s,'orders',c).filter(x=>a.id?x.id===a.id:x.start<r.end&&x.end>r.start).map(x=>({...x,received:receipts(s,x.id),balance:x.total===null?null:round(x.total-receipts(s,x.id))})),range:r};}
 else if(tool==='availability'){const r=range(a);out={kind:'table',title:'期間可用房間',range:r,rows:rooms[c.property].map(room=>({room,available:!all(s,'orders',c).some(o=>o.status==='active'&&o.room===room&&o.start<r.end&&o.end>r.start)})),note:'隔離訂單推算；不代表正式 OTA 可售庫存。'};}
 else if(tool==='orders.create'){const v={id:uid('S'),property:c.property,room:a.room,start:a.start,end:a.end,guest:a.guest,total:a.total,channel:a.channel,status:'active'};orderCheck(s,c,v);out={kind:'record',title:'隔離訂單已建立',record:changed('orders',v)};}
 else if(tool==='orders.update'){const old=scoped(s,'orders',a.id,c);version(old,a);need(old.status==='active','已取消訂單不可修改。');const v={...old};for(const k of ['room','start','end','guest','total','channel'])if(Object.hasOwn(a,k))v[k]=a[k];orderCheck(s,c,v,v.id);out={kind:'record',title:'隔離訂單已更新',record:changed('orders',v)};}
 else if(tool==='orders.cancel'){const v=scoped(s,'orders',a.id,c);version(v,a);need(v.status==='active','訂單已取消。');out={kind:'record',title:'訂單已取消，收款歷史保留',record:changed('orders',{...v,status:'canceled'}),note:receipts(s,v.id)>0?'仍有收款，請交財務核對；未執行退款。':null};}
 else if(tool==='finance.summary'){const r=range(a),orders=all(s,'orders',c).filter(x=>x.status==='active'&&x.start>=r.start&&x.start<r.end);out={kind:'finance',title:'收款核對',range:r,orderTotal:round(orders.filter(x=>x.total!==null).reduce((n,x)=>n+x.total,0)),unknownOrders:orders.filter(x=>x.total===null).length,cohortReceipts:round(orders.reduce((n,x)=>n+receipts(s,x.id),0)),cashFlow:round(all(s,'payments',c).filter(x=>x.receivedAt>=r.start&&x.receivedAt<r.end).reduce((n,x)=>n+x.amount,0)),payments:all(s,'payments',c),note:'應收按入住日歸期；現金流按收款日歸期。未知總額不算零；未扣佣金成本，不代表淨利。'};}
 else if(tool==='payments.record'){const o=scoped(s,'orders',a.orderId,c);need(o.status==='active','已取消訂單不能新增收款。');need(Number.isFinite(a.amount)&&a.amount>0&&a.amount<=10000000&&Math.abs(a.amount*100-Math.round(a.amount*100))<1e-6,'收款金額需為正數，最多小數兩位。');need(['cash','transfer','card'].includes(a.method)&&date(a.receivedAt),'請提供有效方式與收款日期。');need(o.total!==null,'訂單總額未知，請訂房經理先確認。');need(Math.round((receipts(s,o.id)+a.amount)*100)<=Math.round(o.total*100),'收款超過訂單應收。');out={kind:'record',title:'隔離收款已登記',record:changed('payments',{id:uid('P'),property:c.property,orderId:o.id,amount:a.amount,method:a.method,receivedAt:a.receivedAt,type:'receipt'})};}
 else if(tool==='payments.reverse'){const v=scoped(s,'payments',a.id,c);need(v.type==='receipt'&&text(a.reason,300),'僅能沖銷原收款，並需填原因。');need(!all(s,'payments',c).some(x=>x.reverses===v.id),'這筆收款已沖銷。');out={kind:'record',title:'已新增沖銷紀錄（未執行實際退款）',record:changed('payments',{id:uid('P'),property:c.property,orderId:v.orderId,amount:-v.amount,method:v.method,receivedAt:today(),type:'reversal',reverses:v.id,reason:a.reason})};}
 else if(tool==='documents.list')out={kind:'documents',title:'可讀取文件',rows:all(s,'documents',c).filter(x=>!x.archived&&x.dataset===c.dataset&&c.bot.read.includes(x.category)).map(x=>{const result={...x};delete result.content;return result})};
 else if(tool==='documents.read'){const d=scoped(s,'documents',a.id,c);docPermit(c,d,'read');need(!d.archived,'文件已封存。');out={kind:'document',title:d.title,record:d};}
 else if(tool==='documents.create'){docPermit(c,{category:a.category,dataset:c.dataset},'write');need(text(a.title,150)&&text(a.content,20000),'請提供文件標題與內容。');out={kind:'document',title:'文件已新增',record:changed('documents',{id:uid('D'),property:c.property,dataset:c.dataset,category:a.category,title:a.title,content:a.content,archived:false})};}
 else if(tool==='documents.update'||tool==='documents.archive'){const d=scoped(s,'documents',a.id,c);docPermit(c,d,'write');version(d,a);need(!d.archived,'文件已封存。');if(tool==='documents.update')need(text(a.title,150)&&text(a.content,20000),'請提供標題與內容。');out={kind:'document',title:tool==='documents.archive'?'文件已封存':'文件已更新',record:changed('documents',tool==='documents.archive'?{...d,archived:true}:{...d,title:a.title,content:a.content})};}
 else if(tool==='reports.booking')out=reportBooking(s,c,a);
 else if(tool==='market.list')out={kind:'table',title:'市場證據',rows:all(s,'market',c).filter(x=>!x.archived)};
 else if(tool==='market.add'){need(text(a.name,120)&&text(a.url,1500)&&/^https:\/\//.test(a.url),'需來源名稱與 HTTPS 來源網址。');let url;try{url=new URL(a.url)}catch{fail('invalid_input','網址無效。')}need(!url.username&&!url.password,'來源網址不可包含登入資訊。');need(date(a.stayDate)&&Number.isInteger(a.nights)&&a.nights>0&&a.nights<=30&&Number.isInteger(a.guests)&&a.guests>0&&a.guests<=30,'需有效入住日期、晚數與人數。');need(Number.isFinite(a.price)&&a.price>=0&&a.price<=10000000&&typeof a.taxIncluded==='boolean'&&text(a.cancellation,200),'需有效報價、稅費及取消條件。');need(typeof a.observedAt==='string'&&!isNaN(Date.parse(a.observedAt))&&Date.parse(a.observedAt)<=Date.now()+60000,'需有效且非未來的觀察時間。');out={kind:'record',title:'市場證據已保存',record:changed('market',{id:uid('M'),property:c.property,name:a.name,url:a.url,stayDate:a.stayDate,nights:a.nights,guests:a.guests,price:a.price,taxIncluded:a.taxIncluded,cancellation:a.cancellation,observedAt:a.observedAt,provenance:'業主提供・尚未獨立查證',archived:false})};}
 else if(tool==='market.archive'){const v=scoped(s,'market',a.id,c);version(v,a);out={kind:'record',title:'市場證據已封存',record:changed('market',{...v,archived:true})};}
 else if(tool==='reports.market'){
 const t=s.get('templates','market'),rows=all(s,'market',c).filter(x=>!x.archived),groups=new Map();
 for(const x of rows){const k=JSON.stringify([x.stayDate,x.nights,x.guests,x.taxIncluded,x.cancellation]);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x);}
 const comparisons=[...groups.values()].map(g=>{const prices=g.map(x=>x.price).sort((a,b)=>a-b);return {stayDate:g[0].stayDate,nights:g[0].nights,guests:g[0].guests,taxIncluded:g[0].taxIncluded,cancellation:g[0].cancellation,samples:g.length,median:g.length<2?null:round((prices[Math.floor((prices.length-1)/2)]+prices[Math.floor(prices.length/2)])/2)}});
 out={kind:'market-report',title:t.title,templateVersion:t.version,sections:t.sections.map(sec=>({title:sec.title,group:sec.group,rows:sec.group==='evidence'?rows:sec.group==='comparisons'?comparisons:[{gap:rows.length?'來源由業主提供，尚未接競品雷達即時查證。':'尚無市場證據，不能推論價格或售罄。'}]})),comparisons,note:t.note,source:{mode:'sandbox',title:'隔離市場證據'}};
 }
 else fail('unknown_tool','工具不存在。');
 out={...out,tool,property:c.property,dataset:c.dataset};
 if(mutate){s.db.prepare('INSERT INTO effects VALUES(?,?,?)').run(key,fingerprint,JSON.stringify(out));s.audit({botId:c.bot.id,property:c.property,dataset:c.dataset,tool,status:'verified',recordId:out.record?.id,version:out.record?.version,before:mutationBefore,after:out.record});const kind=tool.split('.')[0];const actual=s.get(kind,out.record.id);need(actual&&JSON.stringify(actual)===JSON.stringify(out.record),'寫入後核對失敗。');}
 return out;
 };
 try{return mutate?s.tx(run):run();}catch(e){s.audit({botId:c.bot.id,property:c.property,dataset:c.dataset,tool,status:'rejected',code:e.code||'error'});throw e;}
}
export function saveBot(s,a){
 need(Object.hasOwn(roles,a.role)&&text(a.name,40)&&text(a.mission,1200),'請填名稱、職責及能力角色。');const base=roles[a.role];for(const k of ['read','write','tools'])need(Array.isArray(a[k])&&a[k].every(x=>base[k].includes(x)),'權限不可超過能力角色上限。');need(a.write.every(x=>a.read.includes(x)),'可寫分類也必須可讀。');const old=a.id?s.get('bots',a.id):null;if(a.id)need(old,'Bot 不存在。');if(old)version(old,a);if(old&&a.active===false)need(s.all('bots').some(x=>x.id!==old.id&&x.active),'至少保留一個啟用中的 Bot。');const bot={id:old?.id||uid('bot'),role:a.role,name:a.name.trim(),mission:a.mission.trim(),read:[...new Set(a.read)],write:[...new Set(a.write)],tools:[...new Set(a.tools)],active:a.active!==false,version:(old?.version||0)+1};s.put('bots',bot);s.audit({actor:'owner',tool:'settings.bot',recordId:bot.id,status:'saved'});return bot;
}
export function saveTemplate(s,a){const old=s.get('templates',a.id);need(old,'模板不存在。');version(old,a);need(text(a.title,100)&&text(a.note,1000)&&Array.isArray(a.sections)&&a.sections.length>=1&&a.sections.length<=8,'模板需標題、說明與 1–8 個章節。');for(const sec of a.sections){need(text(sec.title,80)&&Array.isArray(sec.metrics),'章節格式無效。');if(a.id==='booking'){need(['all','room','channel'].includes(sec.group)&&sec.metrics.length>=1&&sec.metrics.length<=7&&sec.metrics.every(m=>Object.hasOwn(metrics,m)),'請選有效分組及指標。');if(sec.group==='channel')need(!sec.metrics.some(m=>['capacity','occupancy'].includes(m)),'通路沒有独立庫存分母，不能計通路住房率。');}else need(['evidence','comparisons','gaps'].includes(sec.group)&&sec.metrics.length===0,'市場模板只允許證據和缺口章節。');}
 const v={id:a.id,title:a.title,note:a.note,sections:a.sections.map(x=>({title:x.title,group:x.group,metrics:[...new Set(x.metrics)]})),version:old.version+1};s.put('templates',v);s.audit({actor:'owner',tool:'settings.template',recordId:v.id,status:'saved',version:v.version});return v;}
