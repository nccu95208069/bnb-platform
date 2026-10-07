import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { mount } from "./helpers/customer-dom.mjs";
import { fixture } from "./helpers/order-fixture.mjs";
import { view } from "../src/lib/customer-workspaces/service.ts";
import { orderMutation } from "../src/lib/customer-workspaces/order-mutations.ts";
import { bookingOperation } from "../src/lib/customer-workspaces/operations.ts";
import { OrderDetail } from "../src/components/customer-workspaces/order-detail.tsx";
import { MonthCalendar } from "../src/components/customer-workspaces/month-calendar.tsx";
const initial = async (f) => {
  const w = await f.current();
  return view(w, w.members[0]);
};
function wire(t, f, calls, loseResponse = false) {
  t.mock.method(globalThis, "fetch", async (_, options = {}) => {
    if (options.method !== "POST") return Response.json(await initial(f));
    const input = JSON.parse(options.body);
    calls.push(input);
    const result = await (
      input.action === "payment" ? bookingOperation : orderMutation
    )(f.store, "owner", "test-orders", input);
    if (loseResponse && calls.length === 1)
      throw new Error("Synthetic lost response after commit");
    return Response.json(result);
  });
}
test("full detail keeps all stays; note cancel preserves original, saves persist, and stable shared tags update", async (t) => {
  const f = fixture(),
    calls = [];
  wire(t, f, calls);
  const { button, control, click, fill } = await mount(t, OrderDetail, {
    initial: await initial(f),
    bookingId: "b1",
    backHref: "/w/test-orders/orders?q=guest",
    selectedDate: "2027-02-01",
    selectedRoom: "102",
  });
  assert.match(document.body.textContent, /2 個住宿晚 · 4 房晚/);
  assert.match(document.body.textContent, /入住、退房日期/);
  assert.equal(document.querySelector('nav[aria-label="旅宿功能"]'), null);
  assert.match(document.querySelector("a").getAttribute("href"), /q=guest/);
  await click(button("編輯備註／訂單資料"));
  await fill(control("訂單備註"), "取消的內容");
  await click(button("取消"));
  assert.equal(calls.length, 0);
  assert.match(document.body.textContent, /需要收據/);
  await click(button("編輯備註／訂單資料"));
  await fill(control("訂單備註"), "需要嬰兒用品，晚間入住");
  await fill(control("预訂平台") || control("預訂平台"), "LINE");
  await click(button("儲存"));
  assert.equal((await f.current()).bookings[0].notes, "需要嬰兒用品，晚間入住");
  assert.match(document.body.textContent, /LINE/);
  await click(button("＋ 收據（收）"));
  assert.equal(button("✓ 收據（收）").getAttribute("aria-pressed"), "true");
  await act(() =>
    [...document.querySelectorAll("summary")]
      .find((s) => s.textContent === "新增／編輯共用標籤")
      .click(),
  );
  await click(button("編輯 收據"));
  await fill(control("完整名稱"), "開立收據");
  await fill(control("月曆顯示一個字"), "票");
  await fill(control("顏色"), "rose");
  await click(button("儲存標籤"));
  assert.equal(button("✓ 開立收據（票）").getAttribute("aria-pressed"), "true");
  await click(button("✓ 開立收據（票）"));
  assert.deepEqual((await f.current()).bookings[0].tagIds, []);
});
test("lost note-save response locks navigation and payment; retry reuses request and reloads persisted text", async (t) => {
  const f = fixture(),
    calls = [];
  wire(t, f, calls, true);
  const { button, control, click, fill } = await mount(t, OrderDetail, {
    initial: await initial(f),
    bookingId: "b1",
    backHref: "/w/test-orders/orders",
  });
  await click(button("編輯備註／訂單資料"));
  await fill(control("訂單備註"), "已保存但回應遺失");
  await click(button("儲存"));
  assert.equal(button("＋已收款").disabled, true);
  assert.equal(
    document.querySelector("a").getAttribute("aria-disabled"),
    "true",
  );
  await click(button("重試相同操作"));
  assert.deepEqual(calls[0], calls[1]);
  assert.equal((await f.current()).audit.length, 1);
  assert.match(document.body.textContent, /已保存但回應遺失/);
  assert.equal(button("＋已收款").disabled, false);
});
test("direct receipt form saves account, cash needs no account, Taipei timestamp is stable and extras leave room balance unchanged", async (t) => {
  const f = fixture(),
    calls = [];
  wire(t, f, calls);
  await f.mutate({
    action: "receipt-account",
    name: "Test incoming",
    last4: "8899",
  });
  const data = await initial(f),
    accountId = data.properties[0].receiptAccounts[0].id;
  const { button, control, click, fill } = await mount(t, OrderDetail, {
    initial: data,
    bookingId: "b1",
    backHref: "/w/test-orders/orders",
  });
  assert.equal(control("本次實收金額"), undefined);
  await click(button("＋已收款"));
  await fill(control("本次實收金額"), "3000");
  await fill(control("付款方式"), "匯款");
  await fill(control("旅宿收款帳戶（選填）"), accountId);
  await fill(control("實際收退款時間（臺北）"), "2026-01-01T10:00");
  await fill(control("備註"), "payment-only note");
  await click(button("保存並核對"));
  assert.equal(calls[0].receivedAt, "2026-01-01T02:00:00.000Z");
  assert.match(document.body.textContent, /•••• 8899/);
  assert.match(document.body.textContent, /6,000/);
  await fill(control("款項類別"), "other");
  await fill(control("付款方式"), "現金");
  await fill(control("本次實收金額"), "500");
  assert.equal(control("旅宿收款帳戶（選填）"), undefined);
  await click(button("保存並核對"));
  assert.equal((await f.current()).bookings[0].payments.length, 2);
  assert.equal((await f.current()).bookings[0].notes, "需要收據");
  assert.match(document.body.textContent, /其他收款淨額：NT\$ 500（不抵房費）/);
  assert.match(document.body.textContent, /6,000/);
});
test("month day list orders rooms, excludes checkout and preserves month/room/day in complete-order links", async (t) => {
  const f = fixture();
  await f.mutate({ action: "order-tags", tagIds: ["receipt", "pet"] });
  const { click, control, fill } = await mount(t, MonthCalendar, {
    data: await initial(f),
    propertyId: "p1",
    initialMonth: "2027-02",
    initialDay: "2027-02-01",
  });
  const dayList = document.querySelector('section[aria-label="當日房晚"]');
  assert.equal(dayList.querySelectorAll("a").length, 2);
  assert.match(dayList.textContent, /101 · Test Guest/);
  assert.match(dayList.textContent, /102 · Test Guest/);
  const link = new URL(dayList.querySelector("a").href);
  assert.equal(link.searchParams.get("date"), "2027-02-01");
  assert.match(link.searchParams.get("back"), /month=2027-02/);
  await fill(control("房間"), "102");
  assert.equal(dayList.querySelectorAll("a").length, 1);
  assert.equal(new URL(window.location.href).searchParams.get("room"), "102");
  await click(document.querySelector('button[aria-label^="2027-02-02，"]'));
  assert.equal(
    document
      .querySelector('section[aria-label="當日房晚"]')
      .querySelectorAll("a").length,
    0,
  );
  assert.equal(
    new URL(window.location.href).searchParams.get("day"),
    "2027-02-02",
  );
});
test("no-price detail hides financial sections, notes, account fields and write controls", async (t) => {
  const f = fixture(),
    w = await f.current(),
    data = view(w, w.members[2]);
  await mount(t, OrderDetail, {
    initial: data,
    bookingId: "b1",
    backHref: "/w/test-orders/orders",
  });
  assert.doesNotMatch(
    document.body.textContent,
    /訂單款項|NT\$|需要收據|＋已收款|編輯備註|新增收款帳戶/,
  );
  assert.ok([...document.querySelectorAll("button")].every((b) => b.disabled));
});

