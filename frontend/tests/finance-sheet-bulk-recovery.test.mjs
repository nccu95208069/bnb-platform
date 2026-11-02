import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverFinanceSheetBatch} from '../src/lib/finance-sheet-bulk-recovery.ts';

const sheet='SyntheticSheet_0123456789';
const row='10000000-0000-4000-8000-000000000001';
const document='10000000-0000-4000-8000-000000000002';
const event='10000000-0000-4000-8000-000000000003';

test('unknown Sheet write recovers from its original receipt, without posting again',async()=>{
  let reads=0;
  const result=await recoverFinanceSheetBatch(sheet,[{row_id:row,source_version:2}],
    async key=>{reads++;return {receipt_status:'accepted',request_key:key,
      document_id:document,document_version:2,event_ids:[event]};});
  assert.equal(reads,1);
  assert.equal(result[0].status,'accepted');
  assert.equal(result[0].version,2);
  assert.deepEqual(result[0].event_ids,[event]);
});

test('missing, malformed and unavailable receipts never claim an accepted Sheet write',async()=>{
  const input=[{row_id:row,source_version:1}];
  assert.equal((await recoverFinanceSheetBatch(sheet,input,async()=>null))[0].status,
    'not_found');
  assert.equal((await recoverFinanceSheetBatch(sheet,input,async()=>({
    receipt_status:'accepted',request_key:'wrong',document_id:document,
    document_version:1,event_ids:[event]})))[0].status,'unknown');
  assert.equal((await recoverFinanceSheetBatch(sheet,input,async()=>{
    throw Error('network unavailable');}))[0].status,'unknown');
  await assert.rejects(recoverFinanceSheetBatch(sheet,[...input,...input],async()=>null),
    /SHEET_PREVIEW_INVALID/);
});
