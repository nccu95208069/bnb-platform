import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { CustomerSettings } from "../src/components/customer-workspaces/settings.tsx";
import { CustomerCalendar } from "../src/components/customer-workspaces/calendar.tsx";
import { CustomerAvailability } from "../src/components/customer-workspaces/availability.tsx";
import { OrderFinance } from "../src/components/customer-workspaces/order-finance.tsx";
import { InvitationSetup } from "../src/components/customer-workspaces/invitation.tsx";
import { SheetImport } from "../src/components/customer-workspaces/sheet-import.tsx";
const property = {
  id: "property-a",
  name: "Synthetic inn",
  kind: "mixed",
  rooms: ["101", "102", "103"].map((id) => ({ id, name: id })),
  villaRoomIds: ["101", "102", "103"],
  sourceMode: "native",
  pricing: {
    enabled: true,
    currency: "TWD",
    base: { 101: 1234 },
    overrides: [],
  },
};
const initial = {
  id: "workspace",
  slug: "synthetic-operations",
  name: "Synthetic group",
  version: 1,
  role: "owner",
  properties: [property],
  bookings: [],
  readiness: { [property.id]: { complete: true, unresolvedCount: 0 } },
};
const order = {
  id: "order-1",
  version: 1,
  propertyId: property.id,
  guestName: "Synthetic",
  roomIds: ["101"],
  checkIn: "2027-01-01",
  checkOut: "2027-01-03",
  total: 9000,
  expectedDeposit: 3000,
  payments: [],
  status: "confirmed",
  createdAt: "2026-10-01T12:00:00Z",
  entry: "os",
};
async function mount(t, component, props = {}, hash = "") {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://operations.test/" + hash,
  });
  const original = {};
  for (const key of [
    "window",
    "document",
    "location",
    "history",
    "FormData",
    "IS_REACT_ACT_ENVIRONMENT",
  ])
    original[key] = globalThis[key];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    FormData: dom.window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
    dom.window.close();
  });
  await act(() => root.render(createElement(component, props)));
  const button = (label) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === label,
    );
  const control = (label, parent = document) =>
    [...parent.querySelectorAll("label")]
      .find(
        (l) =>
          [...l.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent)
            .join("")
            .trim() === label,
      )
      ?.querySelector("input,textarea,select");
  const click = async (el) => {
    assert.ok(el, "control exists");
    assert.equal(el.disabled, false);
    await act(() => el.click());
  };
  const fill = async (el, value) => {
    assert.ok(el, "field exists");
    await act(() => {
      const proto =
        el.tagName === "SELECT"
          ? dom.window.HTMLSelectElement.prototype
          : el.tagName === "TEXTAREA"
            ? dom.window.HTMLTextAreaElement.prototype
            : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  return { dom, root, button, control, click, fill };
}
test("owner creates a second property and invites a cleaner only to selected properties; admin has no member controls", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (options.method === "POST") {
      const input = JSON.parse(options.body);
      calls.push(input);
      if (input.action === "property")
        return Response.json({
          propertyId: "property-b",
          workspace: {
            ...initial,
            version: 2,
            properties: [
              ...initial.properties,
              { ...property, id: "property-b", name: input.name },
            ],
          },
        });
      return Response.json({
        version: 3,
        members: [],
        invitations: [],
        delivery: "accepted",
      });
    }
    return Response.json({ version: 2, members: [], invitations: [] });
  });
  const { root, button, control, click, fill } = await mount(
    t,
    CustomerSettings,
    { initial },
  );
  await fill(control("旅宿名稱"), "Second synthetic inn");
  await fill(control("實體房間名稱（一行一間）"), "201\n202");
  await click(button("建立旅宿"));
  assert.equal(calls[0].mode, "sheet");
  assert.deepEqual(calls[0].rooms, ["201", "202"]);
  assert.match(document.body.textContent, /匯入此館訂單/);
  await click(button("協作成員"));
  await fill(control("成員 Email"), "cleaner@example.test");
  assert.equal(button("寄出七天有效的邀請").disabled, true);
  await click(control("Second synthetic inn"));
  await click(button("寄出七天有效的邀請"));
  assert.equal(calls[1].role, "viewer_no_price");
  assert.equal(calls[1].allProperties, false);
  assert.deepEqual(calls[1].propertyIds, ["property-b"]);
  assert.match(document.body.textContent, /寄信服務已接受/);
  await act(() =>
    root.render(
      createElement(CustomerSettings, {
        initial: { ...initial, role: "admin" },
        key: "admin",
      }),
    ),
  );
  assert.equal(button("協作成員"), undefined);
  assert.equal(button("建立旅宿"), undefined);
});
test("calendar sends multi-date room selections and a single deposit as one order", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const input = JSON.parse(options.body);
    calls.push(input);
    const booking = {
      ...order,
      ...input,
      id: "created-order",
      payments: input.payment
        ? [{ ...input.payment, id: "payment-1", actor: "owner" }]
        : [],
      checkIn: input.stays[0].checkIn,
      checkOut: input.stays.at(-1).checkOut,
    };
    return Response.json({
      bookingId: booking.id,
      workspace: { ...initial, version: 2, bookings: [booking] },
    });
  });
  const { button, control, click, fill } = await mount(t, CustomerCalendar, {
    initial,
  });
  await click(button("＋新增訂房"));
  await fill(control("入住日期"), "2027-01-05");
  for (const room of ["101", "102", "103"])
    await click(
      [...document.querySelectorAll("dialog button[aria-pressed]")].find(
        (b) => b.textContent.trim() === room,
      ),
    );
  await click(button("＋新增不同日期的住宿項目"));
  await fill(control("項目 2 入住日期"), "2027-01-08");
  await fill(control("項目 2 退房日期"), "2027-01-10");
  await click(
    control(
      "102",
      [...document.querySelectorAll("dialog fieldset")].find(
        (f) => f.querySelector("legend")?.textContent === "住宿項目 2",
      ),
    ),
  );
  await fill(control("整筆房費（全部房間、全部晚數合計）"), "9000");
  await fill(control("旅宿實際收款"), "deposit");
  await fill(control("實收金額"), "3000");
  await click(button("建立訂房"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stays.length, 2);
  assert.deepEqual(calls[0].stays[0].roomIds, ["101", "102", "103"]);
  assert.deepEqual(calls[0].stays[1].roomIds, ["102"]);
  assert.equal(calls[0].payment.amount, 3000);
  assert.match(document.body.textContent, /尚待收款/);
  assert.match(document.body.textContent, /6,000/);
});
test("lost payment response locks fields and retries the identical request without a new receipt key", async (t) => {
  const calls = [],
    saved = [];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) throw new Error("Synthetic lost response");
    return Response.json({
      workspace: {
        ...initial,
        version: 2,
        bookings: [
          {
            ...order,
            version: 2,
            payments: [
              {
                id: "one-receipt",
                amount: 3000,
                kind: "deposit",
                receivedAt: "2026-01-01T00:00:00Z",
                method: null,
              },
            ],
          },
        ],
      },
    });
  });
  const { button, control, click, fill } = await mount(t, OrderFinance, {
    data: { ...initial, bookings: [order] },
    booking: order,
    onSaved: (value) => saved.push(value),
  });
  await fill(control("本次實收金額"), "3000");
  await fill(control("實際收退款時間"), "2026-01-01T10:00");
  await click(button("保存並核對"));
  assert.equal(control("本次實收金額").closest("fieldset").disabled, true);
  assert.equal(saved.length, 0);
  await click(button("重試相同操作"));
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].bookings[0].payments.length, 1);
  assert.match(document.body.textContent, /已保存並重新核對/);
});
test("unsold list starts without prices, adds prices only on request, and no-price roles have no price control", async (t) => {
  const queries = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const query = new URL(String(url), "https://operations.test").searchParams;
    queries.push(query);
    const show = query.get("showPrices") === "true";
    return Response.json({
      property: { id: property.id, name: property.name },
      title: "Available",
      from: query.get("from"),
      to: query.get("to"),
      showPrices: show,
      rows: [
        {
          date: "2027-01-01",
          roomId: "101",
          roomName: "101",
          ...(show ? { amount: 1234 } : {}),
        },
      ],
      lists: [],
      verifiedAt: "2026-10-01T00:00:00Z",
      version: 1,
    });
  });
  const { root, control, click } = await mount(t, CustomerAvailability, {
    initial,
  });
  assert.equal(queries[0].get("showPrices"), "false");
  assert.equal(document.body.textContent.includes("NT$ 1,234"), false);
  await click([...document.querySelectorAll('input[type="checkbox"]')][0]);
  assert.equal(queries.at(-1).get("showPrices"), "true");
  assert.match(document.body.textContent, /1,234/);
  await act(() =>
    root.render(
      createElement(CustomerAvailability, {
        key: "restricted",
        initial: {
          ...initial,
          role: "viewer_no_price",
          properties: [{ ...property, pricing: undefined }],
        },
      }),
    ),
  );
  assert.equal(document.querySelector('input[type="checkbox"]'), null);
  assert.equal(queries.at(-1).get("showPrices"), "false");
  assert.equal(document.body.textContent.includes("1,234"), false);
  assert.equal(control("清單名稱"), undefined);
});
test("invitation strips its fragment and asks existing members for their current password", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const input = JSON.parse(options.body);
    calls.push(input);
    return input.action === "info"
      ? Response.json({
          email: "existing@example.test",
          workspace: "Synthetic",
          role: "管家",
          properties: ["A"],
          existingAccount: true,
          accepted: false,
        })
      : Response.json({ detail: "原密碼不正確" }, { status: 401 });
  });
  const { button, control, click, fill } = await mount(
    t,
    InvitationSetup,
    {},
    "#synthetic.token",
  );
  assert.equal(location.hash, "");
  assert.ok(control("目前密碼"));
  assert.equal(control("再次輸入密碼"), undefined);
  await fill(control("目前密碼"), "Synthetic wrong password");
  await click(button("確認加入，開啟日曆"));
  assert.equal(calls[1].token, "synthetic.token");
  assert.match(document.body.textContent, /原密碼不正確/);
  assert.match(document.body.textContent, /原本的旅宿與密碼會保留/);
});
test("format helper recognizes explicit totals and preserves source paid without a recipient question", async (t) => {
  const rows = [
    ["入住日期", "退房日期", "房號", "訂單總額", "已付"],
    ["2027-01-01", "2027-01-02", "101", "3000", "1000"],
  ];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const input = JSON.parse(options.body);
    return Response.json(
      input.action === "tabs"
        ? {
            spreadsheetId: "sheet",
            title: "Source",
            tabs: [{ id: 0, title: "Orders" }],
          }
        : { id: "source", title: "Orders", rows },
    );
  });
  const { button, control, click } = await mount(t, SheetImport, {
    slug: initial.slug,
    property,
    configured: true,
    connected: true,
    sharedUrl: "https://docs.google.com/spreadsheets/d/synthetic-sheet/edit",
    initialBatches: [],
    initialVersion: 1,
  });
  await click(button("讀取分頁"));
  await click(button("讀取資料"));
  await click(button("採用欄位與房間建議，再由我核對"));
  assert.equal(control("入住日期").value, "0");
  assert.equal(control("房費欄位的意思").value, "order");
  assert.equal(control("已付／實收欄位的意思"), undefined);
  assert.equal(control("累計已付／訂金（選填）").value, "4");
  assert.equal(button("產生匯入預覽").disabled, true);
  assert.match(document.body.textContent, /一列是一張完整訂單/);
});
