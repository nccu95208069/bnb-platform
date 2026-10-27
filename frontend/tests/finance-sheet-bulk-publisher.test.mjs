import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {FINANCE_SHEET_TABS} from '../src/lib/finance-sheet-bulk-template.ts';
import {publishFinanceSheetProjections}
  from '../src/lib/finance-sheet-bulk-publisher.ts';

const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const binding={spreadsheetId:'SyntheticSheet_0123456789',sheetId:10,
  propertyDisplay:'Sweetfun',credentialEnv:'SYNTHETIC_PROJECTION_CREDENTIAL'};
const projections=FINANCE_SHEET_TABS.slice(1).map((title,index)=>({title,
  rows:[['property','event','status'],['Sweetfun',String(index),'accepted']]}));
function google(protectedRanges=true){
  const values=new Map(FINANCE_SHEET_TABS.slice(1).map(title=>[title,[]]));
  let writes=0;
  const send=async(url,options)=>{
    if(url==='https://oauth2.googleapis.com/token')
      return Response.json({access_token:'synthetic-token'});
    if(url.includes('?fields='))return Response.json({properties:{timeZone:'Asia/Taipei'},
      sheets:FINANCE_SHEET_TABS.slice(1).map((title,index)=>({
        properties:{sheetId:index+101,title,gridProperties:{rowCount:5,columnCount:12}},
        protectedRanges:protectedRanges?[{range:{sheetId:index+101,
          startRowIndex:0,startColumnIndex:0,endColumnIndex:12}}]:[]}))});
    if(url.endsWith(':batchUpdate')){
      writes++;
      for(const request of JSON.parse(options.body).requests){
        const sheetId=request.repeatCell?.range.sheetId??request.updateCells?.range.sheetId;
        const title=FINANCE_SHEET_TABS[sheetId-100];
        if(request.repeatCell)values.set(title,[]);
        else values.set(title,request.updateCells.rows.map(row=>row.values.map(cell=>
          cell.userEnteredValue.stringValue)));
      }
      return Response.json({replies:[]});
    }
    if(url.includes('/values/')){
      const encoded=url.split('/values/')[1].split('?')[0];
      const title=decodeURIComponent(encoded).match(/^'(.+)'!/)[1];
      return Response.json({majorDimension:'ROWS',values:values.get(title)});
    }
    throw Error('Unexpected Google URL');
  };
  return {send,values,get writes(){return writes;}};
}

test('protected output tabs update atomically and read back before reporting success',async()=>{
  process.env[binding.credentialEnv]=JSON.stringify({client_email:'synthetic@example.test',
    private_key:privateKey.export({type:'pkcs8',format:'pem'})});
  try{
    const fake=google();
    assert.equal((await publishFinanceSheetProjections(binding,projections,fake.send)).status,
      'projected');
    assert.equal(fake.writes,1);
    assert.equal((await publishFinanceSheetProjections(binding,projections,fake.send)).status,
      'unchanged');
    assert.equal(fake.writes,1);
    fake.values.get(FINANCE_SHEET_TABS[2])[1][2]='tampered';
    assert.equal((await publishFinanceSheetProjections(binding,projections,fake.send)).status,
      'projected');
    assert.equal(fake.writes,2);
  }finally{delete process.env[binding.credentialEnv];}
});

test('output projection refuses a tab without full protection',async()=>{
  process.env[binding.credentialEnv]=JSON.stringify({client_email:'synthetic@example.test',
    private_key:privateKey.export({type:'pkcs8',format:'pem'})});
  try{
    const fake=google(false);
    await assert.rejects(publishFinanceSheetProjections(binding,projections,fake.send),
      /SHEET_PROTECTION_MISSING/);
    assert.equal(fake.writes,0);
  }finally{delete process.env[binding.credentialEnv];}
});
