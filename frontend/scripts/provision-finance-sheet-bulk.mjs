// Prepare one property-scoped finance workbook. This script never enables the
// finance writer or registers its connector in Iron Gate.
import {randomInt} from 'node:crypto';
import {accessToken} from '../src/lib/sheet-monitor/google.ts';
import {readFinanceSheet} from '../src/lib/finance-sheet-bulk-google.ts';
import {FINANCE_SHEET_TABS,financeSheetTemplateRequests}
  from '../src/lib/finance-sheet-bulk-template.ts';

const [spreadsheetId,credentialEnv,propertyDisplay,mode]=process.argv.slice(2);
if(!/^[A-Za-z0-9_-]{10,128}$/.test(spreadsheetId??'')||
  !/^[A-Z][A-Z0-9_]{0,127}$/.test(credentialEnv??'')||
  !propertyDisplay||propertyDisplay.length>80||
  !['--check','--apply'].includes(mode))
  throw Error('Usage: node --experimental-strip-types scripts/provision-finance-sheet-bulk.mjs SPREADSHEET_ID CREDENTIAL_ENV PROPERTY_DISPLAY --check|--apply');

async function request(token,url,options={method:'GET'}){
  const response=await fetch(url,{...options,headers:{Authorization:`Bearer ${token}`,
    ...(options.body?{'Content-Type':'application/json'}:{})},
    redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw Error(`SHEET_SETUP_HTTP_${response.status}`);
  return response.json();
}

const token=await accessToken({credentialEnv},false);
const base=`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
const current=await request(token,base+
  '?fields=properties(timeZone),sheets(properties(sheetId,title))');
if(current.properties?.timeZone!=='Asia/Taipei'||!Array.isArray(current.sheets))
  throw Error('SHEET_IDENTITY_MISMATCH');
const existing=current.sheets.map(sheet=>sheet.properties);
const present=FINANCE_SHEET_TABS.filter(title=>existing.some(sheet=>sheet.title===title));
if(present.length)throw Error('SHEET_TEMPLATE_ALREADY_PRESENT');
const ids=new Set(existing.map(sheet=>sheet.sheetId));
const newIds=FINANCE_SHEET_TABS.map(()=>{
  let id;
  do{id=randomInt(1,2_147_483_647);}while(ids.has(id));
  ids.add(id);return id;
});
if(mode==='--check'){
  process.stdout.write(JSON.stringify({status:'ready',spreadsheetId,
    propertyDisplay,tabs:FINANCE_SHEET_TABS},null,2)+'\n');
}else{
  const writeToken=await accessToken({credentialEnv},true);
  const service=JSON.parse(process.env[credentialEnv]??'null');
  const requests=financeSheetTemplateRequests(newIds,service?.client_email,
    propertyDisplay);
  await request(writeToken,base+':batchUpdate',{
    method:'POST',body:JSON.stringify({requests})});
  await readFinanceSheet({spreadsheetId,sheetId:newIds[0],propertyDisplay,
    credentialEnv});
  process.stdout.write(JSON.stringify({status:'created_and_read_back',spreadsheetId,
    inputSheetId:newIds[0],propertyDisplay,tabs:FINANCE_SHEET_TABS},null,2)+'\n');
}
