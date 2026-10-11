import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { ArrivalNotificationSettings } from '../src/components/arrival-notification-settings.tsx';

test('owner sees recipient choice, current delivery state and the exact example contents', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://test.local' });
  const prior = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(document.getElementById('root'));
  t.after(async () => { await act(() => root.unmount()); Object.assign(globalThis, prior); dom.window.close(); });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    assert.match(url, /workspace=sample-inn/); assert.match(url, /property=room-1/);
    const recipient = { accountId: 'steward', email: 'steward@example.test', lineConnected: false, lineVerifiedAt: null };
    const members = ['steward', 'second', 'third', 'fourth'].map(accountId => ({ accountId, email: accountId + '@example.test', role: 'housekeeper' }));
    if (options.method === 'POST') return Response.json({ propertyName: '樣本旅宿', enabled: true, includeUnconfirmed: true, recipients: [recipient], canManage: true, canPair: false, members });
    return Response.json({ propertyName: '樣本旅宿', enabled: false, includeUnconfirmed: false, recipients: [recipient], canManage: true, canPair: false, members });
  });
  await act(async () => root.render(createElement(ArrivalNotificationSettings, { slug: 'sample-inn', properties: [{ id: 'room-1', name: '樣本旅宿' }], initialProperty: 'room-1' })));
  assert.match(document.body.textContent, /選定管家尚未完成 LINE 配對/);
  assert.match(document.querySelector('[aria-label="通知內容預覽"]').textContent, /客人|王先生/);
  assert.match(document.querySelector('[aria-label="通知內容預覽"]').textContent, /請準備嬰兒床/);
  assert.match(document.querySelector('fieldset').textContent, /steward@example.test.*管家/);
  const checks = [...document.querySelectorAll('input[type="checkbox"]')];
  await act(async () => { checks[1].click(); checks[2].click(); });
  assert.equal(checks[3].disabled, true);
  await act(async () => { checks[4].click(); checks[5].click(); });
  await act(async () => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  const sent = calls.find(call => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(sent.options.body), { action: 'save', recipientAccountIds: ['steward', 'second', 'third'], enabled: true, includeUnconfirmed: true });
  assert.match(document.body.textContent, /通知設定已保存/);
});
