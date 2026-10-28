import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFinanceSheetAudit,financeSheetFullBookIssues,persistFinanceSheetAudit,
  taipeiAuditDay} from '../src/lib/finance-sheet-bulk-audit.ts';

const sheet='SyntheticSheet_0123456789';
const property='10000000-0000-4000-8000-000000000001';
const source='10000000-0000-4000-8000-000000000002';
const rowId='10000000-0000-4000-8000-000000000003';
const eventId='10000000-0000-4000-8000-000000000004';
const digest='a'.repeat(64);
const snapshot={source_record_id:`sheet:${sheet}:${rowId}`,current_version:1,
  status:'active',accepted_hash:digest,event_id:eventId};
const row={sheet_row:2,row_id:rowId,base_version:1,accepted_hash:digest,
  event_id:eventId,sync_status:'accepted',content_hash:digest};
const base={spreadsheetId:sheet,propertyId:property,sourceInstanceId:source,
  values:[['header'],['row']],readbackValues:[['header'],['row']],
  events:[{id:eventId,change_seq:1}],asOfChangeSeq:1,observedChangeSeq:1,
  projectionDigest:digest,readbackDigest:digest,issues:[],
  now:new Date('2026-10-28T15:58:00Z')};

test('full-book audit compares each accepted row with the exact ledger revision',()=>{
  const documents=new Map([[snapshot.source_record_id,snapshot]]);
  assert.deepEqual(financeSheetFullBookIssues({rows:[row],issues:[],unassigned:[]},
    documents,sheet),[]);
  assert.equal(financeSheetFullBookIssues({rows:[{...row,event_id:property}],
    issues:[],unassigned:[]},documents,sheet)[0].code,'SHEET_LEDGER_ROW_MISMATCH');
  assert.equal(financeSheetFullBookIssues({rows:[],issues:[],unassigned:[]},
    documents,sheet)[0].code,'SHEET_MISSING_ACCEPTED_ROW');
});

test('daily record binds both readbacks and the pinned ledger watermark',()=>{
  assert.equal(taipeiAuditDay(base.now),'2026-10-28');
  const good=buildFinanceSheetAudit(base);
  assert.equal(good.status,'ok');
  assert.equal(good.issue_count,0);
  assert.equal(good.input_digest,good.input_readback_digest);
  const moved=buildFinanceSheetAudit({...base,observedChangeSeq:2,
    readbackValues:[['header'],['changed']]});
  assert.equal(moved.status,'review');
  assert.deepEqual(moved.issue_codes,{SHEET_LEDGER_MOVED:1,SHEET_INPUT_MOVED:1});
});

test('private evidence appends only distinct daily states and checks readback',async()=>{
  const values=new Map();
  const command=async args=>{
    if(args[0]==='EVAL'){
      const [,script,,latest,history,fingerprint,encoded]=args;
      assert.match(script,/RPUSH/);
      const previous=values.get(latest);
      if(previous&&JSON.parse(previous).fingerprint===fingerprint)return 0;
      values.set(history,[...(values.get(history)??[]),encoded]);
      values.set(latest,encoded);return 1;
    }
    if(args[0]==='GET')return values.get(args[1])??null;
    if(args[0]==='LINDEX')return values.get(args[1])?.at(-1)??null;
    throw Error('unexpected command');
  };
  const first=buildFinanceSheetAudit(base);
  assert.equal((await persistFinanceSheetAudit(sheet,first,command)).stored,true);
  assert.equal((await persistFinanceSheetAudit(sheet,buildFinanceSheetAudit(base),
    command)).stored,false);
  const changed=buildFinanceSheetAudit({...base,observedChangeSeq:2});
  assert.equal((await persistFinanceSheetAudit(sheet,changed,command)).stored,true);
  const history=[...values.entries()].find(([key])=>key.endsWith(':history'))?.[1];
  assert.equal(history.length,2);
  const broken=async args=>args[0]==='LINDEX'?'corrupt':command(args);
  await assert.rejects(persistFinanceSheetAudit(sheet,changed,broken),
    /SHEET_AUDIT_UNCONFIRMED/);
});
