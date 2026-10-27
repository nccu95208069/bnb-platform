import {changedFields,type FinanceAuditEvent} from './finance-audit.ts';
import type {SsotActivity} from './booking-sources/iron-gate-ssot-finance.server.ts';

function cents(value:unknown):number|null{
  if(value==null)return null;
  const n=typeof value==='string'&&/^[0-9]+$/.test(value)?Number(value):value;
  if(!Number.isSafeInteger(n)||Number(n)<0)throw Error('FINANCE_SSOT_READBACK_MISMATCH');
  return Number(n);
}
function action(row:SsotActivity):string{
  if(typeof row.ui_action==='string'&&row.ui_action.length<=64)
    return row.ui_action;
  if(row.source==='money'){
    const expense=['expense_paid','processor_fee_paid'].includes(row.event_kind??'');
    if(row.action==='create')return expense?'expense_created':'income_created';
    if(row.action==='amend')return expense?'expense_updated':'income_updated';
    if(row.action==='void')return expense?'expense_voided':'income_voided';
    return 'legacy_unknown';
  }
  const response=row.response??{};
  if('account_code' in response)return 'payment_account_created';
  if('category_code' in response)return 'category_created';
  if('rule_id' in response)return response.status==='ended'?
    'recurring_stopped':'recurring_created';
  if('platform' in response)return 'payout_rule_updated';
  if('status_id' in response)return 'calendar_payment_confirmed';
  if('settlement_id' in response)return 'settlement_recorded';
  if(row.action==='finance:evidence')return 'evidence_recorded';
  if(row.action==='finance:import')return 'historical_imported';
  return 'legacy_unknown';
}

export function mapSsotActivity(rows:SsotActivity[],property:string):FinanceAuditEvent[]{
  return rows.map(row=>{
    if(typeof row.id!=='string'||typeof row.at!=='string'||
      !Number.isFinite(Date.parse(row.at))||typeof row.actor_ref!=='string'||
      typeof row.target_id!=='string'||!['money','operation'].includes(row.source))
      throw Error('FINANCE_SSOT_READBACK_MISMATCH');
    const before=row.source==='money'&&row.before_amount_cents!=null?{
      amount_cents:cents(row.before_amount_cents),
      description:row.before_safe_description}:null;
    const after=row.source==='money'&&row.action!=='void'?{
      amount_cents:cents(row.amount_cents),description:row.safe_description,
      event_kind:row.event_kind}:row.source==='money'?{
      status:'void',void_reason:row.reason_note}:null;
    const complete=row.source==='money'&&row.action==='create';
    return {schema_version:1,id:row.id,request_id:row.request_key??'',
      property_id:property,action:action(row),actor_id:row.actor_ref,
      actor_name:null,actor_email:null,actor_role:null,at:row.at,
      source:'finance',result:'succeeded',target_type:row.source==='money'?
        'entry':'operation',target_id:row.target_id,
      before,after,changed_fields:changedFields(before,after),
      version_before:row.version&&row.version>1?row.version-1:null,
      version_after:row.version,source_version:null,
      completeness:complete?'complete':'legacy_partial'};
  });
}
