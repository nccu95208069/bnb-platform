import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { CalendarToolbar } from '../src/components/calendar/calendar-toolbar.tsx';
import { useCalendarPreferences } from '../src/components/calendar/calendar-preferences.ts';

test('booking source success does not claim channel sync, and warnings still take priority', async t => {
  const stamp = '2026-10-25T03:20:00.000Z';
  const source = { kind: 'iron_gate', label: 'Iron Gate 訂房紀錄',
    automatic_sync: true, availability_authoritative: false,
    observed_at: stamp, sync: { status: 'healthy', last_successful_check_at: stamp } };
  const data = { data_mode: 'iron_gate_booking_only', sources: [
    { property_id: 'sweetfun', source },
    { property_id: 'offland', source: { ...source, label: 'OFFLAND Iron Gate 訂房紀錄' } },
  ] };
  const props = { data, showUnsold: false, paymentReview: false, onPaymentReview() {} };
  const { root } = await mount(t, CalendarToolbar, props);
  await act(() => useCalendarPreferences.setState({ selectedPropertyIds: ['sweetfun', 'offland'] }));
  t.after(() => useCalendarPreferences.setState({ selectedPropertyIds: [] }));
  const summaries = () => [...document.querySelectorAll('summary')].map(el => el.textContent);
  assert.ok(summaries().includes('Sweetfun · 訂單已讀取'));
  assert.ok(summaries().includes('OFFLAND · 訂單已讀取'));
  assert.match(document.body.textContent, /最後成功讀取/);
  assert.match(document.body.textContent, /OwlNest 房況同步請查看各筆訂單/);
  assert.doesNotMatch(document.body.textContent, /確認中|發現資料變更|每分鐘自動檢查訂房表/);

  data.source_warnings = [{ property_id: 'sweetfun', phase: 'payments' }];
  await act(() => root.render(createElement(CalendarToolbar, props)));
  assert.ok(summaries().includes('Sweetfun · 待確認'));
  assert.ok(summaries().includes('OFFLAND · 訂單已讀取'));

  delete data.source_warnings;
  data.sources[0].source = { ...source, sync: { ...source.sync, status: 'stale' } };
  data.sources[1].source = { ...source, kind: 'google_sheet_snapshot', sync: { ...source.sync, status: 'confirming' } };
  await act(() => root.render(createElement(CalendarToolbar, props)));
  assert.ok(summaries().includes('Sweetfun · 已過期'));
  assert.ok(summaries().includes('OFFLAND · 確認中'));
  assert.match(document.body.textContent, /發現資料變更，確認前保留上次資料/);
});
