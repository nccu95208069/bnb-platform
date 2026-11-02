import test from 'node:test';
import assert from 'node:assert/strict';
import {financeSheetTemplateRequests,FINANCE_SHEET_TABS}
  from '../src/lib/finance-sheet-bulk-template.ts';

test('provisioning template protects identity, projection and all read-only tabs',()=>{
  const ids=[101,102,103,104,105,106];
  const requests=financeSheetTemplateRequests(ids,'finance@example.test','Sweetfun');
  assert.deepEqual(requests.filter(request=>request.addSheet)
    .map(request=>request.addSheet.properties.title),FINANCE_SHEET_TABS);
  const ranges=requests.filter(request=>request.addProtectedRange)
    .map(request=>request.addProtectedRange.protectedRange);
  assert.ok(ranges.some(item=>item.range.sheetId===101&&
    item.range.startColumnIndex===0&&item.range.endColumnIndex===2&&
    item.range.endRowIndex===undefined));
  assert.ok(ranges.some(item=>item.range.sheetId===101&&
    item.range.startColumnIndex===16&&item.range.endColumnIndex===20&&
    item.range.endRowIndex===undefined));
  assert.equal(ranges.filter(item=>ids.slice(1).includes(item.range.sheetId)).length,5);
  assert.ok(ranges.every(item=>item.warningOnly===false&&
    item.editors.users[0]==='finance@example.test'));
  assert.equal(requests.find(request=>request.repeatCell)
    .repeatCell.cell.userEnteredValue.stringValue,'Sweetfun');
});

test('input dates and allocation months retain exact ISO text',()=>{
  const requests=financeSheetTemplateRequests([101,102,103,104,105,106],
    'finance@example.test','Sweetfun');
  const text=requests.filter(request=>request.repeatCell?.cell?.userEnteredFormat?.
    numberFormat?.type==='TEXT').map(request=>request.repeatCell.range);
  assert.deepEqual(text.map(range=>[range.startColumnIndex,range.endColumnIndex]),
    [[5,8],[12,13]]);
  assert.ok(text.every(range=>range.sheetId===101&&range.startRowIndex===1));
});
