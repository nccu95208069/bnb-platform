import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

// The input tab is the sole import source. Columns A/B/Q/S/T are protected by
// Google Sheets permissions; server-side checks still treat them as untrusted.
export const FINANCE_SHEET_INPUT_TAB='批次輸入';
export const FINANCE_SHEET_HEADERS=[
  'row_id','base_version','action','event_kind','amount_twd','effective_on',
  'cash_on','service_on','booking_id','category_code','receipt_purpose',
  'payment_method_code','allocation_start_month','allocation_months',
  'safe_description','property_display','sync_status','error_code',
  'accepted_hash','event_id',
] as const;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const CODE=/^[a-z][a-z0-9_]{0,63}$/;
const METHODS=new Set(['cash','bank_transfer','credit_card','other']);
const KINDS=new Set(['property_receipt','expense_paid']);
const PURPOSES=new Set(['room','deposit','extra','other']);
const ACTIONS=new Set(['create','amend','void']);
const MAX_ROWS=5000;

type Action='create'|'amend'|'void';
type Kind='property_receipt'|'expense_paid';
export type FinanceSheetRow={
  sheet_row:number;row_id:string;base_version:number;action:Action;
  event_kind:Kind;amount_cents:number;effective_on:string;cash_on:string;
  service_on:string|null;booking_id:string|null;category_code:string|null;
  receipt_purpose:string|null;payment_method_code:string;
  allocation_start_month:string|null;allocation_months:number|null;
  safe_description:string|null;property_display:string;sync_status:string;
  error_code:string;accepted_hash:string|null;event_id:string|null;
  content_hash:string;
};
export type FinanceSheetIssue={sheet_row:number;row_id:string|null;code:string};
export type FinanceSheetScan={rows:FinanceSheetRow[];issues:FinanceSheetIssue[];
  unassigned:{sheet_row:number;content_hash:string}[]};
export type FinanceSheetDocument={source_record_id:string;current_version:number;
  status:'active'|'void';accepted_hash:string|null;event_id:string|null};
export type FinanceSheetCandidate={row:FinanceSheetRow;source_record_id:string;
  source_version:number;request_key:string;command:Record<string,unknown>};
export type FinanceSheetPreview={spreadsheet_id:string;source_instance_id:string;
  ledger_digest:string;expires_at:number;safe_rows:FinanceSheetCandidate[];
  issues:FinanceSheetIssue[];unassigned:FinanceSheetScan['unassigned'];
  preview_token:string};

