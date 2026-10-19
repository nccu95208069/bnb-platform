import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/customer-dom.mjs';
import { websiteFixture } from './helpers/website-booking-fixture.mjs';
import { orderMutation } from '../src/lib/customer-workspaces/order-mutations.ts';
import { holdOperation } from '../src/lib/customer-workspaces/holds.ts';
import { view } from '../src/lib/customer-workspaces/service.ts';
import { OrderDetail } from '../src/components/customer-workspaces/order-detail.tsx';

async function fixture(t, { lostResponse = false, role = 'owner' } = {}) {
  const f = await websiteFixture();
  const { result } = await f.reserve();
  const workspace = await f.workspace();
  const current = view(workspace, workspace.members.find(m => m.accountId === f.account.id));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const input = JSON.parse(options.body); calls.push(input);
    const saved = await (input.action === 'receipt-account' ? orderMutation : holdOperation)(f.store, f.account.id, workspace.slug, input);
    if (lostResponse && calls.length === 1) throw Error('Synthetic committed response lost');
    return Response.json(saved);
  });
  const ui = await mount(t, OrderDetail, { initial: { ...current, role }, bookingId: result.orderId, backHref: `/w/${workspace.slug}/orders` });
  return { f, calls, ui, orderId: result.orderId };
}

async function addAccount(ui) {
  await ui.click(ui.button('確認已收訂金'));
  await ui.fill(ui.control('實際收款金額'), '1000');
  await ui.fill(ui.control('方式'), 'bank');
  assert.match(document.body.textContent, /尚未設定收款帳戶/);
  await ui.click(ui.button('新增收款帳戶'));
  await ui.fill(ui.control('帳戶名稱'), '隔離驗收帳戶');
  await ui.fill(ui.control('帳號末四碼'), '0000');
  await ui.click(ui.button('儲存收款帳戶'));
}

test('first website hold can add a receipt account and confirm bank deposit on the same order', async t => {
  const { f, calls, ui, orderId } = await fixture(t);
  await addAccount(ui);
  const beforePayment = await f.workspace(), account = beforePayment.properties[0].receiptAccounts[0];
  assert.equal(beforePayment.bookings[0].status, 'held');
  assert.equal(beforePayment.bookings[0].payments.length, 0);
  assert.equal(beforePayment.bookings.length, 1);
  assert.equal(ui.control('實際收款金額').value, '1000');
  assert.equal(ui.control('方式').value, 'bank');
  assert.equal(ui.control('入帳帳戶').value, account.id);
  assert.equal(ui.control('我已核對實際入帳，金額與時間正確。').checked, false);
  await ui.click(ui.control('我已核對實際入帳，金額與時間正確。'));
  await ui.click(ui.control('我確認這次操作僅更新本工作區，外部通路需另外核對。'));
  await ui.click(ui.button('確認儲存'));
  const saved = await f.workspace(), booking = saved.bookings[0];
  assert.equal(saved.bookings.length, 1); assert.equal(booking.id, orderId);
  assert.equal(booking.status, 'confirmed'); assert.equal(booking.payments.length, 1);
  assert.equal(booking.payments[0].amount, 1000); assert.equal(booking.payments[0].receiptAccount.id, account.id);
  assert.deepEqual(calls.map(c => c.action), ['receipt-account', 'hold-convert']);
  assert.equal(calls[1].version, beforePayment.version);
  assert.match(document.body.textContent, /NT\$ 1,000/);
});

test('lost account creation response locks all writes and replays the identical command without duplicate account or receipt', async t => {
  const { f, calls, ui } = await fixture(t, { lostResponse: true });
  await addAccount(ui);
  assert.equal(ui.button('儲存收款帳戶').matches(':disabled'), true);
  assert.equal(ui.button('返回核款').matches(':disabled'), true);
  assert.equal(ui.button('釋出保留').disabled, true);
  assert.equal(ui.button('改期／換房與總額').disabled, true);
  await ui.click(ui.button('重試相同操作並核對結果'));
  assert.deepEqual(calls[0], calls[1]);
  const saved = await f.workspace();
  assert.equal(saved.properties[0].receiptAccounts.length, 1);
  assert.equal(saved.bookings[0].status, 'held');
  assert.equal(saved.bookings[0].payments.length, 0);
  assert.equal(ui.control('入帳帳戶').value, saved.properties[0].receiptAccounts[0].id);
  assert.equal(ui.control('實際收款金額').value, '1000');
});

test('housekeepers cannot create receipt accounts or convert website holds', async t => {
  const { calls, ui } = await fixture(t, { role: 'housekeeper' });
  assert.equal(ui.button('確認已收訂金'), undefined);
  assert.equal(ui.button('新增收款帳戶'), undefined);
  assert.equal(calls.length, 0);
});
