import {ironGateCalendarConfig} from './booking-sources/iron-gate-calendar.server';
import type {ManualConfig,Grant} from './booking-sources/iron-gate-manual.server';
import type {FinanceSheetBinding} from './finance-sheet-bulk-google';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;

/** Sweetfun's first isolated workbook; later properties need their own registry entry. */
export function financeSheetBulkConfig(env:NodeJS.ProcessEnv=process.env):{
  binding:FinanceSheetBinding;ironGate:ManualConfig;sourceInstanceId:string;
  secret:string;scanToken:string}{
  try{
    if(env.FINANCE_SHEET_BULK_ENABLED!=='true'||
      env.OS_SWEETFUN_FINANCE_SSOT_ENABLED!=='true')throw Error();
    const calendar=ironGateCalendarConfig(env);
    const grant=JSON.parse(env.IRON_GATE_SWEETFUN_SHEET_BULK_GRANT??'null') as Grant;
    const sourceInstanceId=env.IRON_GATE_SWEETFUN_SHEET_BULK_SOURCE_INSTANCE_ID??'';
    const spreadsheetId=env.FINANCE_SHEET_BULK_SPREADSHEET_ID??'';
    const sheetId=Number(env.FINANCE_SHEET_BULK_SHEET_ID);
    const credentialEnv=env.FINANCE_SHEET_BULK_GOOGLE_CREDENTIAL_ENV??'';
    const secret=env.FINANCE_SHEET_BULK_PREVIEW_SECRET??'';
    const scanToken=env.IRON_GATE_SWEETFUN_SHEET_BULK_SCAN_TOKEN??'';
    if(!grant||Object.keys(grant).sort().join(',')!==
      'clientId,credentialId,propertyId,token,workspaceId'||
      !UUID.test(grant.credentialId)||!UUID.test(grant.clientId)||
      !TOKEN.test(grant.token)||grant.propertyId!==calendar.grant.propertyId||
      grant.workspaceId!==calendar.grant.workspaceId||
      grant.credentialId===calendar.grant.credentialId||
      !UUID.test(sourceInstanceId)||
      !/^[A-Za-z0-9_-]{10,128}$/.test(spreadsheetId)||
      !Number.isSafeInteger(sheetId)||sheetId<0||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(credentialEnv)||secret.length<32||
      !TOKEN.test(scanToken)||scanToken===grant.token)
      throw Error();
    return {binding:{spreadsheetId,sheetId,propertyDisplay:'水芳 Sweetfun',
      credentialEnv},ironGate:{calendar,grant},sourceInstanceId,secret,scanToken};
  }catch{throw Error('FINANCE_SHEET_BULK_UNAVAILABLE');}
}
