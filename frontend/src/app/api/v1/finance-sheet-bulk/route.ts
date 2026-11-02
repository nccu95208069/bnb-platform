import {NextRequest,NextResponse} from 'next/server';
import {principalFor} from '@/lib/workspace-auth/session';
import {privateHeaders,sameOrigin} from '@/lib/workspace-auth/http';
import {canUseFinance} from '@/lib/finance-store';
import {financeSheetBulkConfig} from '@/lib/finance-sheet-bulk-config';
import {withFinanceSheetLock} from '@/lib/finance-sheet-bulk-lock';
import {claimFinanceSheetRow,projectFinanceSheetReceipt,
  readFinanceSheet} from '@/lib/finance-sheet-bulk-google';
import {financeSheetDocumentsFromLedger,previewFinanceSheetBatch,verifyFinanceSheetIgPreview,
  scanFinanceSheet,verifyFinanceSheetBatch} from '@/lib/finance-sheet-bulk-core';
import {recoverFinanceSheetBatch} from '@/lib/finance-sheet-bulk-recovery';
import {readSweetfunIronGatePaymentOrder} from '@/lib/booking-sources/iron-gate-calendar.server';
import {readSsotLedger,readSsotReceipt,previewSsotFinanceCommand,
  submitSsotFinanceCommand} from '@/lib/booking-sources/iron-gate-ssot-finance.server';
import type {Principal} from '@/lib/workspace-auth/types';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const response=(body:unknown,status=200)=>NextResponse.json(body,
  {status,headers:privateHeaders});
