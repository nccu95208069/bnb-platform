export const AUDIT_ACTIONS:Record<string,string>={expense_created:'新增費用',income_created:'新增收入',expense_updated:'修改費用',expense_voided:'作廢費用',income_voided:'作廢收入',recurring_created:'新增循環支出',recurring_stopped:'停止循環支出',payout_rule_updated:'修改平台入帳規則',payment_account_created:'新增付款帳戶',calendar_payment_recorded:'日曆登記收款',legacy_unknown:'歷史紀錄不完整'};
export type FinanceAuditEvent={schema_version:1;id:string;request_id:string;property_id:string;action:string;actor_id:string;actor_name:string|null;actor_email:string|null;actor_role:string|null;at:string;source:'finance'|'calendar';result:'succeeded';target_type:string;target_id:string;before:Record<string,unknown>|null;after:Record<string,unknown>|null;changed_fields:string[];version_before:number|null;version_after:number|null;source_version:string|null;completeness:'complete'|'legacy_partial'};
export function auditSnapshot(value:unknown):Record<string,unknown>|null{
 if(!value||typeof value!=='object')return null;
 // Keep business snapshots without recursive history or internal verification secrets.
 return JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(value).filter(([k])=>!['history','audit','request_hash','ledger_year'].includes(k))))) as Record<string,unknown>;
}
export function changedFields(before:Record<string,unknown>|null,after:Record<string,unknown>|null){return [...new Set([...Object.keys(before??{}),...Object.keys(after??{})])].filter(k=>JSON.stringify(before?.[k])!==JSON.stringify(after?.[k]));}
