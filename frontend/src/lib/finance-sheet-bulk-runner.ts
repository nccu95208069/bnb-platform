import {claimFinanceSheetRow,projectFinanceSheetReceipt,readFinanceSheet}
  from './finance-sheet-bulk-google';
import {financeSheetDocumentsFromLedger,scanFinanceSheet,
  type FinanceSheetIssue} from './finance-sheet-bulk-core';
import {readFinanceSheetLedger} from './finance-sheet-bulk-ledger';
import {financeSheetBulkConfig} from './finance-sheet-bulk-config';
import {withFinanceSheetLock} from './finance-sheet-bulk-lock';

/** Scheduled reconciliation never submits a money command. */
export async function runFinanceSheetBulkScan(){
  const settings=financeSheetBulkConfig();
  return withFinanceSheetLock(settings.binding.spreadsheetId,async()=>{
    const initial=scanFinanceSheet(await readFinanceSheet(settings.binding),
      settings.binding.propertyDisplay);
    const issues:FinanceSheetIssue[]=[...initial.issues];
    let assigned=0,projected=0;
    for(const candidate of initial.unassigned.slice(0,10)){
      try{await claimFinanceSheetRow(settings.binding,candidate.sheet_row,
        candidate.content_hash);assigned++;}
      catch{issues.push({sheet_row:candidate.sheet_row,row_id:null,
        code:'SHEET_IDENTITY_REVIEW_REQUIRED'});}
    }
    const current=scanFinanceSheet(await readFinanceSheet(settings.binding),
      settings.binding.propertyDisplay);
    issues.push(...current.issues);
    const events=await readFinanceSheetLedger(settings.ironGate,settings.scanToken);
    const documents=financeSheetDocumentsFromLedger(events,settings.sourceInstanceId,
      settings.binding.spreadsheetId);
    const listed=new Set(current.rows.map(row=>
      `sheet:${settings.binding.spreadsheetId}:${row.row_id}`));
    for(const source of documents.keys()){
      if(!listed.has(source))issues.push({sheet_row:0,row_id:source.split(':').at(-1)??null,
        code:'SHEET_MISSING_ACCEPTED_ROW'});
    }
    for(const row of current.rows){
      const document=documents.get(`sheet:${settings.binding.spreadsheetId}:${row.row_id}`);
      if(!document)continue;
      if(row.base_version===document.current_version&&
        row.accepted_hash===document.accepted_hash&&
        row.event_id===document.event_id&&row.sync_status===
          (row.content_hash===document.accepted_hash?
            document.status==='void'?'void':'accepted':
            document.status==='void'?'void_review':'pending_revision'))continue;
      if(![row.base_version,row.base_version+1].includes(document.current_version)||
        !document.accepted_hash||
        !document.event_id){issues.push({sheet_row:row.sheet_row,row_id:row.row_id,
          code:'SHEET_PROJECTION_GAP'});continue;}
      try{await projectFinanceSheetReceipt(settings.binding,row.row_id,
        document.accepted_hash,document.current_version,document.event_id,
        document.status==='void'?'void':'accepted');projected++;}
      catch{issues.push({sheet_row:row.sheet_row,row_id:row.row_id,
        code:'SHEET_PROJECTION_RETRY'});}
    }
    return {status:issues.length?'review':'ok',assigned,projected,
      unassigned:Math.max(0,current.unassigned.length-assigned),
      issues:issues.map(issue=>({sheet_row:issue.sheet_row,code:issue.code})),
      ledger_events:events.length};
  });
}
