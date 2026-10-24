import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { SheetImport } from "../src/components/customer-workspaces/sheet-import.tsx";
test("Sheet wizard maps columns, quarantines rows, preserves selection after lost reply, retries same payload and reports safe undo", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" });
  const globals = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    Object.assign(globalThis, globals);
    dom.window.close();
  });
  const source = {
    id: "source-id",
    title: "Synthetic",
    rows: [
      ["In", "Out", "Room"],
      ["2026-10-03", "2026-10-05", "villa"],
      ["2026-10-06", "2026-10-07", "villa"],
      ["2026-10-08", "2026-10-09", "unmapped"],
    ],
  };
  const draft = {
    checkIn: "2026-10-03",
    checkOut: "2026-10-05",
    roomIds: ["101", "102"],
    total: null,
    guestName: null,
  };
  const commits = [];
  let previewBody;
  let fail = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "GET") return Response.json({ version: 2 });
    const body = JSON.parse(options.body);
    if (body.action === "tabs")
      return Response.json({
        spreadsheetId: "sheet",
        title: "Synthetic",
        tabs: [{ id: 0, title: "Reservations" }],
      });
    if (body.action === "read") return Response.json(source);
    if (body.action === "preview") {
      previewBody = body;
      return Response.json({
        id: "preview-id",
        rows: [
          { row: 2, draft, issues: [] },
          { row: 3, draft, issues: [] },
          { row: 4, draft: null, issues: ["房間尚未對應"] },
        ],
      });
    }
    if (body.action === "commit") {
      commits.push(body);
      if (fail) {
        fail = false;
        throw Error("lost reply");
      }
      return Response.json({
        id: "preview-id",
        bookingIds: ["booking-id"],
        sourceTitle: "Synthetic",
        createdAt: "2026-10-02T00:00:00Z",
      });
    }
    if (body.action === "undo")
      return Response.json({ cancelled: ["booking-id"], skipped: [] });
    throw Error("unexpected request");
  });
  dom.window.confirm = () => true;
  await act(() =>
    root.render(
      createElement(SheetImport, {
        slug: "test-inn",
        property: {
          id: "property",
          name: "Synthetic",
          rooms: [
            { id: "101", name: "101" },
            { id: "102", name: "102" },
          ],
        },
        configured: true,
        connected: true,
        initialBatches: [],
        initialVersion: 1,
      }),
    ),
  );
  const button = (name) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === name,
    );
  const click = async (el) => {
    assert.ok(el);
    assert.equal(el.disabled, false);
    await act(() => el.click());
  };
  const input = async (el, value) => {
    await act(() => {
      const proto =
        el.tagName === "SELECT"
          ? dom.window.HTMLSelectElement.prototype
          : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  await input(
    document.querySelector("input"),
    "https://docs.google.com/spreadsheets/d/synthetic-id",
  );
  await click(button("檢查並匯入訂房 →"));
  assert.equal(document.body.textContent.includes("有幾項資料需要你確認"), true);
  await click(button("確認欄位與房間"));
  const mappedSelect = (label) => [...document.querySelectorAll("label")]
    .find((item) => item.textContent.trim().startsWith(label) && item.querySelector("select"))?.querySelector("select");
  await input(mappedSelect("入住日期"), "0");
  await input(mappedSelect("退房日期"), "1");
  await input(mappedSelect("房間／包棟"), "2");
  const firstRoomGroup = [...document.querySelectorAll("fieldset")].find((f) =>
    f.querySelector("legend")?.textContent.startsWith("來源「villa」"),
  );
  await click(firstRoomGroup.querySelectorAll("input")[0]);
  await click(firstRoomGroup.querySelectorAll("input")[1]);
  await input([...document.querySelectorAll('input[type="date"]')].at(-1), "2026-12-31");
  const coverageCheck = [...document.querySelectorAll("label")].find((label) =>
    label.textContent.includes("這是一次匯入快照"),
  )?.querySelector('input[type="checkbox"]');
  await click(coverageCheck);
  const confirmation = [
    ...document.querySelectorAll("input[type=checkbox]"),
  ].at(-1);
  await click(confirmation);
  await click(button("產生匯入預覽"));
  assert.deepEqual(previewBody.mapping.roomMap.villa, ["101", "102"]);
  assert.equal(previewBody.mapping.columns.checkIn, 0);
  assert.equal(previewBody.mapping.coverageTo, "2026-12-31");
  assert.equal(previewBody.mapping.coverageConfirmed, true);
  assert.equal(previewBody.mapping.from, "2000-01-01");
  assert.ok(previewBody.mapping.coverageFrom > "2000-01-01");
  assert.equal(
    document.querySelector('[aria-label="匯入第 4 列"]').disabled,
    true,
  );
  await click(button("顯示所有已檢查訂房"));
  await click(document.querySelector('[aria-label="匯入第 3 列"]'));
  await click(button("匯入 1 筆並查看日曆 →"));
  assert.ok(button("重試相同匯入"));
  assert.equal(
    document.querySelector('[aria-label="匯入第 2 列"]').disabled,
    true,
  );
  await click(button("重試相同匯入"));
  assert.deepEqual(commits[0], commits[1]);
  assert.deepEqual(commits[1].selected, [2]);
  assert.match(document.body.textContent, /已匯入 1 筆訂房/);
  assert.match(window.location.pathname, /\/w\/test-inn\/calendar/);
  await click(button("撤回此批匯入"));
  assert.match(document.body.textContent, /已撤回 1 筆，保留 0 筆/);
});

test("a clean shared Sheet imports from one click and opens the calendar", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" });
  const globals = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    Object.assign(globalThis, globals);
    dom.window.close();
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "GET") return Response.json({ version: 3 });
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.action === "bind") return Response.json({ status: "approved", url: body.url, version: 2 });
    if (body.action === "tabs") return Response.json({
      spreadsheetId: "synthetic-sheet", title: "Synthetic Sheet",
      tabs: [{ id: 1, title: "Other" }, { id: 7, title: "工作表1" }],
    });
    if (body.action === "read") return Response.json({
      id: "synthetic-source", title: "工作表1",
      rows: [
        ["房型", "預定人姓名", "預定平台", "入住日期", "退房日期", "預訂日期", "房費", "全額支付狀態", "檢查狀態", "唯一ID", "備註", "訂單編號"],
        ["101", "Sample", "Direct", "2027-01-01", "2027-01-02", "2026-12-01", "2500", "", "", "row-1", "", "order-1"],
        ["101", "Sample", "Direct", "2027-01-02", "2027-01-03", "2026-12-01", "2500", "", "", "row-2", "", "order-1"],
      ],
    });
    if (body.action === "preview") return Response.json({
      id: "synthetic-preview", rows: [{ row: 2, draft: {
        guestName: "Sample", externalId: "order-1", total: 5000,
        roomIds: ["room-101"], checkIn: "2027-01-01", checkOut: "2027-01-03",
      }, issues: [], sourceRows: [2, 3] }],
    });
    if (body.action === "commit") return Response.json({
      id: "synthetic-preview", propertyId: "property", bookingIds: ["booking-1"],
      sourceTitle: "工作表1", createdAt: "2026-10-20T00:00:00Z",
    });
    throw Error(`unexpected action ${body.action}`);
  });
  await act(() => root.render(createElement(SheetImport, {
    slug: "synthetic", property: { id: "property", name: "Test", kind: "rooms",
      villaRoomIds: [], rooms: [{ id: "room-101", name: "101" }] },
    configured: true, connected: false, initialBatches: [], initialVersion: 1,
    shareEmail: "viewer@example.test",
  })));
  assert.match(document.body.textContent, /「檢視者」權限/);
  assert.equal(document.body.textContent.includes("標題在第幾列"), false);
  const url = document.querySelector('input[placeholder^="https://docs.google.com"]');
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(
      url, "https://docs.google.com/spreadsheets/d/synthetic-sheet/edit#gid=7",
    );
    url.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const mode = [...document.querySelectorAll("label")].find((label) =>
    label.textContent.includes("來源紀錄方式"),
  ).querySelector("select");
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set.call(mode, "stay");
    mode.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await act(() => [...document.querySelectorAll("button")].find((button) =>
    button.textContent === "檢查並匯入訂房 →",
  ).click());
  assert.deepEqual(calls.map((call) => call.action), ["bind", "tabs", "read", "preview", "commit"]);
  assert.equal(calls[2].sheetId, 7);
  assert.equal(calls[3].mapping.granularity, "stay");
  assert.equal(calls[3].mapping.amountBasis, "line");
  assert.equal(calls[3].mapping.columns.guestName, 1);
  assert.equal(calls[3].mapping.columns.platform, 2);
  assert.equal(calls[3].mapping.columns.externalId, 11);
  assert.deepEqual(calls[3].mapping.roomMap["101"], ["room-101"]);
  assert.deepEqual(calls[4].selected, [2]);
  assert.match(window.location.pathname, /\/w\/synthetic\/calendar/);
  assert.match(document.body.textContent, /訂房已在日曆裡/);
});

