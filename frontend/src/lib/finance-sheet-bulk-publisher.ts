import {accessToken} from './sheet-monitor/google.ts';
import {FINANCE_SHEET_TABS} from './finance-sheet-bulk-template.ts';
import type {FinanceSheetBinding} from './finance-sheet-bulk-google';
import {financeSheetProjectionDigest,type FinanceSheetProjection}
  from './finance-sheet-bulk-projections.ts';

const ROOT='https://sheets.googleapis.com/v4/spreadsheets/';
const range=(title:string,rows:number)=>encodeURIComponent(
  `'${title.replaceAll("'","''")}'!A1:L${rows}`);
async function api(token:string,url:string,send:typeof fetch,options:RequestInit={method:'GET'}){
  let response:Response;
  try{response=await send(url,{...options,headers:{Authorization:`Bearer ${token}`,
    ...(options.body?{'Content-Type':'application/json'}:{})},
    cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15_000)});}
  catch{throw Error('SHEET_API_UNAVAILABLE');}
  if(!response.ok)throw Error(response.status===401||response.status===403?
    'SHEET_API_FORBIDDEN':'SHEET_API_UNAVAILABLE');
  return response.json() as Promise<Record<string,unknown>>;
}
const normalized=(rows:unknown):string[][]=>{
  if(!Array.isArray(rows))throw Error('SHEET_PROJECTION_INVALID');
  return rows.map(row=>{
    if(!Array.isArray(row)||row.length>12)throw Error('SHEET_PROJECTION_INVALID');
    return Array.from({length:12},(_,index)=>{
      const cell=row[index]??'';
      if(typeof cell!=='string'||cell.length>512||/^[=+@]/.test(cell)||
        /[\u0000-\u001f]/.test(cell))throw Error('SHEET_PROJECTION_INVALID');
      return cell;
    });
  });
};
const same=(left:string[][],right:string[][])=>JSON.stringify(left)===JSON.stringify(right);

/** Updates only the five registered protected output tabs, then reads them back. */
export async function publishFinanceSheetProjections(binding:FinanceSheetBinding,
  projections:FinanceSheetProjection[],send:typeof fetch=fetch){
  if(!/^[A-Za-z0-9_-]{10,128}$/.test(binding.spreadsheetId)||
    projections.length!==5||projections.some((tab,index)=>
      tab.title!==FINANCE_SHEET_TABS[index+1]||tab.rows.length<1||
      tab.rows.length>5001))throw Error('SHEET_PROJECTION_INVALID');
  const expected=projections.map(tab=>normalized(tab.rows));
  const readToken=await accessToken(binding,false,undefined,send);
  const base=ROOT+binding.spreadsheetId;
  const metadata=await api(readToken,base+
    '?fields=properties(timeZone),sheets(properties(sheetId,title,gridProperties),protectedRanges(range,warningOnly))',
    send);
  if((metadata.properties as {timeZone?:string})?.timeZone!=='Asia/Taipei'||
    !Array.isArray(metadata.sheets))throw Error('SHEET_IDENTITY_MISMATCH');
  const sheets=metadata.sheets as unknown[];
  const output=projections.map(tab=>{
    const sheet=sheets.find(raw=>raw&&typeof raw==='object'&&
      (raw as {properties?:{title?:string}}).properties?.title===tab.title) as
      {properties?:{sheetId?:number;gridProperties?:{rowCount?:number;
        columnCount?:number}};protectedRanges?:{warningOnly?:boolean;
          range?:{sheetId?:number;startRowIndex?:number;endRowIndex?:number;
            startColumnIndex?:number;endColumnIndex?:number}}[]}|undefined;
    const sheetId=sheet?.properties?.sheetId;
    const grid=sheet?.properties?.gridProperties;
    if(!Number.isSafeInteger(sheetId)||!Number.isSafeInteger(grid?.rowCount)||
      grid!.rowCount!<tab.rows.length||grid!.rowCount!>5001||
      !Number.isSafeInteger(grid?.columnCount)||grid!.columnCount!<12||
      !sheet?.protectedRanges?.some(item=>{
        const range=item.range;
        if(!range||item.warningOnly===true)return false;
        return range.sheetId===sheetId&&
          (range.startRowIndex??0)===0&&
          (range.endRowIndex==null||range.endRowIndex>=grid!.rowCount!)&&
          (range.startColumnIndex??0)===0&&
          (range.endColumnIndex==null||range.endColumnIndex>=12);
      }))
      throw Error('SHEET_PROTECTION_MISSING');
    return {title:tab.title,sheetId:sheetId!,rowCount:grid!.rowCount!};
  });
  const read=async()=>Promise.all(output.map(async(tab,index)=>{
    const value=await api(readToken,base+'/values/'+range(tab.title,tab.rowCount)+
      '?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS',send);
    if(value.majorDimension!=='ROWS')throw Error('SHEET_INCOMPLETE_READ');
    const rows=normalized(value.values??[]);
    return {title:tab.title,rows,match:same(rows,expected[index])};
  }));
  const before=await read();
  if(before.every(tab=>tab.match))return {status:'unchanged' as const,
    readback_digest:financeSheetProjectionDigest(before)};
  const writeToken=await accessToken(binding,true,undefined,send);
  const requests=output.flatMap((tab,index)=>[
    {repeatCell:{range:{sheetId:tab.sheetId,startRowIndex:0,
      endRowIndex:tab.rowCount,startColumnIndex:0,endColumnIndex:12},
      cell:{},fields:'userEnteredValue'}},
    {updateCells:{range:{sheetId:tab.sheetId,startRowIndex:0,
      endRowIndex:expected[index].length,startColumnIndex:0,endColumnIndex:12},
      rows:expected[index].map(row=>({values:row.map(value=>({userEnteredValue:{
        stringValue:value}}))})),fields:'userEnteredValue'}},
  ]);
  await api(writeToken,base+':batchUpdate',send,{method:'POST',
    body:JSON.stringify({requests})});
  const after=await read();
  if(!after.every(tab=>tab.match))throw Error('SHEET_WRITE_UNCONFIRMED');
  return {status:'projected' as const,
    readback_digest:financeSheetProjectionDigest(after)};
}
