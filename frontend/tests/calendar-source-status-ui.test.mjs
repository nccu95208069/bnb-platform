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
  const props = { data, readState: 'ready', showUnsold: false, paymentReview: false, onPaymentReview() {} };
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
  assert.equal(document.querySelector('summary .bg-emerald-500'), null);

  data.data_mode = 'iron_gate_snapshot_preview';
  data.sources[0].source = source;
  await act(() => root.render(createElement(CalendarToolbar, props)));
  assert.ok(summaries().includes('Sweetfun · 固定快照'));
  assert.equal(document.querySelector('summary .bg-emerald-500'), null);
});

test('saved healthy data stays amber while loading or failed, then becomes green only after success', async t => {
  const stamp = '2026-11-01T02:00:00.000Z';
  const source = { kind: 'iron_gate', label: 'OFFLAND Iron Gate 訂房紀錄',
    automatic_sync: true, availability_authoritative: false,
    observed_at: stamp, sync: { status: 'healthy', last_successful_check_at: stamp } };
  const data = { data_mode: 'iron_gate_booking_only', sources: [
    { property_id: 'offland', source },
  ] };
  const props = { data, showUnsold: false, paymentReview: false, onPaymentReview() {} };
  const { root } = await mount(t, CalendarToolbar, props);
  await act(() => useCalendarPreferences.setState({ selectedPropertyIds: ['offland'] }));
  t.after(() => useCalendarPreferences.setState({ selectedPropertyIds: [] }));
  const summary = () => [...document.querySelectorAll('summary')]
    .find(el => el.textContent.startsWith('OFFLAND ·'));
  const lastSuccess = () => [...document.querySelectorAll('p')]
    .find(el => el.textContent.startsWith('最後成功讀取：'))?.textContent;
  const originalTime = lastSuccess();

  for (const [readState, label, detail] of [
    [undefined, '讀取中', '現有資料尚未確認'],
    ['loading', '讀取中', '現有資料尚未確認'],
    ['refreshing', '更新中', '目前顯示上次讀取的資料'],
    ['failed', '更新失敗・顯示舊資料', '僅供查看'],
    ['refreshing', '更新中', '目前顯示上次讀取的資料'],
  ]) {
    await act(() => root.render(createElement(CalendarToolbar, { ...props, readState })));
    assert.equal(summary()?.textContent, `OFFLAND · ${label}`);
    assert.ok(summary()?.querySelector('.bg-amber-500'));
    assert.equal(summary()?.querySelector('.bg-emerald-500'), null);
    assert.ok(document.body.textContent.includes(detail));
    assert.doesNotMatch(document.body.textContent, /訂單已讀取|已讀取 Iron Gate 訂單/);
    assert.equal(lastSuccess(), originalTime, 'retry/failure must not advance the last successful read time');
  }

  await act(() => root.render(createElement(CalendarToolbar, { ...props, readState: 'ready' })));
  assert.equal(summary()?.textContent, 'OFFLAND · 訂單已讀取');
  assert.ok(summary()?.querySelector('.bg-emerald-500'));
  assert.equal(source.sync.status, 'healthy', 'display status must not mutate the retained response');
});
