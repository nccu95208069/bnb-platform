import {claimFinanceSheetRow,projectFinanceSheetReceipt,readFinanceSheet}
  from './finance-sheet-bulk-google';
import {financeSheetDocumentsFromLedger,scanFinanceSheet,
  type FinanceSheetIssue} from './finance-sheet-bulk-core';
import {readFinanceSheetLedger,readFinanceSheetLedgerHead}
  from './finance-sheet-bulk-ledger';
import {buildFinanceSheetAudit,financeSheetFullBookIssues,
  persistFinanceSheetAudit} from './finance-sheet-bulk-audit';
import {financeSheetBulkConfig} from './finance-sheet-bulk-config';
import {withFinanceSheetLock} from './finance-sheet-bulk-lock';
import {financeSheetProjections,financeSheetProjectionDigest}
  from './finance-sheet-bulk-projections';
import {publishFinanceSheetProjections} from './finance-sheet-bulk-publisher';

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
    const ledger=await readFinanceSheetLedger(settings.ironGate,settings.scanToken);
    const events=ledger.events;
    const documents=financeSheetDocumentsFromLedger(events,settings.sourceInstanceId,
      settings.binding.spreadsheetId);
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
    const finalValues=await readFinanceSheet(settings.binding);
    const final=scanFinanceSheet(finalValues,settings.binding.propertyDisplay);
    issues.push(...final.issues);
    issues.push(...financeSheetFullBookIssues(final,documents,
      settings.binding.spreadsheetId));
    const projections=financeSheetProjections(events,final,
      settings.binding.propertyDisplay,settings.sourceInstanceId);
    const output=await publishFinanceSheetProjections(settings.binding,projections);
    const projectionDigest=financeSheetProjectionDigest(projections);
    const [readbackValues,observedChangeSeq]=await Promise.all([
      readFinanceSheet(settings.binding),
      readFinanceSheetLedgerHead(settings.ironGate,settings.scanToken)]);
    const audit=buildFinanceSheetAudit({spreadsheetId:settings.binding.spreadsheetId,
      propertyId:settings.ironGate.grant.propertyId,
      sourceInstanceId:settings.sourceInstanceId,values:finalValues,
      readbackValues,events,asOfChangeSeq:ledger.asOfChangeSeq,
      observedChangeSeq,projectionDigest,readbackDigest:output.readback_digest,
      issues});
    const persisted=await persistFinanceSheetAudit(settings.binding.spreadsheetId,audit);
    return {status:audit.status,assigned,projected,
      unassigned:Math.max(0,current.unassigned.length-assigned),
      issue_count:audit.issue_count,issues:issues.slice(0,50).map(issue=>({
        sheet_row:issue.sheet_row,code:issue.code})),
      ledger_events:events.length,output_status:output.status,
      as_of_change_seq:ledger.asOfChangeSeq,
      observed_change_seq:observedChangeSeq,
      projection_digest:projectionDigest,
      reconciliation_issue_codes:audit.issue_codes,
      reconciliation_evidence:{day:persisted.record.day,
        fingerprint:persisted.record.fingerprint,stored:persisted.stored}};
  });
}