test("unmatched source rooms stop automatic preview and ask for room review", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" });
  const globals = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    Object.assign(globalThis, globals);
    dom.window.close();
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.action);
    if (body.action === "tabs") return Response.json({
      spreadsheetId: "synthetic-sheet", title: "Synthetic Sheet",
      tabs: [{ id: 0, title: "工作表1" }],
    });
    if (body.action === "read") return Response.json({
      id: "source", title: "工作表1", rows: [
        ["房型", "預定人姓名", "預定平台", "入住日期", "退房日期", "預訂日期", "房費", "全額支付狀態", "檢查狀態", "唯一ID", "備註", "訂單編號"],
        ["102", "Sample", "Direct", "2027-01-01", "2027-01-02", "2026-12-01", "2500", "", "", "row-1", "", "order-1"],
      ],
    });
    throw Error(`unexpected action ${body.action}`);
  });
  await act(() => root.render(createElement(SheetImport, {
    slug: "synthetic", property: { id: "property", name: "Test", kind: "rooms",
      villaRoomIds: [], rooms: [{ id: "room-101", name: "101" }] },
    configured: true, connected: true, initialBatches: [], initialVersion: 1,
    sharedUrl: "https://docs.google.com/spreadsheets/d/synthetic-sheet/edit",
  })));
  await act(() => [...document.querySelectorAll("button")].find((button) =>
    button.textContent === "檢查並匯入訂房 →",
  ).click());
  assert.deepEqual(calls, ["tabs", "read"]);
  assert.match(document.body.textContent, /表格中的「102」還不知道對應哪個房間/);
  assert.equal(document.body.textContent.includes("重新檢查資料"), false);
  assert.ok([...document.querySelectorAll("button")].some((button) =>
    button.textContent === "確認欄位與房間",
  ));
});

