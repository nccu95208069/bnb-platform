import test from 'node:test';
import assert from 'node:assert/strict';
import {financeHistoryStatus} from '../src/lib/finance-history-policy.ts';

test('Offland history reports verified general import while keeping booking cash under review',()=>{
  const env={OS_OFFLAND_FINANCE_SSOT_ENABLED:'true',
    OS_OFFLAND_FINANCE_HISTORY_STATUS:'general_imported_booking_review'};
  assert.equal(financeHistoryStatus('offland',env),'general_imported_booking_review');
  assert.equal(financeHistoryStatus('sweetfun',env),undefined);
  assert.equal(financeHistoryStatus('offland',{
    ...env,OS_OFFLAND_FINANCE_SSOT_ENABLED:'false'}),undefined);
});

test('partial OS import reports LINE pending without claiming both sources are complete',()=>{
  assert.equal(financeHistoryStatus('offland',{
    OS_OFFLAND_FINANCE_SSOT_ENABLED:'true',
    OS_OFFLAND_FINANCE_HISTORY_STATUS:'os_imported_line_pending',
  }),'os_imported_line_pending');
});

test('unknown history setting fails closed to not imported',()=>{
  assert.equal(financeHistoryStatus('offland',{
    OS_OFFLAND_FINANCE_SSOT_ENABLED:'true',
    OS_OFFLAND_FINANCE_HISTORY_STATUS:'unexpected'}),'not_imported');
  assert.equal(financeHistoryStatus('offland',{
    OS_OFFLAND_FINANCE_SSOT_ENABLED:'true',
    OS_OFFLAND_FINANCE_HISTORY_STATUS:'verified'}),'verified');
});
