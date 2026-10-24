import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { CopyableValue } from '../src/components/calendar/copyable-value.tsx';

function mockClipboard(t, writeText) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'jsdom', clipboard: { writeText } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'navigator', descriptor) : delete globalThis.navigator);
}

test('copies a formal number and gives success feedback; a missing number never exposes a UID fallback', async t => {
  const copied = [];
  mockClipboard(t, async text => { copied.push(text); });
  const { root } = await mount(t, CopyableValue, {label: '來源訂單編號', value: 'SYN-ORDER-24'});
  await act(async () => {
    document.querySelector('button[aria-label="複製來源訂單編號"]').click();
    await Promise.resolve();
  });
  assert.deepEqual(copied, ['SYN-ORDER-24']);
  assert.match(document.body.textContent, /已複製/);
  await act(() => root.render(createElement(CopyableValue, {label: '來源訂單編號', value: null})));
  assert.match(document.body.textContent, /未提供正式訂單編號/);
  assert.equal(document.querySelector('button'), null);
});

test('guest name copy uses displayed text', async t => {
  const copied = [];
  mockClipboard(t, async text => { copied.push(text); });
  await mount(t, CopyableValue, {label: '旅客姓名', value: 'SYNTHETIC_GUEST', showValue: false});
  await act(async () => { document.querySelector('button[aria-label="複製旅客姓名"]').click(); await Promise.resolve(); });
  assert.deepEqual(copied, ['SYNTHETIC_GUEST']);
  assert.match(document.body.textContent, /已複製/);
  assert.doesNotMatch(document.body.textContent, /SYNTHETIC_GUEST/);
});

test('copy failure gives an error instead of success feedback', async t => {
  mockClipboard(t, async () => { throw Error('clipboard denied'); });
  await mount(t, CopyableValue, {label: '來源訂單編號', value: 'SYN-ORDER-25'});
  await act(async () => { document.querySelector('button').click(); await Promise.resolve(); });
  assert.match(document.querySelector('[role="alert"]').textContent, /複製失敗/);
  assert.doesNotMatch(document.body.textContent, /已複製/);
});
