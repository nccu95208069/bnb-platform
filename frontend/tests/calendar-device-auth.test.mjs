import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { mount } from './helpers/customer-dom.mjs';
process.env.NEXT_PUBLIC_CALENDAR_SOURCE = 'sheet_snapshot';
const { useAccessControl } = await import('../src/lib/access-control.ts');
const { AuthGuard } = await import('../src/components/admin/auth-guard.tsx');
const { SnapshotPreviewShell } = await import('../src/components/calendar/snapshot-preview-shell.tsx');
const { CALENDAR_DEVICE_CACHE_EVENT, createCalendarDeviceScope, clearCalendarDeviceCache } = await import('../src/lib/calendar-device-cache.ts');
const member = { id: 'synthetic-owner', tenantId: 'synthetic-workspace', tenantName: 'Synthetic',
  displayName: 'Synthetic owner', email: null, phone: null, role: 'owner', status: 'active',
  allProperties: true, propertyIds: ['sweetfun', 'offland'] };
const session = { available: true, authenticated: true, membership: member };
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const scope = () => createCalendarDeviceScope(useAccessControl.getState(), { properties: [], viewPrices: true });
const child = createElement('div', { 'data-private-calendar': true }, 'Synthetic private calendar');

test('a remote clear hides verified private data immediately and waits for fresh server authorization', async t => {
  useAccessControl.getState().reset();
  let resolveSession; let reads = 0;
  t.mock.method(globalThis, 'fetch', () => { reads++; return new Promise(resolve => { resolveSession = resolve; }); });
  const mounted = await mount(t, AuthGuard, { initialSession: session, children: child });
  assert.ok(document.querySelector('[data-private-calendar]'));
  await act(() => window.dispatchEvent(new CustomEvent(CALENDAR_DEVICE_CACHE_EVENT, { detail: { remote: true } })));
  assert.equal(reads, 1);
  assert.equal(useAccessControl.getState().membership, null);
  assert.equal(document.querySelector('[data-private-calendar]'), null);
  await act(async () => { resolveSession(response(session)); });
  assert.ok(document.querySelector('[data-private-calendar]'));
  assert.equal(useAccessControl.getState().membership.id, member.id);
  await act(() => mounted.root.unmount());
  useAccessControl.getState().reset();
});

test('completed local logout clears visible data without rereading a still-present or delayed cookie', async t => {
  useAccessControl.getState().reset();
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => { reads++; return response(session); });
  const mounted = await mount(t, AuthGuard, { initialSession: session, children: child });
  await act(() => clearCalendarDeviceCache());
  assert.equal(reads, 0);
  assert.equal(document.querySelector('[data-private-calendar]'), null);
  assert.equal(useAccessControl.getState().membership, null);
  assert.equal(scope(), null);
  await act(() => mounted.root.unmount());
});

test('role/property downgrade revokes cache generation while preserving the newly verified membership', async t => {
  useAccessControl.getState().reset();
  const next = { ...session, membership: { ...member, role: 'viewer_no_price', allProperties: false, propertyIds: ['offland'] } };
  t.mock.method(globalThis, 'fetch', async () => response(next));
  const mounted = await mount(t, AuthGuard, { initialSession: session, children: child });
  const oldScope = scope(); assert.ok(oldScope);
  let clearEvents = 0;
  window.addEventListener(CALENDAR_DEVICE_CACHE_EVENT, () => { clearEvents++; });
  await act(() => useAccessControl.getState().initialize({ force: true }));
  assert.equal(useAccessControl.getState().membership.role, 'viewer_no_price');
  assert.deepEqual(useAccessControl.getState().membership.propertyIds, ['offland']);
  const nextScope = createCalendarDeviceScope(useAccessControl.getState(), { properties: ['offland'], viewPrices: false });
  assert.ok(nextScope); assert.notEqual(nextScope.key, oldScope.key);
  assert.ok(nextScope.generation > oldScope.generation);
  assert.equal(clearEvents, 0, 'identity refresh does not recursively invalidate its own new session');
  assert.ok(document.querySelector('[data-private-calendar]'));
  await act(() => mounted.root.unmount());
  useAccessControl.getState().reset();
});

test('preview logout only clears session after DELETE succeeds, and never refetches to restore it', async t => {
  useAccessControl.getState().reset();
  let completeDelete; const methods = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    methods.push(options?.method ?? 'GET');
    return new Promise(resolve => { completeDelete = resolve; });
  });
  const mounted = await mount(t, AuthGuard, { initialSession: session,
    children: createElement(SnapshotPreviewShell, null, child) });
  await mounted.click(mounted.button('登出'));
  assert.equal(useAccessControl.getState().membership.id, member.id);
  await act(async () => { completeDelete(response({ authenticated: false })); });
  assert.deepEqual(methods, ['DELETE']);
  assert.equal(useAccessControl.getState().membership, null);
  assert.equal(document.querySelector('[data-private-calendar]'), null);
  await act(() => mounted.root.unmount());
});
