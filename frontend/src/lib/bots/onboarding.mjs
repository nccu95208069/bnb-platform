import {parseFile,normalizeImport,suggestMapping,readPublicSheet} from './imports.mjs';
import {fail,rooms} from './core.mjs';
import {roles} from './catalog.mjs';
export const connections=[
 {id:'calendar',name:'訂房月曆',owner:'訂房經理',state:'同步來源唯讀',url:'/calendar',detail:'沿用 Sweetfun OS 水芳訂單同步，不重複匯入。'},
 {id:'analysis',name:'訂單分析',owner:'分析專家',state:'已接固定分析工具',role:'analyst',detail:'使用同一批房晚資料，依你設定的框架計算。'},
 {id:'health',name:'營收健檢',owner:'財務經理',state:'可用表載房費核對',role:'finance',detail:'目前提供訂單房費與缺漏核對；原營收健檢完整模型尚未接入，實收、成本及淨利保留未知。'},
 {id:'cleaning',name:'清掃管理 RoomReady',owner:'總管家',state:'可開啟原產品・資料尚未連通',url:'https://haosuguan-cleaning.nccu95208069.chatgpt.site',detail:'清掃派工與回報仍在原產品操作。需要對應據點與登入授權後才能在 Bot 讀取，隔離待辦不等於正式清掃任务。'},
 {id:'radar',name:'競品雷達 / Grok',owner:'市場調查經理',state:'可開啟原產品・掃描尚未連通',url:'https://daili-radar-test.vercel.app/radar-test',role:'market',detail:'可先建立研究範圍；目前不能從 Bot 啟動 Grok 掃描。未接入即時競品價格，不會顯示虛構報價。'}
];
export function setupState(s){return {profiles:s.all('onboarding'),imports:s.all('imports').map(({rows,issues,...v})=>({...v,rowCount:rows.length,issueCount:issues.length})),connections};}
export function saveSetup(s,a){
 if(!Object.hasOwn(rooms,a.property)||!Object.hasOwn(roles,a.role))fail('invalid_input','請選擇有效據點與角色。');
 const allowed=['existing','imported','later'];if(!allowed.includes(a.source))fail('invalid_input','請選擇資料來源。');
 if(a.source==='existing'&&a.property!=='sweetfun')fail('not_configured','此據點尚無正式同步來源。');
 if(a.source==='imported'&&!s.get('imports',a.property))fail('not_configured','請先完成訂單匯入。');
 const goal=String(a.goal||'').trim(),competitors=String(a.competitors||'').trim();if(goal.length>500||competitors.length>1000)fail('invalid_input','設定文字過長。');
 const id=a.property+':'+a.role,v={id,property:a.property,role:a.role,source:a.source,goal,competitors,updatedAt:new Date().toISOString()};s.put('onboarding',v);s.audit({tool:'onboarding.save',property:a.property,botId:a.role,status:'completed'});return v;
}
export async function importData(s,a){
 if(!Object.hasOwn(rooms,a.property))fail('invalid_input','據點不存在。');
 if(!['inspect','preview','commit'].includes(a.stage))fail('invalid_input','匯入步驟無效。');
 let draft;
 if(a.url){if(a.stage!=='inspect')fail('invalid_input','請使用預覽時下載的表格檔案內容。');draft=await readPublicSheet(a.url);}
 else{if(typeof a.name!=='string'||typeof a.base64!=='string'||a.base64.length>2800000||!/^[A-Za-z0-9+/]*={0,2}$/.test(a.base64))fail('invalid_file','請提供有效檔案，最多 2 MB。');draft=await parseFile(a.name,Buffer.from(a.base64,'base64'));}
 if(a.stage==='inspect')return {sheets:draft.sheets.map(x=>({name:x.name,headerRow:x.headerRow,headers:x.rows.slice(0,20),preview:x.rows.slice(0,6),mapping:suggestMapping(x.rows[x.headerRow]),rowCount:x.rows.length-1})),...(a.url?{sheetFile:draft.download}:{})};
 const normalized=normalizeImport(draft,a.options||{});
 if(!normalized.rows.length)fail('empty_import','沒有有效房晚可匯入，請核對欄位。');
 if(a.stage==='preview')return {...normalized,rows:normalized.rows.slice(0,10),rowCount:normalized.rows.length,issues:normalized.issues.slice(0,100),issueCount:normalized.issues.length};
 if(a.confirmHash!==normalized.hash)fail('preview_changed','資料或欄位已變更，請重新預覽。',409);
 if(normalized.issues.length&&!a.acceptSkipped)fail('review_required','請先確認略過的無效資料列。');
 const old=s.get('imports',a.property);if((old?.hash||null)!==(a.expectedPreviousHash??null)&&old?.hash!==normalized.hash)fail('version_conflict','匯入資料已被更新，請重新整理後再試。',409);
 if(old?.hash===normalized.hash)return {saved:true,rowCount:old.rows.length,hash:old.hash};
 s.put('imports',{id:a.property,...normalized});s.audit({tool:'orders.import',property:a.property,status:'completed',rows:normalized.rows.length,sourceHash:normalized.hash});
 return {saved:true,rowCount:normalized.rows.length,hash:normalized.hash};
}
export function importedSnapshot(s,property){const v=s.get('imports',property);if(!v)fail('not_configured','請先由總管家完成訂單匯入。',409);return {imported:true,rooms:v.rooms,period:v.period,source:{title:'匯入訂單・'+v.sourceName,sync:{last_checked_at:v.importedAt},snapshot_version:v.hash},bookings:v.rows.map((r,i)=>({id:'import-'+i,room_number:r.room,check_in:r.day,check_out:new Date(Date.parse(r.day)+86400000).toISOString().slice(0,10),platform:r.channel,room_rate:r.fee,price_hidden:r.fee===null,source_conflict:r.ambiguous}))};}