test("month-window loading cancels superseded requests; read failure stays a retryable error instead of empty inventory", async (t) => {
  const f = fixture(),
    requests = [];
  t.mock.method(
    globalThis,
    "fetch",
    (url, options) =>
      new Promise((resolve) =>
        requests.push({ url, signal: options.signal, resolve }),
      ),
  );
  const { control, fill, button, click } = await mount(t, MonthCalendar, {
    data: await initial(f),
    propertyId: "p1",
    initialMonth: "2027-02",
    loadWindow: true,
  });
  assert.equal(requests.length, 1);
  await fill(control("月份"), "2027-03");
  assert.equal(requests[0].signal.aborted, true);
  assert.match(document.body.textContent, /正在讀取月份房況/);
  await act(async () => {
    requests[1].resolve(
      Response.json(
        { detail: "Synthetic source unavailable" },
        { status: 503 },
      ),
    );
  });
  assert.match(document.body.textContent, /Synthetic source unavailable/);
  assert.doesNotMatch(document.body.textContent, /當晚未顯示訂單/);
  await click(button("重新讀取月份"));
  assert.equal(requests.length, 3);
  await act(async () => {
    requests[2].resolve(Response.json({ ...(await initial(f)), bookings: [] }));
  });
  assert.doesNotMatch(
    document.body.textContent,
    /Synthetic source unavailable|正在讀取月份房況/,
  );
  assert.equal(control("月份").value, "2027-03");
});
