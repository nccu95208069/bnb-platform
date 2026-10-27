import {createHash,randomUUID} from 'node:crypto';
import {accessToken} from './sheet-monitor/google.ts';
import {FINANCE_SHEET_HEADERS,FINANCE_SHEET_INPUT_TAB,
  scanFinanceSheet} from './finance-sheet-bulk-core.ts';

export type FinanceSheetBinding={spreadsheetId:string;sheetId:number;
  propertyDisplay:string;credentialEnv:string};
const ID=/^[A-Za-z0-9_-]{10,128}$/;
const ROOT='https://sheets.googleapis.com/v4/spreadsheets/';
const privateFetch=async(url:string,token:string,options:RequestInit,send:typeof fetch)=>{
  let response:Response;
  try{response=await send(url,{...options,headers:{Authorization:`Bearer ${token}`,
    ...(options.body?{'Content-Type':'application/json'}:{})},cache:'no-store',
    redirect:'error',signal:AbortSignal.timeout(12_000)});}
  catch{throw Error('SHEET_API_UNAVAILABLE');}
  if(!response.ok)throw Error(response.status===401||response.status===403?
    'SHEET_API_FORBIDDEN':'SHEET_API_UNAVAILABLE');
  return response.json() as Promise<Record<string,unknown>>;
};
function config(binding:FinanceSheetBinding){
  if(!ID.test(binding.spreadsheetId)||!Number.isSafeInteger(binding.sheetId)||
    binding.sheetId<0||!binding.propertyDisplay||binding.propertyDisplay.length>80||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(binding.credentialEnv))
    throw Error('SHEET_CONFIG_INVALID');
}
const range=(first:string,last:string)=>encodeURIComponent(
  `'${FINANCE_SHEET_INPUT_TAB.replaceAll("'","''")}'!${first}:${last}`);

/** Reads only the registered workbook and tab; no caller supplies an A1 range. */
export async function readFinanceSheet(binding:FinanceSheetBinding,send:typeof fetch=fetch){
  config(binding);
  const token=await accessToken(binding,false,undefined,send);
  const base=ROOT+binding.spreadsheetId;
  const metadata=await privateFetch(base+
    '?fields=properties(timeZone),sheets(properties(sheetId,title,gridProperties),protectedRanges(range,warningOnly))',
    token,{method:'GET'},send);
  const sheets=metadata.sheets;
  if(!Array.isArray(sheets)||!metadata.properties||
    (metadata.properties as Record<string,unknown>).timeZone!=='Asia/Taipei')
    throw Error('SHEET_IDENTITY_MISMATCH');
  const selected=sheets.find(raw=>raw&&typeof raw==='object'&&
    (raw as {properties?:{sheetId?:number}}).properties?.sheetId===binding.sheetId) as
    {properties?:{title?:string;gridProperties?:{rowCount?:number;columnCount?:number}};
      protectedRanges?:{warningOnly?:boolean;range?:{sheetId?:number;
        startColumnIndex?:number;endColumnIndex?:number;
        startRowIndex?:number;endRowIndex?:number}}[]}|undefined;
  const props=selected?.properties;
  if(props?.title!==FINANCE_SHEET_INPUT_TAB||
    !Number.isSafeInteger(props.gridProperties?.rowCount)||
    props.gridProperties!.rowCount!<2||props.gridProperties!.rowCount!>5001||
    !Number.isSafeInteger(props.gridProperties?.columnCount)||
    props.gridProperties!.columnCount!<FINANCE_SHEET_HEADERS.length)
    throw Error('SHEET_IDENTITY_MISMATCH');
  // Protected system columns must remain protected even when the business
  // range grows. A warning-only protection cannot guard row identity.
  for(const column of [0,1,16,17,18,19]){
    const protectedColumn=selected?.protectedRanges?.some(item=>{
      const r=item.range;
      return item.warningOnly!==true&&r?.sheetId===binding.sheetId&&
        (r.startColumnIndex??0)<=column&&
        (r.endColumnIndex??props.gridProperties!.columnCount!)>column&&
        (r.startRowIndex??0)===0&&
        (r.endRowIndex==null||r.endRowIndex>=props.gridProperties!.rowCount!);
    });
    if(!protectedColumn)throw Error('SHEET_PROTECTION_MISSING');
  }
  const value=await privateFetch(base+'/values/'+
    range('A1',`T${props.gridProperties!.rowCount}`)+
    '?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS',
    token,{method:'GET'},send);
  if(value.majorDimension!=='ROWS'||!Array.isArray(value.values))
    throw Error('SHEET_INCOMPLETE_READ');
  const values=value.values as unknown[][];
  scanFinanceSheet(values,binding.propertyDisplay);
  return values;
}

