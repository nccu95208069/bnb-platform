import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { CalendarImport } from "../src/components/customer-workspaces/calendar-import.tsx";
import {
  calendarStatus,
  uploadCalendar,
  previewCalendar,
  commitCalendar,
  undoCalendar,
} from "../src/lib/customer-workspaces/calendar-import.ts";
import { fixture, range, ics, event } from "./helpers/calendar-fixture.mjs";
test("calendar wizard uploads, maps rooms, previews unknown finances, freezes uncertain writes, retries unchanged and undoes", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" }),
    globals = {
      window: globalThis.window,
      document: globalThis.document,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client"),
    root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    Object.assign(globalThis, globals);
    dom.window.close();
  });
  const f = fixture(),
    text = ics([event({ uid: "ui-booking", title: "客人：測試旅客" })]),
    source = await uploadCalendar(
      ...f.args,
      Buffer.from(text),
      "synthetic.ics",
      { ...range, kind: "ios_calendar" },
    );
  const commits = [];
  let loseReply = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("/upload?")) {
      assert.equal(
        new URL(url, "https://test.local").searchParams.get("kind"),
        "ios_calendar",
      );
      return Response.json(source);
    }
    const input = JSON.parse(options.body);
    let result;
    if (input.action === "preview")
      result = await previewCalendar(
        ...f.args,
        source.id,
        input.mapping,
        input.bindingId,
      );
    else if (input.action === "commit") {
      commits.push(input);
      result = await commitCalendar(...f.args, input);
      if (loseReply) {
        loseReply = false;
        throw Error("Synthetic lost reply after commit");
      }
    } else if (input.action === "status")
      result = await calendarStatus(...f.args);
    else if (input.action === "undo")
      result = await undoCalendar(...f.args, input);
    else throw Error(`Unexpected UI request ${input.action}`);
    return Response.json(result);
  });
  await act(() =>
    root.render(
      createElement(CalendarImport, {
        slug: f.workspace.slug,
        property: f.workspace.properties[0],
        initialKind: "ios_calendar",
        initialStatus: {
          version: 1,
          sources: [],
          batches: [],
          readiness: { complete: false, unresolvedCount: 1 },
        },
        configured: false,
        syncReady: false,
        connected: false,
      }),
    ),
  );
  const button = (text) =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === text,
      ),
    label = (text) =>
      [...document.querySelectorAll("label")].find(
        (l) =>
          l.textContent.trim() === text ||
          l.textContent.trim().startsWith(text),
      ),
    click = async (el) => {
      assert.ok(el);
      assert.equal(el.disabled, false);
      await act(() => el.click());
    };
  assert.match(document.body.textContent, /網頁無法直接讀取手機本機日曆/);
  assert.equal(button("連結 Google 帳號").disabled, true);
  const upload = document.querySelector('input[type="file"]');
  Object.defineProperty(upload, "files", {
    value: [
      new dom.window.File([text], "synthetic.ics", { type: "text/calendar" }),
    ],
    configurable: true,
  });
  await act(() =>
    upload.dispatchEvent(new dom.window.Event("change", { bubbles: true })),
  );
  await click(button("上傳並讀取"));
  await click(label("山景房").querySelector('input[type="checkbox"]'));
  await click(button("產生匯入預覽"));
  assert.match(document.body.textContent, /實收：待確認/);
  assert.match(document.body.textContent, /未知/);
  await click(label("我已核對房間").querySelector("input"));
  await click(label("這些日曆涵蓋本館").querySelector("input"));
  await click(button("確認匯入 1 筆並核對結果"));
  assert.equal((await f.current()).bookings.length, 1);
  assert.ok(button("重試並確認相同操作"));
  assert.equal(
    document.querySelector('input[type="radio"]').closest("fieldset").disabled,
    true,
  );
  await click(button("重試並確認相同操作"));
  assert.deepEqual(commits[1], commits[0]);
  assert.equal((await f.current()).bookings.length, 1);
  assert.match(document.body.textContent, /匯入已保存並核對/);
  await click(button("撤銷這批未修改的記錄"));
  assert.equal((await f.current()).bookings[0].status, "cancelled");
  assert.match(document.body.textContent, /已撤銷 1 筆/);
});