const cell=(row:unknown[],index:number):string=>{
  const value=row[index];
  if(value==null)return '';
  if(typeof value!=='string'&&typeof value!=='number')throw Error('SHEET_CELL_INVALID');
  const text=String(value).trim();
  if(text.length>500||/^[=+@]/.test(text))throw Error('SHEET_CELL_INVALID');
  return text;
};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validDay=(value:string)=>DATE.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))&&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const readDay=(value:string,optional=false)=>{
  if(optional&&!value)return null;
  if(!validDay(value))throw Error('SHEET_DATE_INVALID');
  return value;
};
const integer=(value:string,min:number,max:number)=>{
  if(!/^(0|[1-9][0-9]*)$/.test(value))throw Error('SHEET_AMOUNT_INVALID');
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<min||number>max)throw Error('SHEET_AMOUNT_INVALID');
  return number;
};
function shiftMonth(month:string,index:number){
  const date=new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth()+index);
  return date.toISOString().slice(0,7)+'-01';
}
function sanitized(row:unknown[],sheet_row:number,propertyDisplay:string):FinanceSheetRow{
  const values=FINANCE_SHEET_HEADERS.map((_,index)=>cell(row,index));
  const [rowId,base,action,kind,twd,effective,cash,service,booking,category,purpose,
    method,start,months,description,display,status,error,accepted,eventId]=values;
  if(!UUID.test(rowId)||!ACTIONS.has(action)||!KINDS.has(kind)||
    !METHODS.has(method)||display!==propertyDisplay||
    description.length>500||/(?:\d[ -]?){13,19}|@|\+?\d{9,}/.test(description)||
    status.length>64||error.length>64||
    accepted&&!/^[0-9a-f]{64}$/.test(accepted)||eventId&&!UUID.test(eventId))
    throw Error('SHEET_ROW_INVALID');
  const amount=integer(twd,1,10_000_000_000)*100;
  const version=integer(base||'0',0,1_000_000);
  const effectiveOn=readDay(effective)!;
  const cashOn=readDay(cash)!;
  const serviceOn=readDay(service,true);
  const bookingId=booking||null;
  if(bookingId&&!UUID.test(bookingId))throw Error('SHEET_BOOKING_INVALID');
  const receiptPurpose=purpose||null,categoryCode=category||null;
  if(kind==='property_receipt'&&(!PURPOSES.has(receiptPurpose??'')||categoryCode||
    (receiptPurpose!=='other'&&!bookingId)||
    (receiptPurpose==='other'&&bookingId)||start||months)||
    kind==='expense_paid'&&(!categoryCode||!CODE.test(categoryCode)||purpose||
      !start||!/^\d{4}-\d{2}$/.test(start)||!validDay(start+'-01')||
      !months||integer(months,1,120)<1))
    throw Error('SHEET_ROW_INVALID');
  const monthCount=kind==='expense_paid'?integer(months,1,120):null;
  if(monthCount&&shiftMonth(start,monthCount-1).slice(0,4)>'2100')
    throw Error('SHEET_DATE_INVALID');
  const payload={kind,amount,effectiveOn,cashOn,serviceOn,bookingId,
    categoryCode,receiptPurpose,method,start:start||null,monthCount,
    description:description||null};
  return {sheet_row,row_id:rowId,base_version:version,action:action as Action,
    event_kind:kind as Kind,amount_cents:amount,effective_on:effectiveOn,cash_on:cashOn,
    service_on:serviceOn,booking_id:bookingId,category_code:categoryCode,
    receipt_purpose:receiptPurpose,payment_method_code:method,
    allocation_start_month:start||null,allocation_months:monthCount,
    safe_description:description||null,property_display:display,sync_status:status,
    error_code:error,accepted_hash:accepted||null,event_id:eventId||null,
    content_hash:digest(payload)};
}

export function scanFinanceSheet(values:unknown[][],propertyDisplay:string):FinanceSheetScan{
  if(!Array.isArray(values)||values.length<1||values.length>MAX_ROWS+1||
    !Array.isArray(values[0])||values[0].length!==FINANCE_SHEET_HEADERS.length||
    FINANCE_SHEET_HEADERS.some((name,index)=>values[0][index]!==name))
    throw Error('SHEET_SCHEMA_MISMATCH');
  const rows:FinanceSheetRow[]=[],issues:FinanceSheetIssue[]=[],unassigned:FinanceSheetScan['unassigned']=[];
  const seen=new Set<string>();
  for(let index=1;index<values.length;index++){
    const raw=values[index];
    if(!Array.isArray(raw)){issues.push({sheet_row:index+1,row_id:null,code:'SHEET_ROW_INVALID'});continue;}
    // Templates may prefill action, kind, method and property display down
    // blank rows; none of those defaults may create an import identity.
    const business=[4,5,6,7,8,9,12,13,14].some(column=>
      raw[column]!=null&&String(raw[column]).trim());
    if(!business){
      if([0,1,16,17,18,19].some(column=>
        raw[column]!=null&&String(raw[column]).trim()))
        issues.push({sheet_row:index+1,row_id:null,code:'SHEET_ORPHANED_IDENTITY'});
      continue;
    }
    const rowId=typeof raw[0]==='string'?raw[0].trim():'';
    if(!rowId){
      if(raw[1]||raw[16]||raw[17]||raw[18]||raw[19])
        issues.push({sheet_row:index+1,row_id:null,code:'SHEET_IDENTITY_OVERWRITTEN'});
      else unassigned.push({sheet_row:index+1,content_hash:digest(raw.slice(2,16))});
      continue;
    }
    if(!UUID.test(rowId)||seen.has(rowId)){
      issues.push({sheet_row:index+1,row_id:rowId,code:seen.has(rowId)?
        'SHEET_DUPLICATE_ROW_ID':'SHEET_ROW_ID_INVALID'});continue;
    }
    seen.add(rowId);
    try{rows.push(sanitized(raw,index+1,propertyDisplay));}
    catch(error){issues.push({sheet_row:index+1,row_id:rowId,
      code:error instanceof Error&&/^SHEET_[A-Z_]+$/.test(error.message)?
        error.message:'SHEET_ROW_INVALID'});}
  }
  return {rows,issues,unassigned};
}

