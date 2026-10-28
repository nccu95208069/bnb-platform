import {createHash,randomUUID} from 'node:crypto';
import {redisCommand} from './workspace-auth/store.ts';
import type {FinanceSheetDocument,FinanceSheetIssue,FinanceSheetScan}
  from './finance-sheet-bulk-core';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9_-]{10,128}$/;
const SHA=/^[0-9a-f]{64}$/;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const workbookHash=(spreadsheetId:string)=>createHash('sha256')
  .update(spreadsheetId).digest('hex');

export function taipeiAuditDay(now:Date){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Taipei',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  return `${parts.find(part=>part.type==='year')?.value}-${
    parts.find(part=>part.type==='month')?.value}-${
    parts.find(part=>part.type==='day')?.value}`;
}

/** Compare every input identity with its exact canonical document revision. */
export function financeSheetFullBookIssues(scan:FinanceSheetScan,
  documents:Map<string,FinanceSheetDocument>,spreadsheetId:string):FinanceSheetIssue[]{
  if(!ID.test(spreadsheetId))throw Error('SHEET_AUDIT_INVALID');
  const issues:FinanceSheetIssue[]=[];
  const listed=new Set<string>();
  for(const row of scan.rows){
    const source=`sheet:${spreadsheetId}:${row.row_id}`;
    listed.add(source);
    const document=documents.get(source);
    if(!document){
      issues.push({sheet_row:row.sheet_row,row_id:row.row_id,
        code:row.base_version||row.accepted_hash||row.event_id?
          'SHEET_LEDGER_ROW_MISMATCH':'SHEET_PENDING_ROW'});
      continue;
    }
    if(row.base_version!==document.current_version||
      row.accepted_hash!==document.accepted_hash||
      row.event_id!==document.event_id||
      row.sync_status!==(document.status==='void'?'void':'accepted')||
      row.content_hash!==document.accepted_hash)
      issues.push({sheet_row:row.sheet_row,row_id:row.row_id,
        code:'SHEET_LEDGER_ROW_MISMATCH'});
  }
  for(const source of documents.keys())if(!listed.has(source))
    issues.push({sheet_row:0,row_id:source.split(':').at(-1)??null,
      code:'SHEET_MISSING_ACCEPTED_ROW'});
  for(const row of scan.unassigned)issues.push({sheet_row:row.sheet_row,row_id:null,
    code:'SHEET_IDENTITY_PENDING'});
  return issues;
}

export type FinanceSheetAudit={schema:1;run_id:string;day:string;checked_at:string;
  property_id:string;source_instance_id:string;workbook_sha256:string;
  status:'ok'|'review';as_of_change_seq:number;observed_change_seq:number;
  input_digest:string;input_readback_digest:string;ledger_digest:string;projection_digest:string;
  readback_digest:string;input_rows:number;ledger_events:number;
  issue_count:number;issue_codes:Record<string,number>;fingerprint:string};

export function buildFinanceSheetAudit(input:{spreadsheetId:string;propertyId:string;
  sourceInstanceId:string;values:unknown[][];readbackValues:unknown[][];
  events:Record<string,unknown>[];
  asOfChangeSeq:number;observedChangeSeq:number;projectionDigest:string;
  readbackDigest:string;issues:FinanceSheetIssue[];now?:Date}):FinanceSheetAudit{
  if(!ID.test(input.spreadsheetId)||!UUID.test(input.propertyId)||
    !UUID.test(input.sourceInstanceId)||!Array.isArray(input.values)||
    !Array.isArray(input.readbackValues)||
    !Array.isArray(input.events)||!Number.isSafeInteger(input.asOfChangeSeq)||
    input.asOfChangeSeq<0||!Number.isSafeInteger(input.observedChangeSeq)||
    input.observedChangeSeq<input.asOfChangeSeq||
    !SHA.test(input.projectionDigest)||!SHA.test(input.readbackDigest)||
    !Array.isArray(input.issues))throw Error('SHEET_AUDIT_INVALID');
  const issueCodes:Record<string,number>={};
  for(const issue of input.issues){
    if(!/^SHEET_[A-Z_]+$/.test(issue.code))throw Error('SHEET_AUDIT_INVALID');
    issueCodes[issue.code]=(issueCodes[issue.code]??0)+1;
  }
  if(input.observedChangeSeq!==input.asOfChangeSeq)
    issueCodes.SHEET_LEDGER_MOVED=(issueCodes.SHEET_LEDGER_MOVED??0)+1;
  if(input.projectionDigest!==input.readbackDigest)
    issueCodes.SHEET_PROJECTION_READBACK_MISMATCH=
      (issueCodes.SHEET_PROJECTION_READBACK_MISMATCH??0)+1;
  const inputDigest=hash(input.values),inputReadbackDigest=hash(input.readbackValues);
  if(inputDigest!==inputReadbackDigest)
    issueCodes.SHEET_INPUT_MOVED=(issueCodes.SHEET_INPUT_MOVED??0)+1;
  const orderedIssueCodes=Object.fromEntries(Object.entries(issueCodes)
    .sort(([left],[right])=>left.localeCompare(right)));
  const now=input.now??new Date();
  const data={schema:1 as const,day:taipeiAuditDay(now),
    property_id:input.propertyId,source_instance_id:input.sourceInstanceId,
    workbook_sha256:workbookHash(input.spreadsheetId),
    status:Object.keys(orderedIssueCodes).length?'review' as const:'ok' as const,
    as_of_change_seq:input.asOfChangeSeq,observed_change_seq:input.observedChangeSeq,
    input_digest:inputDigest,input_readback_digest:inputReadbackDigest,
    ledger_digest:hash(input.events),
    projection_digest:input.projectionDigest,readback_digest:input.readbackDigest,
    input_rows:Math.max(0,input.values.length-1),ledger_events:input.events.length,
    issue_count:Object.values(orderedIssueCodes).reduce((total,count)=>total+count,0),
    issue_codes:orderedIssueCodes};
  return {...data,run_id:randomUUID(),checked_at:now.toISOString(),
    fingerprint:hash(data)};
}

export type AuditCommand=(command:(string|number)[])=>Promise<unknown>;
const APPEND=`local old=redis.call('GET',KEYS[1]);
if old then local decoded=cjson.decode(old);
  if decoded.fingerprint==ARGV[1] then return 0 end end;
