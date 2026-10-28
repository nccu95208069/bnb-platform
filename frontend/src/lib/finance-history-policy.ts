/** Historical coverage is explicit; enabling a new writer does not import old cash. */
export function financeHistoryStatus(property:string,env:NodeJS.ProcessEnv=process.env){
 return property==='offland'&&env.OS_OFFLAND_FINANCE_SSOT_ENABLED==='true'?
  env.OS_OFFLAND_FINANCE_HISTORY_STATUS==='verified'?'verified' as const:'not_imported' as const:
  undefined;
}