async function writeValues(binding:FinanceSheetBinding,updates:{cell:string;value:string|number}[],
  send:typeof fetch){
  const token=await accessToken(binding,true,undefined,send);
  const result=await privateFetch(ROOT+binding.spreadsheetId+'/values:batchUpdate',token,
    {method:'POST',body:JSON.stringify({valueInputOption:'RAW',
      data:updates.map(({cell,value})=>({range:`'${FINANCE_SHEET_INPUT_TAB}'!${cell}`,
        majorDimension:'ROWS',values:[[value]]}))})},send);
  if(result.totalUpdatedCells!==updates.length)throw Error('SHEET_WRITE_UNCONFIRMED');
}

/** A new row ID is assigned before any finance preview, then re-read. */
export async function claimFinanceSheetRow(binding:FinanceSheetBinding,sheetRow:number,
  expectedBusinessHash:string,send:typeof fetch=fetch){
  if(!Number.isSafeInteger(sheetRow)||sheetRow<2||sheetRow>5001||
    !/^[0-9a-f]{64}$/.test(expectedBusinessHash))throw Error('SHEET_IDENTITY_INVALID');
  const before=await readFinanceSheet(binding,send);
  const scan=scanFinanceSheet(before,binding.propertyDisplay);
  const candidate=scan.unassigned.find(row=>row.sheet_row===sheetRow&&
    row.content_hash===expectedBusinessHash);
  if(!candidate)throw Error('SHEET_ROW_CHANGED');
  const id=randomUUID();
  await writeValues(binding,[{cell:`A${sheetRow}`,value:id}],send);
  const after=await readFinanceSheet(binding,send);
  const verified=scanFinanceSheet(after,binding.propertyDisplay);
  const current=after[sheetRow-1];
  const hash=createHash('sha256').update(JSON.stringify(current?.slice(2,16))).digest('hex');
  if(hash!==expectedBusinessHash||current?.[0]!==id||
    !verified.rows.some(row=>row.row_id===id&&row.sheet_row===sheetRow)||
    verified.issues.some(issue=>issue.row_id===id))
    throw Error('SHEET_WRITE_UNCONFIRMED');
  return id;
}

/** Projection is best effort; Iron Gate receipt remains authoritative. */
export async function projectFinanceSheetReceipt(binding:FinanceSheetBinding,rowId:string,
  expectedContentHash:string,version:number,eventId:string,
  status:'accepted'|'void'='accepted',send:typeof fetch=fetch){
  if(!/^[0-9a-f-]{36}$/i.test(rowId)||
    !/^[0-9a-f]{64}$/.test(expectedContentHash)||
    !Number.isSafeInteger(version)||version<1||
    !/^[0-9a-f-]{36}$/i.test(eventId))throw Error('SHEET_PROJECTION_INVALID');
  const before=scanFinanceSheet(await readFinanceSheet(binding,send),binding.propertyDisplay);
  const row=before.rows.find(item=>item.row_id===rowId);
  if(!row)throw Error('SHEET_PROJECTION_STALE');
  const writeStatus=row.content_hash===expectedContentHash?status:
    status==='void'?'void_review':'pending_revision';
  if(row.base_version===version&&row.accepted_hash===expectedContentHash&&
    row.event_id===eventId&&row.sync_status===writeStatus)return true;
  if(row.base_version===version&&row.accepted_hash===expectedContentHash&&
    row.event_id===eventId){
    await writeValues(binding,[{cell:`Q${row.sheet_row}`,value:writeStatus}],send);
    const corrected=scanFinanceSheet(await readFinanceSheet(binding,send),
      binding.propertyDisplay).rows.find(item=>item.row_id===rowId);
    if(corrected?.sync_status!==writeStatus)throw Error('SHEET_WRITE_UNCONFIRMED');
    return true;
  }
  if(row.base_version!==version-1)throw Error('SHEET_PROJECTION_STALE');
  await writeValues(binding,[{cell:`B${row.sheet_row}`,value:version},
    {cell:`Q${row.sheet_row}`,value:writeStatus},
    {cell:`R${row.sheet_row}`,value:''},
    {cell:`S${row.sheet_row}`,value:expectedContentHash},
    {cell:`T${row.sheet_row}`,value:eventId}],send);
  const after=scanFinanceSheet(await readFinanceSheet(binding,send),binding.propertyDisplay);
  const verified=after.rows.find(item=>item.row_id===rowId);
  if(!verified||verified.base_version!==version||
    verified.sync_status!==(verified.content_hash===expectedContentHash?status:
      status==='void'?'void_review':'pending_revision')||
    verified.accepted_hash!==expectedContentHash||
    verified.event_id!==eventId||after.issues.some(issue=>issue.row_id===rowId))
    throw Error('SHEET_WRITE_UNCONFIRMED');
  return true;
}
