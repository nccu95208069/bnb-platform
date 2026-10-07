import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { StandardSheetPanel } from "../src/components/customer-workspaces/standard-sheet.tsx";
test("standard ledger UI reports pending writes and retries the original binding after a lost response", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" });
  const previous = {
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
    Object.assign(globalThis, previous);
    dom.window.close();
  });
  let status = {
    state: "unlinked",
    workspaceVersion: 2,
    configured: true,
    canCreate: false,
    writerEmail: "writer@synthetic.iam.gserviceaccount.com",
  };
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "GET") return Response.json(status);
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) {
      status = {
        ...status,
        state: "pending",
        url: "https://docs.google.com/spreadsheets/d/synthetic-destination-0001/edit",
      };
      throw Error("reply lost");
    }
    return Response.json({ ...status, state: "synced", exportedVersion: 2 });
  });
  await act(() =>
    root.render(createElement(StandardSheetPanel, { slug: "demo" })),
  );
  const input = document.querySelector("input[type=url]");
  await act(() => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    ).set.call(
      input,
      "https://docs.google.com/spreadsheets/d/synthetic-destination-0001/edit",
    );
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const button = (text) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    );
  await act(() => button("連結並寫入標準帳本").click());
  assert.match(
    document.querySelector('[role="status"]').textContent,
    /尚待更新/,
  );
  assert.equal(button("更新並核對帳本").disabled, true);
  await act(() => button("重試相同帳本操作").click());
  assert.deepEqual(sent[1], sent[0]);
  assert.match(
    document.querySelector('[role="status"]').textContent,
    /已讀回核對/,
  );
  assert.equal(button("重試相同帳本操作"), undefined);
});