async function inputBody(request:NextRequest):Promise<Record<string,unknown>>{
  const raw=await request.text();
  if(raw.length>65_536)throw Error('SHEET_PREVIEW_INVALID');
  try{
    const input=JSON.parse(raw);
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error();
    return input as Record<string,unknown>;
  }catch{throw Error('SHEET_PREVIEW_INVALID');}
}
const failure=(error:unknown)=>{
  const code=error instanceof Error?error.message:'UNAVAILABLE';
  const allowed=new Set(['UNAUTHORIZED','FORBIDDEN','FINANCE_SHEET_BULK_UNAVAILABLE',
    'SHEET_PREVIEW_INVALID','SHEET_PREVIEW_STALE','SHEET_ROW_CHANGED',
    'SHEET_WRITE_UNCONFIRMED','SHEET_VERSION_CONFLICT','WRITE_UNCONFIRMED']);
  const safe=allowed.has(code)?code:'UNAVAILABLE';
  const status=safe==='UNAUTHORIZED'?401:safe==='FORBIDDEN'?403:
    safe==='FINANCE_SHEET_BULK_UNAVAILABLE'?503:
    safe==='SHEET_PREVIEW_STALE'||safe==='SHEET_VERSION_CONFLICT'?409:
    safe==='UNAVAILABLE'||safe==='WRITE_UNCONFIRMED'||
    safe==='SHEET_WRITE_UNCONFIRMED'?503:400;
  return response({code:safe},status);
};
async function actorFor(request:NextRequest){
  const actor=await principalFor(request);
  if(!actor)throw Error('UNAUTHORIZED');
  if(!canUseFinance(actor)||!actor.viewPrices||
    !(actor.allProperties||actor.propertyIds.includes('sweetfun')))
    throw Error('FORBIDDEN');
  return actor;
}
async function preview(actor:Principal){
  const settings=financeSheetBulkConfig();
  const values=await readFinanceSheet(settings.binding);
  const scan=scanFinanceSheet(values,settings.binding.propertyDisplay);
  const bookingVersions:Record<string,number>={};
  for(const row of scan.rows)if(row.booking_id&&!(row.booking_id in bookingVersions)){
    try{const booking=await readSweetfunIronGatePaymentOrder(row.booking_id,
      actor,settings.ironGate.calendar);
      bookingVersions[row.booking_id]=booking.version;
    }catch{/* An unverified booking remains a per-row review issue. */}
  }
  const ledger=await readSsotLedger(settings.ironGate,actor);
  return {settings,preview:previewFinanceSheetBatch({
    spreadsheetId:settings.binding.spreadsheetId,
    sourceInstanceId:settings.sourceInstanceId,values,
    propertyDisplay:settings.binding.propertyDisplay,
    ledgerEvents:ledger,bookingVersions,secret:settings.secret})};
}
export async function POST(request:NextRequest){
  try{
    sameOrigin(request);
    const actor=await actorFor(request);
    const input=await inputBody(request);
    const action=input.action;
    if(action==='recover'){
      const settings=financeSheetBulkConfig();
      const results=await recoverFinanceSheetBatch(settings.binding.spreadsheetId,
        input.rows,key=>readSsotReceipt(settings.ironGate,actor,key));
      return response({status:'completed',results,issues:[]});
    }
    if(action==='assign'){
      const settings=financeSheetBulkConfig();
      if(!Number.isSafeInteger(input.sheet_row)||
        typeof input.content_hash!=='string')throw Error('SHEET_PREVIEW_INVALID');
      const id=await withFinanceSheetLock(settings.binding.spreadsheetId,()=>
        claimFinanceSheetRow(settings.binding,Number(input.sheet_row),
          input.content_hash as string));
      return response({status:'assigned',row_id:id});
    }
    if(action==='preview'){
      const result=await preview(actor);
      return response({status:'preview',preview_token:result.preview.preview_token,
        workbook_url:`https://docs.google.com/spreadsheets/d/${result.settings.binding.spreadsheetId}/edit`,
        expires_at:result.preview.expires_at,
        rows:result.preview.safe_rows.map(candidate=>({
          row_id:candidate.row.row_id,sheet_row:candidate.row.sheet_row,
          action:candidate.row.action,event_kind:candidate.row.event_kind,
          amount_cents:candidate.row.amount_cents,
          booking_id:candidate.row.booking_id,
          base_version:candidate.row.base_version,
          effective_on:candidate.row.effective_on,
          cash_on:candidate.row.cash_on,
          service_on:candidate.row.service_on,
          category_code:candidate.row.category_code,
          receipt_purpose:candidate.row.receipt_purpose,
          payment_method_code:candidate.row.payment_method_code,
          allocation_start_month:candidate.row.allocation_start_month,
          allocation_months:candidate.row.allocation_months,
          safe_description:candidate.row.safe_description,
          source_version:candidate.source_version,
          content_hash:candidate.row.content_hash})),
        issues:result.preview.issues,unassigned:result.preview.unassigned});
    }
    if(action!=='commit'||typeof input.preview_token!=='string'||
      !Array.isArray(input.row_ids)||!input.row_ids.length||input.row_ids.length>10||
      input.row_ids.some((id:unknown)=>typeof id!=='string'||!UUID.test(id)))
      throw Error('SHEET_PREVIEW_INVALID');
    const registered=financeSheetBulkConfig();
    return await withFinanceSheetLock(registered.binding.spreadsheetId,async()=>{
    const {settings,preview:current}=await preview(actor);
    const selected=verifyFinanceSheetBatch(current,input.preview_token as string,
      settings.secret,input.row_ids as string[]);
    const results=[];
    for(const candidate of selected){
      try{
        const igPreview=await previewSsotFinanceCommand(settings.ironGate,actor,
          candidate.command,candidate.request_key);
        if(igPreview.source_instance_id!==settings.sourceInstanceId||
          igPreview.source_system!=='sheet_bulk'||
          igPreview.source_sheet_ref!==settings.binding.spreadsheetId||
          (candidate.row.booking_id&&!igPreview.command.preview_token))
          throw Error('SOURCE_FORBIDDEN');
        const command=verifyFinanceSheetIgPreview(candidate,igPreview.command);
        const receipt=await submitSsotFinanceCommand(settings.ironGate,actor,
          command,candidate.request_key,fetch,{repreviewOnConflict:false});
        let projection='pending';
        try{
          const events=await readSsotLedger(settings.ironGate,actor);
          const currentDoc=financeSheetDocumentsFromLedger(events,
            settings.sourceInstanceId,settings.binding.spreadsheetId)
            .get(candidate.source_record_id);
          if(!currentDoc||currentDoc.current_version!==candidate.source_version||
            currentDoc.accepted_hash!==candidate.row.content_hash||!currentDoc.event_id)
            throw Error('SHEET_READBACK_MISMATCH');
          await projectFinanceSheetReceipt(settings.binding,candidate.row.row_id,
            candidate.row.content_hash,candidate.source_version,currentDoc.event_id,
            candidate.row.action==='void'?'void':'accepted');
          projection='verified';
        }catch{/* Canonical money receipt is already accepted. Scanner repairs projection. */}
        results.push({row_id:candidate.row.row_id,status:'accepted',projection,
          request_key:candidate.request_key,source_version:candidate.source_version,
          document_id:receipt.document_id,
          version:receipt.document_version,event_ids:receipt.event_ids,
          as_of_event_id:receipt.as_of_event_id});
      }catch(error){
        const code=error instanceof Error?error.message:'UNAVAILABLE';
        results.push({row_id:candidate.row.row_id,status:
          ['WRITE_UNCONFIRMED','FINANCE_SSOT_READBACK_MISMATCH'].includes(code)?
          'unknown':'rejected',code:/^[A-Z_]+$/.test(code)?code:'UNAVAILABLE',
          request_key:candidate.request_key,source_version:candidate.source_version});
      }
    }
    return response({status:'completed',results,
      issues:current.issues,unassigned:current.unassigned});
    });
  }catch(error){return failure(error);}
}
