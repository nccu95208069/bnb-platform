import {financeSheetRequestKey} from './finance-sheet-bulk-core.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RecoveryRow={row_id:string;source_version:number};

/** An unknown Sheet POST is resolved by its original connector-scoped receipt. */
export async function recoverFinanceSheetBatch(spreadsheetId:string,raw:unknown,
  read:(key:string)=>Promise<Record<string,unknown>|null>){
  if(!Array.isArray(raw)||!raw.length||raw.length>10||
    raw.some(row=>!row||typeof row!=='object'||Array.isArray(row)||
      !UUID.test(String(row.row_id))||
      !Number.isSafeInteger(row.source_version)||row.source_version<1||
      row.source_version>1_000_001))throw Error('SHEET_PREVIEW_INVALID');
  const rows=raw as RecoveryRow[];
  if(new Set(rows.map(row=>`${row.row_id}:${row.source_version}`)).size!==rows.length)
    throw Error('SHEET_PREVIEW_INVALID');
  const results=[];
  for(const row of rows){
    const key=financeSheetRequestKey(spreadsheetId,row.row_id,row.source_version);
    try{
      const receipt=await read(key);
      if(!receipt){results.push({...row,request_key:key,status:'not_found'});continue;}
      if(receipt.receipt_status!=='accepted'||receipt.request_key!==key||
        receipt.document_version!==row.source_version||
        typeof receipt.document_id!=='string'||!UUID.test(receipt.document_id)||
        !Array.isArray(receipt.event_ids)||
        receipt.event_ids.some((id:unknown)=>typeof id!=='string'||!UUID.test(id)))
        throw Error('SHEET_READBACK_MISMATCH');
      results.push({...row,request_key:key,status:'accepted',
        document_id:receipt.document_id,version:receipt.document_version,
        event_ids:receipt.event_ids,projection:'pending'});
    }catch{results.push({...row,request_key:key,status:'unknown',
      code:'WRITE_UNCONFIRMED'});}
  }
  return results;
}