export function financeSheetRequestKey(spreadsheetId:string,rowId:string,version:number){
  if(!/^[A-Za-z0-9_-]{10,128}$/.test(spreadsheetId)||!UUID.test(rowId)||
    !Number.isSafeInteger(version)||version<1)throw Error('SHEET_IDENTITY_INVALID');
  const hex=digest(['finance-sheet-v1',spreadsheetId,rowId,version]);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export function financeSheetDocumentsFromLedger(events:unknown[],sourceInstanceId:string,
  spreadsheetId:string){
  if(!UUID.test(sourceInstanceId)||!Array.isArray(events)||
    !/^[A-Za-z0-9_-]{10,128}$/.test(spreadsheetId))throw Error('SHEET_LEDGER_INVALID');
  const records=new Map<string,FinanceSheetDocument&{revision:number}>();
  const seen=new Set<string>();
  for(const raw of events){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('SHEET_LEDGER_INVALID');
    const event=raw as Record<string,unknown>;
    if(typeof event.id!=='string'||!UUID.test(event.id)||seen.has(event.id))
      throw Error('SHEET_LEDGER_INVALID');
    seen.add(event.id);
    if(event.source_instance_id!==sourceInstanceId)continue;
    if(event.source_system!=='sheet_bulk'||typeof event.source_record_id!=='string'||
      !/^sheet:[A-Za-z0-9_-]{10,128}:[0-9a-f-]{36}$/i.test(event.source_record_id)||
      !event.source_record_id.startsWith(`sheet:${spreadsheetId}:`)||
      !['active','void'].includes(String(event.document_status))||
      !Number.isSafeInteger(Number(event.current_version))||
      !Number.isSafeInteger(Number(event.revision_version)))
      throw Error('SHEET_LEDGER_INVALID');
    if(event.event_kind==='reversal')continue;
    const evidence=event.evidence_ref;
    if(typeof evidence!=='string'||!/^sheet:[0-9a-f]{64}$/.test(evidence))
      throw Error('SHEET_LEDGER_INVALID');
    const previous=records.get(event.source_record_id);
    const revision=Number(event.revision_version);
    if(previous&&previous.revision===revision)throw Error('SHEET_LEDGER_INVALID');
    if(!previous||revision>previous.revision)
      records.set(event.source_record_id,{source_record_id:event.source_record_id,
        current_version:Number(event.current_version),
        status:event.document_status as 'active'|'void',
        accepted_hash:evidence.slice(6),event_id:event.id,revision});
  }
  return new Map([...records].map(([key,value])=>[key,{
    source_record_id:value.source_record_id,current_version:value.current_version,
    status:value.status,accepted_hash:value.accepted_hash,event_id:value.event_id,
  }]));
}

export function planFinanceSheetRow(row:FinanceSheetRow,document:FinanceSheetDocument|null,
  spreadsheetId:string,bookingVersion:number|null):FinanceSheetCandidate|null{
  const sourceRecord=`sheet:${spreadsheetId}:${row.row_id}`;
  if(document&&document.status==='void'&&
    document.source_record_id===sourceRecord&&
    document.current_version===row.base_version&&row.action==='void'&&
    document.accepted_hash===row.accepted_hash&&
    document.event_id===row.event_id)return null;
  if(document&&(document.source_record_id!==sourceRecord||
    document.current_version!==row.base_version||document.status!=='active'||
    document.accepted_hash!==row.accepted_hash||document.event_id!==row.event_id))
    throw Error('SHEET_VERSION_CONFLICT');
  if(!document&&(row.base_version!==0||row.accepted_hash||row.event_id||
    row.action!=='create'))
    throw Error('SHEET_VERSION_CONFLICT');
  if(document&&row.action==='create'&&row.content_hash===row.accepted_hash)return null;
  if(document&&row.action==='create')throw Error('SHEET_VERSION_CONFLICT');
  if(document&&row.action==='amend'&&row.content_hash===row.accepted_hash)return null;
  const sourceVersion=row.base_version+1;
  const requestKey=financeSheetRequestKey(spreadsheetId,row.row_id,sourceVersion);
  const base:Record<string,unknown>={request_key:requestKey,
    source_record_id:sourceRecord,source_version:String(sourceVersion),action:row.action,
    ...(document?{expected_version:row.base_version}:{}),
    ...(document?{reason_code:'sheet_operator_revision'}:{})};
  if(row.booking_id&&(!Number.isSafeInteger(bookingVersion)||Number(bookingVersion)<1))
    throw Error('SHEET_BOOKING_REVIEW_REQUIRED');
  if(row.action==='void'){
    if(!document||row.content_hash!==row.accepted_hash)
      throw Error('SHEET_VERSION_CONFLICT');
    if(row.booking_id)base.booking_guards=[{booking_id:row.booking_id,
      expected_booking_version:bookingVersion}];
    return {row,source_record_id:sourceRecord,source_version:sourceVersion,
      request_key:requestKey,command:base};
  }
  const command:Record<string,unknown>={...base,event_kind:row.event_kind,
    amount_cents:row.amount_cents,currency:'TWD',effective_on:row.effective_on,
    cash_on:row.cash_on,service_on:row.service_on,
    payment_method_code:row.payment_method_code,
    safe_description:row.safe_description,evidence_level:'operator_attested',
    evidence_ref:`sheet:${row.content_hash}`};
  if(row.event_kind==='expense_paid'){
    const count=row.allocation_months!,total=row.amount_cents;
    const floor=Math.floor(total/count),extra=total%count;
    command.category_code=row.category_code;
    command.expense_attributions=Array.from({length:count},(_,index)=>({
      month:shiftMonth(row.allocation_start_month!,index),
      amount_cents:floor+(index<extra?1:0),allocation_policy:'ig_v1_earliest_cent'}));
    command.booking_allocations=row.booking_id?[{booking_id:row.booking_id,
      expected_booking_version:bookingVersion,amount_cents:row.amount_cents,
      allocation_kind:'expense'}]:[];
  }else{
    command.receipt_purpose=row.receipt_purpose;
    command.booking_allocations=row.booking_id?[{booking_id:row.booking_id,
      expected_booking_version:bookingVersion,amount_cents:row.amount_cents,
      allocation_kind:row.receipt_purpose}]:[];
  }
  return {row,source_record_id:sourceRecord,source_version:sourceVersion,
    request_key:requestKey,command};
}

const snapshot=(preview:Omit<FinanceSheetPreview,'preview_token'|'safe_rows'> &
  {safe_rows:FinanceSheetCandidate[]})=>({
    spreadsheet_id:preview.spreadsheet_id,source_instance_id:preview.source_instance_id,
    ledger_digest:preview.ledger_digest,expires_at:preview.expires_at,
    rows:preview.safe_rows.map(candidate=>({row_id:candidate.row.row_id,
      base_version:candidate.row.base_version,content_hash:candidate.row.content_hash,
      source_version:candidate.source_version,request_key:candidate.request_key,
      command_hash:digest(candidate.command)})),
});

export function previewFinanceSheetBatch(options:{spreadsheetId:string;
  sourceInstanceId:string;values:unknown[][];propertyDisplay:string;
  ledgerEvents:unknown[];bookingVersions:Record<string,number>;
  secret:string;now?:number}):FinanceSheetPreview{
  if(!/^[A-Za-z0-9_-]{10,128}$/.test(options.spreadsheetId)||
    !UUID.test(options.sourceInstanceId)||typeof options.secret!=='string'||
    options.secret.length<32)throw Error('SHEET_CONFIG_INVALID');
  const scan=scanFinanceSheet(options.values,options.propertyDisplay);
  const documents=financeSheetDocumentsFromLedger(options.ledgerEvents,
    options.sourceInstanceId,options.spreadsheetId);
  const seen=new Set(scan.rows.map(row=>`sheet:${options.spreadsheetId}:${row.row_id}`));
  const issues=[...scan.issues];
  for(const source of documents.keys())if(!seen.has(source))
    issues.push({sheet_row:0,row_id:source.split(':').at(-1)??null,
      code:'SHEET_MISSING_ACCEPTED_ROW'});
  const safe:FinanceSheetCandidate[]=[];
  for(const row of scan.rows){
    try{
      const candidate=planFinanceSheetRow(row,
        documents.get(`sheet:${options.spreadsheetId}:${row.row_id}`)??null,
        options.spreadsheetId,row.booking_id?options.bookingVersions[row.booking_id]??null:null);
      if(candidate){
        if(safe.length<50)safe.push(candidate);
        else issues.push({sheet_row:row.sheet_row,row_id:row.row_id,
          code:'SHEET_BATCH_PAGE_LIMIT'});
      }
    }catch(error){issues.push({sheet_row:row.sheet_row,row_id:row.row_id,
      code:error instanceof Error&&/^SHEET_[A-Z_]+$/.test(error.message)?
        error.message:'SHEET_ROW_INVALID'});}
  }
  const ledgerDigest=digest([...documents.values()].sort((a,b)=>
    a.source_record_id.localeCompare(b.source_record_id)));
  const body={spreadsheet_id:options.spreadsheetId,
    source_instance_id:options.sourceInstanceId,ledger_digest:ledgerDigest,
    expires_at:(options.now??Date.now())+15*60_000,safe_rows:safe,
    issues,unassigned:scan.unassigned};
  const message=Buffer.from(JSON.stringify(snapshot(body))).toString('base64url');
  const mac=createHmac('sha256',options.secret).update(message).digest('base64url');
  return {...body,preview_token:`${message}.${mac}`};
}

export function verifyFinanceSheetBatch(preview:FinanceSheetPreview,token:string,
  secret:string,selectedRowIds:string[],now=Date.now()){
  if(typeof token!=='string'||token.length>32_768||typeof secret!=='string'||
    secret.length<32||secret.length>4096||!Array.isArray(selectedRowIds)||
    selectedRowIds.some(id=>!UUID.test(id))||
    new Set(selectedRowIds).size!==selectedRowIds.length)
    throw Error('SHEET_PREVIEW_INVALID');
  const match=/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if(!match)throw Error('SHEET_PREVIEW_INVALID');
  const expected=createHmac('sha256',secret).update(match[1]).digest();
  const actual=Buffer.from(match[2],'base64url');
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))
    throw Error('SHEET_PREVIEW_STALE');
  let signed:Record<string,unknown>;
  try{signed=JSON.parse(Buffer.from(match[1],'base64url').toString('utf8'));}
  catch{throw Error('SHEET_PREVIEW_INVALID');}
  const expires=signed?.expires_at;
  if(!Number.isSafeInteger(expires)||Number(expires)<now||
    Number(expires)>now+15*60_000||
    match[1]!==Buffer.from(JSON.stringify(snapshot({
      ...preview,expires_at:Number(expires)}))).toString('base64url')||
    selectedRowIds.some(id=>!preview.safe_rows.some(candidate=>candidate.row.row_id===id)))
    throw Error('SHEET_PREVIEW_STALE');
  return selectedRowIds.map(id=>preview.safe_rows.find(candidate=>candidate.row.row_id===id)!);
}

/** A fresh Iron Gate token may not silently approve a newer booking version. */
export function verifyFinanceSheetIgPreview(candidate:FinanceSheetCandidate,
  resolved:Record<string,unknown>){
  for(const field of ['request_key','source_record_id','source_version','action',
    'event_kind','amount_cents'] as const){
    if(field in candidate.command&&resolved[field]!==candidate.command[field])
      throw Error('SHEET_PREVIEW_STALE');
  }
  for(const field of ['booking_allocations','booking_guards'] as const){
    const approved=candidate.command[field];
    if(approved==null)continue;
    const received=resolved[field];
    if(!Array.isArray(approved)||!Array.isArray(received)||
      approved.length!==received.length)throw Error('SHEET_PREVIEW_STALE');
    for(let index=0;index<approved.length;index++){
      const left=approved[index],right=received[index];
      if(!left||!right||typeof left!=='object'||typeof right!=='object'||
        ['booking_id','expected_booking_version','amount_cents','allocation_kind']
          .some(key=>key in left&&left[key]!==right[key]))
        throw Error('SHEET_PREVIEW_STALE');
    }
  }
  return resolved;
}