redis.call('RPUSH',KEYS[2],ARGV[2]);
redis.call('SET',KEYS[1],ARGV[2]); return 1`;

/** Retain one private evidence record per distinct daily state, without expiry. */
export async function persistFinanceSheetAudit(spreadsheetId:string,
  audit:FinanceSheetAudit,command:AuditCommand=redisCommand){
  if(!ID.test(spreadsheetId)||audit.workbook_sha256!==workbookHash(spreadsheetId)||
    !/^\d{4}-\d{2}-\d{2}$/.test(audit.day)||!UUID.test(audit.run_id)||
    !SHA.test(audit.fingerprint))throw Error('SHEET_AUDIT_INVALID');
  const namespace=process.env.CUSTOMER_WORKSPACE_NAMESPACE||'bnb:customers:v1';
  const prefix=`${namespace}:finance:sheet-bulk:${audit.property_id}:`+
    `${audit.workbook_sha256}:audit:${audit.day}`;
  const latest=`${prefix}:latest`,history=`${prefix}:history`;
  const encoded=JSON.stringify(audit);
  const result=await command(['EVAL',APPEND,2,latest,history,audit.fingerprint,encoded]);
  if(result!==0&&result!==1)throw Error('SHEET_AUDIT_UNAVAILABLE');
  const raw=await command(['GET',latest]);
  const tail=await command(['LINDEX',history,-1]);
  if(typeof raw!=='string'||raw!==tail)throw Error('SHEET_AUDIT_UNCONFIRMED');
  let readback:FinanceSheetAudit;
  try{readback=JSON.parse(raw) as FinanceSheetAudit;}
  catch{throw Error('SHEET_AUDIT_UNCONFIRMED');}
  if(readback.fingerprint!==audit.fingerprint||readback.day!==audit.day||
    readback.workbook_sha256!==audit.workbook_sha256)
    throw Error('SHEET_AUDIT_UNCONFIRMED');
  return {stored:result===1,record:readback};
}
