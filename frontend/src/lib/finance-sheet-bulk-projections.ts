import {createHash} from 'node:crypto';
import {FINANCE_SHEET_TABS} from './finance-sheet-bulk-template.ts';
import type {FinanceSheetScan} from './finance-sheet-bulk-core';

export type FinanceSheetProjection={title:string;rows:string[][]};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeAmount=(value:unknown)=>{
  const parsed=Number(value);
  if((typeof value!=='number'&&typeof value!=='string')||
    !Number.isSafeInteger(parsed)||String(parsed)!==String(value))
    throw Error('SHEET_LEDGER_INVALID');
  return parsed;
};
const safeText=(value:unknown,max=128)=>{
  if(value==null)return '';
  if(typeof value!=='string'||value.length>max||/[\r\n\t\u0000-\u001f]/.test(value)||
    /^[=+@]/.test(value))throw Error('SHEET_LEDGER_INVALID');
  return value;
};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const add=(state:Record<string,number>,key:string,amount:number)=>{
  const next=(state[key]??0)+amount;
  if(!Number.isSafeInteger(next))throw Error('SHEET_LEDGER_INVALID');
  state[key]=next;
};

export function financeSheetProjections(events:unknown[],scan:FinanceSheetScan,
  propertyDisplay:string,sourceInstanceId:string):FinanceSheetProjection[]{
  if(!Array.isArray(events)||!UUID.test(sourceInstanceId)||
    !propertyDisplay||propertyDisplay.length>80)throw Error('SHEET_LEDGER_INVALID');
  const bookings=new Map<string,Record<string,number>>();
  const eventRows:string[][]=[];const costRows:string[][]=[];const syncRows:string[][]=[];
  const seen=new Set<string>();
  for(const raw of events){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('SHEET_LEDGER_INVALID');
    const event=raw as Record<string,unknown>;
    const id=safeText(event.id,36),kind=safeText(event.event_kind,64);
    if(!UUID.test(id)||seen.has(id)||!UUID.test(safeText(event.document_id,36)))
      throw Error('SHEET_LEDGER_INVALID');
    seen.add(id);
    const amount=safeAmount(event.amount_cents),effect=safeAmount(event.cash_effect_cents);
    const allocations=event.booking_allocations;
    const attributions=event.expense_attributions;
    if(!Array.isArray(allocations)||!Array.isArray(attributions))
      throw Error('SHEET_LEDGER_INVALID');
    const actualKind=kind==='reversal'?safeText(event.reversed_kind,64):kind;
    const source=safeText(event.source_system,64);
    const effective=safeText(event.effective_on,10),cash=safeText(event.cash_on,10);
    const evidence=safeText(event.evidence_level,32);
    const documentId=safeText(event.document_id,36);
    eventRows.push([propertyDisplay,id,documentId,kind,actualKind,String(amount),
      String(effect),effective,cash,source,evidence,
      String(safeAmount(event.revision_version))]);
    for(const rawAllocation of allocations){
      if(!rawAllocation||typeof rawAllocation!=='object'||Array.isArray(rawAllocation))
        throw Error('SHEET_LEDGER_INVALID');
      const allocation=rawAllocation as Record<string,unknown>;
      const bookingId=safeText(allocation.booking_id,36);
      if(!UUID.test(bookingId))throw Error('SHEET_LEDGER_INVALID');
      const cents=safeAmount(allocation.amount_cents);
      const bucket=bookings.get(bookingId)??{};
      const field=actualKind==='property_receipt'?'receipt':
        actualKind==='property_refund'?'refund':
        actualKind==='ota_guest_payment_observed'?'ota_observed':
        actualKind==='ota_payout'?'ota_payout':
        ['expense_paid','processor_fee_paid'].includes(actualKind)?'expense':null;
      if(field)add(bucket,field,cents);
      bookings.set(bookingId,bucket);
    }
    if(['expense_paid','processor_fee_paid'].includes(actualKind)){
      for(const rawAttribution of attributions){
        if(!rawAttribution||typeof rawAttribution!=='object'||
          Array.isArray(rawAttribution))throw Error('SHEET_LEDGER_INVALID');
        const attribution=rawAttribution as Record<string,unknown>;
        const month=safeText(attribution.month,10),cents=safeAmount(attribution.amount_cents);
        costRows.push([propertyDisplay,month,id,documentId,actualKind,
          safeText(event.category_code,64),String(cents),cash,evidence,source,
          String(safeAmount(event.revision_version)),kind]);
      }
    }
    if(event.source_instance_id===sourceInstanceId&&source==='sheet_bulk')
      syncRows.push([propertyDisplay,safeText(event.source_record_id,256),
        documentId,id,String(safeAmount(event.revision_version)),
        String(safeAmount(event.current_version)),
        safeText(event.document_status,16),kind,effective,
        safeText(event.created_at,40),evidence,'']);
  }
  const issues=scan.issues.map(issue=>[propertyDisplay,String(issue.sheet_row),
    issue.row_id??'','待核對',issue.code,'']);
  for(const row of scan.unassigned)issues.push([propertyDisplay,
    String(row.sheet_row),'','待派發編號','SHEET_IDENTITY_PENDING','']);
  const issueIds=new Set(scan.issues.map(issue=>issue.row_id));
  for(const row of scan.rows)if(!issueIds.has(row.row_id)&&
    !['accepted','void'].includes(row.sync_status))
    issues.push([propertyDisplay,String(row.sheet_row),row.row_id,
      '待預覽確認',row.sync_status||'pending','']);
  const bookingRows=[...bookings].sort(([a],[b])=>a.localeCompare(b))
    .map(([bookingId,bucket])=>[propertyDisplay,bookingId,
      String(bucket.receipt??0),String(bucket.refund??0),
      String((bucket.receipt??0)-(bucket.refund??0)),
      String(bucket.ota_observed??0),String(bucket.ota_payout??0),
      String(bucket.expense??0),'','','','']);
  const projection:FinanceSheetProjection[]=[
    {title:FINANCE_SHEET_TABS[1],rows:[
      ['property','sheet_row','row_id','status','reason_code','note'],...issues]},
    {title:FINANCE_SHEET_TABS[2],rows:[
      ['property','booking_id','receipt_cents','refund_cents','net_receipt_cents',
        'ota_guest_observed_cents','ota_payout_cents','allocated_expense_cents',
        '','','',''],...bookingRows]},
    {title:FINANCE_SHEET_TABS[3],rows:[
      ['property','event_id','document_id','event_kind','underlying_kind',
        'amount_cents','cash_effect_cents','effective_on','cash_on',
        'source_system','evidence_level','revision_version'],...eventRows]},
    {title:FINANCE_SHEET_TABS[4],rows:[
      ['property','attribution_month','event_id','document_id','expense_kind',
        'category_code','allocated_cents','cash_on','evidence_level',
        'source_system','revision_version','event_kind'],...costRows]},
    {title:FINANCE_SHEET_TABS[5],rows:[
      ['property','source_record_id','document_id','event_id','revision_version',
        'current_version','document_status','event_kind','effective_on',
        'recorded_at','evidence_level','reserved'],...syncRows]},
  ];
  if(projection.some(tab=>tab.rows.length>5001))throw Error('SHEET_PROJECTION_TOO_LARGE');
  return projection;
}

export function financeSheetProjectionDigest(projection:FinanceSheetProjection[]){
  return hash(projection.map(tab=>({title:tab.title,rows:tab.rows.map(row=>
    Array.from({length:12},(_,index)=>row[index]??''))})));
}
