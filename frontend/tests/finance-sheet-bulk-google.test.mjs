import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {FINANCE_SHEET_HEADERS,scanFinanceSheet} from '../src/lib/finance-sheet-bulk-core.ts';
import {claimFinanceSheetRow,projectFinanceSheetReceipt,
  readFinanceSheet} from '../src/lib/finance-sheet-bulk-google.ts';

const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const binding={spreadsheetId:'SyntheticSheet_0123456789',sheetId:11,
  propertyDisplay:'Sweetfun',credentialEnv:'SYNTHETIC_FINANCE_SHEET_CREDENTIAL'};
const eventId='10000000-0000-4000-8000-000000000003';
const cell=(name,value)=>[FINANCE_SHEET_HEADERS.indexOf(name),value];
const business=()=>{
  const row=Array(FINANCE_SHEET_HEADERS.length).fill('');
  for(const [index,value] of [cell('action','create'),cell('event_kind','expense_paid'),
    cell('amount_twd','101'),cell('effective_on','2026-10-28'),
    cell('cash_on','2026-10-28'),cell('service_on','2026-09-01'),
    cell('category_code','supplies'),cell('payment_method_code','cash'),
    cell('allocation_start_month','2026-10'),cell('allocation_months','2'),
    cell('safe_description','Supplies'),cell('property_display','Sweetfun')])row[index]=value;
  return row;
};
function fakeGoogle(values){
  const calls=[];
  const send=async(url,options)=>{
    calls.push({url,method:options.method});
    if(url==='https://oauth2.googleapis.com/token')
      return Response.json({access_token:'synthetic-token'});
    if(url.includes('?fields='))return Response.json({properties:{timeZone:'Asia/Taipei'},
      sheets:[{properties:{sheetId:11,title:'批次輸入',gridProperties:{rowCount:5,columnCount:20}},
        protectedRanges:[{range:{sheetId:11,startColumnIndex:0,endColumnIndex:2}},
          {range:{sheetId:11,startColumnIndex:16,endColumnIndex:20}}]}]});
    if(url.includes('/values:batchUpdate')){
      const body=JSON.parse(options.body);
      for(const update of body.data){
        const [,column,row]=/!([A-Z]+)(\d+)$/.exec(update.range);
        values[Number(row)-1][column.charCodeAt(0)-65]=update.values[0][0];
      }
      return Response.json({totalUpdatedCells:body.data.length});
    }
    if(url.includes('/values/'))return Response.json({majorDimension:'ROWS',values});
    throw Error('Unexpected URL');
  };
  return {send,calls,values};
}

test('new row identity is re-read before import; accepted projection survives a later edit',async()=>{
  process.env[binding.credentialEnv]=JSON.stringify({client_email:'synthetic@example.test',
    private_key:privateKey.export({type:'pkcs8',format:'pem'})});
  try{
    const google=fakeGoogle([[...FINANCE_SHEET_HEADERS],business()]);
    const first=scanFinanceSheet(await readFinanceSheet(binding,google.send),'Sweetfun');
    assert.equal(first.unassigned.length,1);
    const rowId=await claimFinanceSheetRow(binding,2,first.unassigned[0].content_hash,
      google.send);
    assert.equal(google.values[1][0],rowId);
    const parsed=scanFinanceSheet(google.values,'Sweetfun').rows[0];
    google.values[1][FINANCE_SHEET_HEADERS.indexOf('amount_twd')]='102';
    assert.equal(await projectFinanceSheetReceipt(binding,rowId,parsed.content_hash,1,
      eventId,'accepted',google.send),true);
    const projected=scanFinanceSheet(google.values,'Sweetfun').rows[0];
    assert.equal(projected.base_version,1);
    assert.equal(projected.sync_status,'pending_revision');
    assert.equal(projected.accepted_hash,parsed.content_hash);
    google.values[1][FINANCE_SHEET_HEADERS.indexOf('amount_twd')]='101';
    assert.equal(await projectFinanceSheetReceipt(binding,rowId,parsed.content_hash,1,
      eventId,'accepted',google.send),true);
    assert.equal(google.values[1][FINANCE_SHEET_HEADERS.indexOf('sync_status')],
      'accepted');
    assert.equal(await projectFinanceSheetReceipt(binding,rowId,parsed.content_hash,1,
      eventId,'accepted',google.send),true);
  }finally{delete process.env[binding.credentialEnv];}
});

test('identity write fails verification if row moves or changes during the write',async()=>{
  process.env[binding.credentialEnv]=JSON.stringify({client_email:'synthetic@example.test',
    private_key:privateKey.export({type:'pkcs8',format:'pem'})});
  try{
    const google=fakeGoogle([[...FINANCE_SHEET_HEADERS],business()]);
    const hash=scanFinanceSheet(google.values,'Sweetfun').unassigned[0].content_hash;
    const send=async(url,options)=>{
      const response=await google.send(url,options);
      if(url.includes('/values:batchUpdate'))
        google.values[1][FINANCE_SHEET_HEADERS.indexOf('amount_twd')]='999';
      return response;
    };
    await assert.rejects(claimFinanceSheetRow(binding,2,hash,send),
      /SHEET_WRITE_UNCONFIRMED/);
  }finally{delete process.env[binding.credentialEnv];}
});

test('input read requests formulas and a formula amount cannot receive an import identity',async()=>{
  process.env[binding.credentialEnv]=JSON.stringify({client_email:'synthetic@example.test',
    private_key:privateKey.export({type:'pkcs8',format:'pem'})});
  try{
    const formula=business();
    formula[FINANCE_SHEET_HEADERS.indexOf('amount_twd')]='=100+1';
    const google=fakeGoogle([[...FINANCE_SHEET_HEADERS],formula]);
    const scan=scanFinanceSheet(await readFinanceSheet(binding,google.send),'Sweetfun');
    assert.equal(scan.unassigned.length,0);
    assert.equal(scan.issues[0].code,'SHEET_FORMULA_FORBIDDEN');
    assert.ok(google.calls.some(call=>call.url.includes('valueRenderOption=FORMULA')&&
      call.url.includes('dateTimeRenderOption=FORMATTED_STRING')));
  }finally{delete process.env[binding.credentialEnv];}
});
