import {createHash} from 'node:crypto';
import {SWEETFUN_SOURCE,type SheetSourceDefinition} from './booking-sources/config.ts';
import {accessToken} from './sheet-monitor/google.ts';
import {HEADERS,normalizeRows} from './sheet-monitor/reconcile.ts';
import {adaptSheetBookings} from './booking-sources/sweetfun-sheet.ts';
import {checkRows,type OrderCheck,type Receipt,type SheetSync} from './os-payments.ts';
import {redisCommand} from './workspace-auth/store.ts';

type Cell={formattedValue?:string;userEnteredValue?:{stringValue?:string;numberValue?:number;boolValue?:boolean;formulaValue?:string};note?:string};
export type PaymentGrid={cells:Cell[][]};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const opaque=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,20);
export const supportsSheetPayment=(source:SheetSourceDefinition)=>source.sourceId===SWEETFUN_SOURCE.sourceId&&source.spreadsheetId===SWEETFUN_SOURCE.spreadsheetId&&source.sheetId===SWEETFUN_SOURCE.sheetId&&source.sheetTitle===SWEETFUN_SOURCE.sheetTitle;

async function client(source:SheetSourceDefinition){
  if(!supportsSheetPayment(source))throw new Error('SHEET_PAYMENT_UNSUPPORTED');
  const token=await accessToken(source,true);
  return async(path:string,body?:unknown)=>{
    const response=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${source.spreadsheetId}${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error(response.status===401||response.status===403?'SHEET_PAYMENT_PERMISSION':'SHEET_PAYMENT_UNAVAILABLE');
    return response.json();
  };
}
type Client=Awaited<ReturnType<typeof client>>;
// Authenticated capability probe: Sheets validates write authorization without
// touching any cell. Credentials remain inside the deployed server.
export async function checkSheetPaymentAccess(source:SheetSourceDefinition){
  const request=await client(source);
  await request(':batchUpdate',{requests:[]});
}
async function readGrid(source:SheetSourceDefinition,request:Client):Promise<PaymentGrid>{
  const metadata=await request('?fields=properties(timeZone),sheets(properties(sheetId,title,gridProperties))');
  const sheet=metadata.sheets?.find((s:{properties:{sheetId:number}})=>s.properties.sheetId===source.sheetId)?.properties;
  if(!sheet||sheet.title!==source.sheetTitle||metadata.properties?.timeZone!=='Asia/Taipei')throw new Error('SHEET_IDENTITY_MISMATCH');
  const rows=sheet.gridProperties?.rowCount;
  if(!Number.isInteger(rows)||rows<2||rows>50000||sheet.gridProperties.columnCount<14)throw new Error('SHEET_GRID_UNSUPPORTED');
  const range=`'${source.sheetTitle.replaceAll("'","''")}'!A1:N${rows}`;
  const doc=await request(`?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=sheets(properties(sheetId),data(startRow,startColumn,rowData(values(formattedValue,userEnteredValue,note))))`);
  const data=doc.sheets?.find((s:{properties:{sheetId:number}})=>s.properties.sheetId===source.sheetId)?.data;
  if(!Array.isArray(data)||data.length!==1||(data[0].startRow??0)!==0||(data[0].startColumn??0)!==0||!Array.isArray(data[0].rowData))throw new Error('SHEET_INCOMPLETE_READ');
  return {cells:data[0].rowData.map((r:{values?:Cell[]})=>r.values??[])};
}

// Resolve the entire order from stable J/L identities. Row numbers are used only
// for this fresh write, never persisted as an identity or reused on retry.
export function inspectPaymentGrid(grid:PaymentGrid,source:SheetSourceDefinition,order:string){
  const values=grid.cells.map(row=>row.map(c=>c.formattedValue??c.userEnteredValue?.stringValue??c.userEnteredValue?.numberValue??''));
  if(values[0]?.[7]!=='全額支付狀態'||values[0]?.[9]!=='唯一ID'||values[0]?.[11]!=='訂單編號')throw new Error('SHEET_IDENTITY_MISMATCH');
  const normalized=normalizeRows(values,source);
  const live=adaptSheetBookings([HEADERS,...normalized.map(r=>r.cells)],source.sourceId,new Date().toISOString(),[],normalized.map(r=>r.sourceRow),source.property);
  const check=checkRows(live.bookings,source.property.id,order);
  const targets=normalized.filter(r=>`SF-${opaque(`${source.sourceId}:order:${r.cells[11]||`ungrouped:${r.cells[9]}`}`)}`===order).map(r=>{
    const cell=grid.cells[r.sourceRow-1]?.[7]??{};
    if(cell.userEnteredValue?.formulaValue)throw new Error('SHEET_PAYMENT_FORMULA');
    return {uid:String(r.cells[9]),fingerprint:hash(r.cells.filter((_,i)=>i!==7)),row:r.sourceRow,cell};
  });
  if(!targets.length||targets.length!==check.nights||new Set(targets.map(r=>r.uid)).size!==targets.length)throw new Error('SOURCE_CONFLICT');
  return {check,targets};
}
export async function prepareSheetSync(source:SheetSourceDefinition,order:string,check:OrderCheck,paid:boolean):Promise<SheetSync>{
  const request=await client(source);
  const current=inspectPaymentGrid(await readGrid(source,request),source,order);
  if(current.check.source_version!==check.source_version)throw new Error('SOURCE_CHANGED');
  return {state:'pending',paid,targets:current.targets.map(({uid,fingerprint})=>({uid,fingerprint}))};
}
const methodLabels:Record<string,string>={bank_transfer:'銀行轉帳',credit_card:'刷卡',cash:'現金',ota:'OTA 代收',other:'其他'};
export function receiptSheetNote(receipt:Receipt){
  const account=receipt.payment_account;
  return [`[Sweetfun OS ${receipt.request_id}]`,receipt.status_only?'確認整張訂單房費已付清（未新增收入）':`本次收款 NT$ ${receipt.amount.toLocaleString('en-US')}｜${methodLabels[receipt.payment_method]}`,
    ...(!receipt.status_only&&account?[`帳戶：${account.name} · 末${account.last_digits.length}碼 ${account.last_digits}`]:[]),
    `時間：${new Date(receipt.received_at).toLocaleString('sv-SE',{timeZone:'Asia/Taipei'})}（台灣）｜登記：${receipt.actor_name}`,
    ...(receipt.note?[`備註：${receipt.note}`]:[])].join('\n');
}
export function sheetPaymentRequests(grid:PaymentGrid,source:SheetSourceDefinition,order:string,receipt:Receipt){
  if(!receipt.sheet_sync)throw new Error('SHEET_SYNC_PENDING');
  const current=inspectPaymentGrid(grid,source,order);
  const expected=receipt.sheet_sync.targets;
  if(expected.length!==current.targets.length||current.targets.some(t=>!expected.some(e=>e.uid===t.uid&&e.fingerprint===t.fingerprint)))throw new Error('SOURCE_CHANGED');
  const note=receiptSheetNote(receipt),marker=`[Sweetfun OS ${receipt.request_id}]`;
  const requests=current.targets.flatMap(t=>{
    const old=t.cell.note??'';
    if(old.includes(marker)&&!old.includes(note))throw new Error('SOURCE_CONFLICT');
    const nextNote=old.includes(note)?old:[old,note].filter(Boolean).join('\n\n');
    if(nextNote.length>45000)throw new Error('SHEET_NOTE_FULL');
    const needsPaid=receipt.sheet_sync!.paid&&t.cell.formattedValue!=='done'&&t.cell.userEnteredValue?.stringValue!=='done';
    if(nextNote===old&&!needsPaid)return [];
    return [{updateCells:{start:{sheetId:source.sheetId,rowIndex:t.row-1,columnIndex:7},rows:[{values:[{note:nextNote,...(needsPaid?{userEnteredValue:{stringValue:'done'}}:{})}]}],fields:needsPaid?'note,userEnteredValue':'note'}}];
  });
  return requests;
}
export async function syncReceiptToSheet(source:SheetSourceDefinition,order:string,receipt:Receipt,lock:{key:string;token:string}){
  if(receipt.sheet_sync?.state==='verified')return;
  const request=await client(source);
  const requests=sheetPaymentRequests(await readGrid(source,request),source,order,receipt);
  // The shared property lease serializes OS/finance writes. Sheets has no CAS
  // against human edits; fresh identity checks and authoritative readback are required.
  if(await redisCommand(['GET',lock.key])!==lock.token)throw new Error('VERSION_CONFLICT');
  if(requests.length)await request(':batchUpdate',{requests});
  if(sheetPaymentRequests(await readGrid(source,request),source,order,receipt).length)throw new Error('WRITE_UNCONFIRMED');
}
