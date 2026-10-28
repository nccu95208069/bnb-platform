/** Historical coverage is explicit; enabling a new writer does not import old cash. */
export function financeHistoryStatus(property:string,env:NodeJS.ProcessEnv=process.env){
 return property==='offland'&&env.OS_OFFLAND_FINANCE_SSOT_ENABLED==='true'?
  env.OS_OFFLAND_FINANCE_HISTORY_STATUS==='verified'?'verified' as const:'not_imported' as const:
  undefined;
}

/** Stop new Offland commands without reopening the legacy writer. Reads stay available. */
export function financeWritesPaused(property:string,env:NodeJS.ProcessEnv=process.env){
 return property==='offland'&&env.OS_OFFLAND_FINANCE_WRITES_PAUSED==='true';
}
export function assertFinanceWritesOpen(property:string){
 if(financeWritesPaused(property))throw Error('FINANCE_WRITES_PAUSED');
}

export function financeGeneralOnly(property:string,env:NodeJS.ProcessEnv=process.env){
 return property==='offland'&&env.OS_OFFLAND_FINANCE_GENERAL_ONLY==='true';
}
export function assertFinanceCommandScope(property:string,input:Record<string,unknown>){
 if(financeGeneralOnly(property)&&(!['create','update_expense','void'].includes(String(input.action))||
  input.category==='lodging'||Array.isArray(input.allocations)&&input.allocations.length>0||input.order_id!=null))
  throw Error('FINANCE_GENERAL_ONLY');
}