test("approved first onboarding previews the entire Sheet and selects unique-ID history rows", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" });
  const globals = { window: globalThis.window, document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    Object.assign(globalThis, globals);
    dom.window.close();
  });
  const calls = [];
  let previewBody;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.action);
    if (body.action === "tabs") return Response.json({ spreadsheetId: "synthetic-sheet",
      title: "Synthetic", tabs: [{ id: 0, title: "工作表1" }] });
    if (body.action === "read") return Response.json({ id: "source", title: "工作表1", rows: [
      ["房型", "預定人姓名", "預定平台", "入住日期", "退房日期", "預訂日期", "房費", "全額支付狀態", "檢查狀態", "唯一ID", "備註", "訂單編號"],
      ["101", "Past Guest", "Direct", "2025-10-01", "2025-10-02", "2025-09-01", "2064", "", "", "row-1", "", ""],
      ["101", "Future Guest", "Direct", "2027-01-01", "2027-01-02", "2026-12-01", "2500", "", "", "row-2", "", ""],
    ] });
    if (body.action === "preview") {
      previewBody = body;
      return Response.json({ id: "preview", rows: [
        { row: 2, sourceRows: [2], draft: { guestName: "Past Guest", checkIn: "2025-10-01", checkOut: "2025-10-02", roomIds: ["room-101"], externalId: "source-row:row-1", total: 2064 }, issues: [] },
        { row: 3, sourceRows: [3], draft: { guestName: "Future Guest", checkIn: "2027-01-01", checkOut: "2027-01-02", roomIds: ["room-101"], externalId: "source-row:row-2", total: 2500 }, issues: [] },
      ] });
    }
    throw Error(`unexpected action ${body.action}`);
  });
  await act(() => root.render(createElement(SheetImport, {
    slug: "synthetic", property: { id: "property", name: "Test", kind: "rooms",
      villaRoomIds: [], rooms: [{ id: "room-101", name: "101" }] },
    configured: true, connected: false, initialBatches: [], initialVersion: 1,
    sharedUrl: "https://docs.google.com/spreadsheets/d/synthetic-sheet/edit",
    autoPreview: true,
  })));
  assert.deepEqual(calls, ["tabs", "read", "preview"]);
  assert.equal(previewBody.mapping.from, "2000-01-01");
  assert.equal(previewBody.mapping.granularity, "stay");
  assert.equal(previewBody.mapping.missingOrderId, "source-row");
  assert.equal(previewBody.mapping.columns.sourceRowId, 9);
  assert.equal(document.body.textContent.includes("貼上資料來源"), false);
  assert.match(document.body.textContent, /Past Guest/);
  assert.match(document.body.textContent, /Future Guest/);
  assert.match(document.body.textContent, /2筆可匯入/);
  assert.equal(document.querySelector('details:has(summary)')?.open ?? false, false);
  assert.equal(document.body.textContent.includes("未填姓名"), false);
  assert.equal(calls.includes("commit"), false);
});

