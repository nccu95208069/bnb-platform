import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {fail} from './core.mjs';
const MAX_ROWS=5000,MAX_BYTES=2*1024*1024;
const fields={room:['房型','房間','房號','room','roomnumber','room_number'],start:['入住日期','入住','checkin','check_in','arrival','start'],end:['退房日期','退房','checkout','check_out','departure','end'],amount:['房費','金額','總額','total','amount','price','room_rate'],channel:['預定平台','訂房平台','通路','channel','platform'],status:['訂單狀態','狀態','status'],id:['訂單編號','訂單id','orderid','order_id','bookingid'],book:['預訂日期','訂房日期','booked_at','bookingdate']};
const cell=v=>v instanceof Date?v.toISOString().slice(0,10):v==null?'':typeof v==='object'?(v.formula?'':v.text||v.richText?.map(x=>x.text).join('')||''):String(v).trim().slice(0,300);
function csv(text,delimiter){const rows=[];let row=[],value='',quoted=false;for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++}else quoted=!quoted;}else if(ch===delimiter&&!quoted){row.push(value);value='';}else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(Boolean))rows.push(row);row=[];value='';}else value+=ch;if(rows.length>MAX_ROWS+50)fail('too_large','每次最多 5,000 筆資料。');}if(quoted)fail('invalid_file','CSV 引號不完整。');row.push(value);if(row.some(Boolean))rows.push(row);return rows;}
function zipLimit(buffer){let total=0,entries=0;for(let i=0;i<buffer.length-46;i++)if(buffer.readUInt32LE(i)===0x02014b50){total+=buffer.readUInt32LE(i+24);entries++;if(total>24*1024*1024||entries>5000)fail('too_large','Excel 解壓後過大，請另存較小的 CSV。');}if(!entries)fail('invalid_file','請使用有效的 .xlsx 檔案。');}
export async function parseFile(name,buffer){
 if(!buffer.length||buffer.length>MAX_BYTES)fail('too_large','檔案需介於 1 byte 與 2 MB。');
 let sheets;
 if(/\.xlsx$/i.test(name)){zipLimit(buffer);const book=new ExcelJS.Workbook();await book.xlsx.load(buffer);if(book.worksheets.length>20)fail('too_large','最多 20 個工作表。');sheets=book.worksheets.map(sheet=>{if(sheet.rowCount>MAX_ROWS+50||sheet.columnCount>100)fail('too_large','最多 5,000 列、100 欄。');const rows=[];sheet.eachRow(r=>rows.push(r.values.slice(1).map(cell)));return {name:sheet.name,rows}});}
 else if(/\.(csv|tsv|txt)$/i.test(name)){const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer).replace(/^\uFEFF/,'');sheets=[{name:'資料',rows:csv(text,/\.tsv$/i.test(name)||text.split(/\r?\n/)[0].includes('\t')?'\t':',')}];}
 else if(/\.json$/i.test(name)){const data=JSON.parse(buffer.toString('utf8'));if(!Array.isArray(data)||data.length>MAX_ROWS||!data.every(x=>x&&typeof x==='object'&&!Array.isArray(x)))fail('invalid_file','JSON 需為物件陣列。');const headers=[...new Set(data.flatMap(Object.keys))];sheets=[{name:'資料',rows:[headers,...data.map(r=>headers.map(h=>cell(r[h])))]}];}
 else fail('invalid_file','支援 .xlsx、UTF-8 CSV、TSV、JSON；舊版 .xls 請另存 .xlsx。');
 if(sheets.some(s=>s.rows.some(r=>r.length>100)))fail('too_large','最多 100 欄。');
 sheets=sheets.filter(s=>s.rows.length>1).map(s=>({...s,rows:s.rows.map(row=>row.map(cell))}));if(!sheets.length)fail('invalid_file','找不到可讀取的資料列。');
 const hash=createHash('sha256').update(buffer).digest('hex');return {hash,name:name.slice(0,120),sheets:sheets.map(s=>({...s,headerRow:guessHeader(s.rows)}))};
}
function guessHeader(rows){let score=-1,best=0;rows.slice(0,20).forEach((r,i)=>{const n=Object.values(suggestMapping(r)).filter(x=>x>=0).length;if(n>score){score=n;best=i}});return best;}
export function suggestMapping(headers){return Object.fromEntries(Object.entries(fields).map(([key,names])=>[key,headers.findIndex(h=>names.includes(String(h).toLowerCase().replace(/\s/g,'')))]));}
const date=(v,order)=>{let x=String(v??'').trim();if(/^\d{5}(\.\d+)?$/.test(x))return new Date(Date.UTC(1899,11,30)+Math.floor(Number(x))*86400000).toISOString().slice(0,10);let m=/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T].*)?$/.exec(x);if(!m){const a=/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(x);if(a&&order!=='ymd')m=[a[0],a[3],order==='dmy'?a[2]:a[1],order==='dmy'?a[1]:a[2]];}if(!m)return null;x=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;return Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x?x:null;};
export function normalizeImport(draft,options){
 const sheet=draft.sheets[options.sheetIndex||0],header=Number(options.headerRow);if(!sheet||!Number.isInteger(header)||header<0||header>=Math.min(20,sheet.rows.length))fail('invalid_mapping','請選擇工作表與標題列。');
 const mapping=options.mapping||{},width=sheet.rows[header].length;
 for(const field of Object.keys(fields)){const col=mapping[field];if(!Number.isInteger(col)||col< -1||col>=width)fail('invalid_mapping','欄位對應不正確。');}
 if(mapping.room<0||mapping.start<0||mapping.end<0)fail('invalid_mapping','房間、入住及退房日期為必填欄位。');
 if(!['total','nightly','unknown'].includes(options.amountBasis)||!['ymd','dmy','mdy'].includes(options.dateOrder))fail('invalid_mapping','請確認金額口徑與日期格式。');
 const rooms=String(options.rooms||'').split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);if(!rooms.length||rooms.length>50||new Set(rooms).size!==rooms.length||rooms.some(r=>r.length>40))fail('invalid_mapping','請填寫完整房間清單（逗號分隔，最多 50 間），包含目前沒有訂單的房間。');
 const raw=sheet.rows.slice(header+1);if(raw.length>MAX_ROWS)fail('too_large','最多 5,000 筆訂單。');const rows=[],issues=[],seen=new Set();let canceled=0,duplicates=0;
 for(let i=0;i<raw.length;i++){
  const r=raw[i];if(!r.some(Boolean))continue;const get=k=>cell(r[mapping[k]]);const room=get('room'),start=date(get('start'),options.dateOrder),end=date(get('end'),options.dateOrder),status=get('status').toLowerCase();
  if(/^(取消|已取消|cancelled|canceled|cancel)$/.test(status)){canceled++;continue;}
  const nights=(Date.parse(end)-Date.parse(start))/86400000;
  if(!rooms.includes(room)||!start||!end||!(nights>0&&nights<=365)){issues.push({列:i+header+2,問題:'房間或日期無效；請修正來源後重新上傳'});continue;}
  const amountText=get('amount').replace(/[,，$\s]|NTD|TWD|NT\$/gi,'');const amount=options.amountBasis==='unknown'||!amountText?null:Number(amountText);
  if(amount!==null&&(!Number.isFinite(amount)||amount<0||amount>10000000)){issues.push({列:i+header+2,問題:'金額格式無效；請核對'});continue;}
  const channel=get('channel')||'未提供',book=date(get('book'),options.dateOrder);
  const signature=JSON.stringify([get('id'),room,start,end,amount,channel,status]);if(seen.has(signature)){duplicates++;continue;}seen.add(signature);
  for(let n=0;n<nights;n++){const day=new Date(Date.parse(start)+n*86400000).toISOString().slice(0,10);rows.push({room,day,book,channel,fee:amount===null?null:options.amountBasis==='total'?amount/nights:amount,ambiguous:false});}
  if(rows.length>12000)fail('too_large','房晚超過 12,000 筆，請縮小匯入期間。');
 }
 const grouped=new Map();for(const r of rows){const key=r.room+'|'+r.day;grouped.set(key,[...(grouped.get(key)||[]),r]);}
 let conflicts=0;const normalized=[...grouped.values()].map(g=>{if(g.length>1){conflicts++;return {...g[0],fee:null,channel:'待確認',ambiguous:true}}return g[0]});
 const minimum=normalized.map(r=>r.day).sort()[0],maximum=normalized.map(r=>r.day).sort().at(-1);
 return {rows:normalized,rooms,issues,canceled,duplicates,conflicts,period:{start:minimum,end:maximum?new Date(Date.parse(maximum)+86400000).toISOString().slice(0,10):null},sourceName:draft.name,hash:createHash('sha256').update(JSON.stringify([draft.hash,options])).digest('hex'),importedAt:new Date().toISOString()};
}
export async function readPublicSheet(link){let u;try{u=new URL(link)}catch{fail('invalid_url','請貼 Google Sheet 網址。');}const match=/^\/spreadsheets\/d\/([\w-]{20,100})/.exec(u.pathname);if(u.protocol!=='https:'||u.hostname!=='docs.google.com'||!match||u.username||u.password)fail('invalid_url','僅接受 docs.google.com 的 Google Sheet 網址。');const gid=u.searchParams.get('gid')||new URLSearchParams(u.hash.slice(1)).get('gid')||'0';if(!/^\d{1,20}$/.test(gid))fail('invalid_url','工作表識別碼無效。');let url=`https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`;
 for(let n=0;n<3;n++){const res=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000),cache:'no-store'});if([301,302,303,307,308].includes(res.status)){const next=new URL(res.headers.get('location')||'',url);if(next.protocol!=='https:'||!(next.hostname==='docs.google.com'||next.hostname.endsWith('.googleusercontent.com'))||next.username||next.password)fail('sheet_private','這份表格需要登入；請下載 Excel 後上傳，不必更改分享權限。',403);url=next.href;continue;}if(!res.ok||res.headers.get('content-type')?.includes('text/html'))fail('sheet_private','表格無法公開讀取；請下载 Excel 上傳，不必更改分享權限。',403);const reader=res.body.getReader(),chunks=[];let size=0;while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES){await reader.cancel();fail('too_large','表格超過 2 MB，請縮小後上傳。');}chunks.push(value);}const bytes=Buffer.concat(chunks);return {...await parseFile('Google-Sheet.csv',bytes),download:{name:'Google-Sheet.csv',base64:bytes.toString('base64')}};}fail('sheet_unavailable','無法讀取表格，請改用 Excel 或 CSV。');}
