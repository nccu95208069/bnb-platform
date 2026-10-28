import test from 'node:test';
import assert from 'node:assert/strict';
import {readFinanceSheetLedger,readFinanceSheetLedgerHead}
  from '../src/lib/finance-sheet-bulk-ledger.ts';

const config={calendar:{baseUrl:'https://ig.example.test/'},
  grant:{propertyId:'10000000-0000-4000-8000-000000000001'}};
const token='A'.repeat(43);
const identity={sourceInstanceId:'10000000-0000-4000-8000-000000000009',
  spreadsheetId:'SyntheticSheet_0123456789'};
const binding={source_instance_id:identity.sourceInstanceId,
  source_system:'sheet_bulk',source_sheet_ref:identity.spreadsheetId};
const event=index=>({id:`10000000-0000-4000-8000-${String(index).padStart(12,'0')}`,
  change_seq:index});

test('ledger pages reuse one property change sequence and expose a final head',async()=>{
  const queries=[];
  const send=async url=>{
    const query=new URL(url).searchParams;
    queries.push(Object.fromEntries(query));
    if(query.get('limit')==='1')return Response.json({...binding,events:[event(102)],
      as_of_change_seq:102,current_change_seq:102,
      unsequenced_event_count:0,next_cursor:'head'});
    if(!query.get('cursor'))return Response.json({...binding,events:Array.from({length:100},
      (_,index)=>event(index+1)),as_of_change_seq:101,current_change_seq:101,
      unsequenced_event_count:0,next_cursor:'next'});
    return Response.json({...binding,events:[event(101)],as_of_change_seq:101,
      current_change_seq:102,unsequenced_event_count:0,next_cursor:null});
  };
  const snapshot=await readFinanceSheetLedger(config,token,identity,send);
  assert.equal(snapshot.events.length,101);
  assert.equal(snapshot.asOfChangeSeq,101);
  assert.equal(snapshot.currentChangeSeq,102);
  assert.equal(queries[0].as_of_change_seq,undefined);
  assert.equal(queries[1].as_of_change_seq,'101');
  assert.equal(await readFinanceSheetLedgerHead(config,token,identity,send),102);
});

test('ledger rejects unsequenced history and a changed page pin',async()=>{
  await assert.rejects(readFinanceSheetLedger(config,token,identity,async()=>Response.json({...binding,
    events:[],next_cursor:null,as_of_change_seq:2,current_change_seq:2,
    unsequenced_event_count:1})),/SHEET_LEDGER_UNSEQUENCED/);
  let calls=0;
  await assert.rejects(readFinanceSheetLedger(config,token,identity,async()=>{
    calls++;
    return Response.json({...binding,events:[event(calls)],next_cursor:calls===1?'next':null,
      as_of_change_seq:calls===1?2:3,current_change_seq:3,
      unsequenced_event_count:0});
  }),/SHEET_LEDGER_INVALID/);
});

test('scanner rejects a read grant bound to another connector or workbook',async()=>{
  for(const wrong of [{...binding,source_instance_id:
    '10000000-0000-4000-8000-000000000010'},
  {...binding,source_sheet_ref:'AnotherSheet_0123456789'},
  {...binding,source_system:'ota_evidence'}]){
    const send=async()=>Response.json({...wrong,events:[],next_cursor:null,
      as_of_change_seq:0,current_change_seq:0,unsequenced_event_count:0});
    await assert.rejects(readFinanceSheetLedger(config,token,identity,send),
      /SHEET_LEDGER_INVALID/);
    await assert.rejects(readFinanceSheetLedgerHead(config,token,identity,send),
      /SHEET_LEDGER_INVALID/);
  }
});