test("ambiguous money columns ask for review instead of silently importing without prices", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" });
  const previous = { window: globalThis.window, document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => { await act(() => root.unmount()); Object.assign(globalThis, previous); dom.window.close(); });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const input = JSON.parse(options.body);
    calls.push(input.action);
    if (input.action === "tabs") return Response.json({ spreadsheetId: "sheet", title: "Test", tabs: [{ id: 0, title: "工作表1" }] });
    if (input.action === "read") return Response.json({ id: "source", title: "Test", rows: [
      ["入住日期", "退房日期", "房間", "房費"],
      ["2026-10-21", "2026-10-22", "101", "2500"],
    ] });
    throw Error(`unexpected ${input.action}`);
  });
  await act(() => root.render(createElement(SheetImport, { slug: "test", property: {
    id: "property", name: "Test", kind: "rooms", villaRoomIds: [], rooms: [{ id: "room-101", name: "101" }],
  }, configured: true, connected: true, sharedUrl: "https://docs.google.com/spreadsheets/d/sheet/edit",
  initialBatches: [], initialVersion: 1 })));
  await act(() => [...document.querySelectorAll("button")].find((item) => item.textContent === "檢查並匯入訂房 →").click());
  assert.deepEqual(calls, ["tabs", "read"]);
  assert.match(document.body.textContent, /請在下方指定房費欄/);
  assert.match(document.body.textContent, /有幾項資料需要你確認/);
});

test("returning after an import opens a simple calendar handoff", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" });
  const previous = { window: globalThis.window, document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => { await act(() => root.unmount()); Object.assign(globalThis, previous); dom.window.close(); });
  await act(() => root.render(createElement(SheetImport, { slug: "test", property: {
    id: "property", name: "Test", rooms: [],
  }, configured: true, connected: true, initialVersion: 2,
  initialBatches: [{ id: "batch", propertyId: "property", sourceTitle: "測試訂房表", bookingIds: ["order-1"], createdAt: "2026-10-20T00:00:00Z" }],
  })));
  assert.match(document.body.textContent, /訂房已在日曆裡/);
  assert.equal(document.querySelector('a[href="/w/test/calendar?property=property"]').textContent.includes("查看房況日曆"), true);
  assert.equal(document.querySelector('button')?.textContent === "檢查並匯入訂房 →", false);
});
