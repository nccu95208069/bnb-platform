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
  await click(button("讀取分頁"));
  await click(button("讀取資料"));
  let selects = document.querySelectorAll("select");
  await input(selects[2], "0");
  await input(selects[3], "1");
  await input(selects[4], "2");
  const firstRoomGroup = [...document.querySelectorAll("fieldset")].find((f) =>
    f.querySelector("legend")?.textContent.startsWith("來源「villa」"),
  );
  await click(firstRoomGroup.querySelectorAll("input")[0]);
  await click(firstRoomGroup.querySelectorAll("input")[1]);
  const confirmation = [
    ...document.querySelectorAll("input[type=checkbox]"),
  ].at(-1);
  await click(confirmation);
  await click(button("產生匯入預覽"));
  assert.deepEqual(previewBody.mapping.roomMap.villa, ["101", "102"]);
  assert.equal(previewBody.mapping.columns.checkIn, 0);
  assert.equal(
    document.querySelector('[aria-label="匯入第 4 列"]').disabled,
    true,
  );
  await click(document.querySelector('[aria-label="匯入第 3 列"]'));
  await click(button("確認匯入 1 筆"));
  assert.ok(button("重試相同匯入"));
  assert.equal(
    document.querySelector('[aria-label="匯入第 2 列"]').disabled,
    true,
  );
  await click(button("重試相同匯入"));
  assert.deepEqual(commits[0], commits[1]);
  assert.deepEqual(commits[1].selected, [2]);
  assert.match(document.body.textContent, /已匯入 1 筆訂房/);
  await click(button("撤回此批匯入"));
  assert.match(document.body.textContent, /已撤回 1 筆，保留 0 筆/);
});
