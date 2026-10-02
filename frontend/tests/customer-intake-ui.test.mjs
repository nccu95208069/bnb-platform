import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { ServiceJoin } from "../src/components/customer-intake/service-join.tsx";
test("join questionnaire branches into Sheet sharing and optional consultation; non-Sheet gets assisted entry; uncertain send restores after reload", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://service.test",
  });
  const globals = {
    window: globalThis.window,
    document: globalThis.document,
    sessionStorage: globalThis.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    sessionStorage: dom.window.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const { createRoot } = await import("react-dom/client");
  let root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    Object.assign(globalThis, globals);
    dom.window.close();
  });
  const props = {
    enabled: true,
    shareEmail: "nccu95208069@gmail.com",
    contactEmail: "nccu95208069@gmail.com",
  };
  await act(() => root.render(createElement(ServiceJoin, props)));
  const button = (label) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === label,
    );
  const control = (label) =>
    [...document.querySelectorAll("label")]
      .find((l) => l.firstChild?.textContent === label)
      ?.querySelector("input,textarea");
  const click = async (el) => {
    assert.ok(el);
    assert.equal(el.disabled, false);
    await act(() => el.click());
  };
  const fill = async (el, value) => {
    assert.ok(el);
    await act(() => {
      const p =
        el.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(p, "value").set.call(el, value);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  // The public demo selects a real illustrated order; it must never submit intake.
  await click(button("單房"));
  await click(
    document.querySelector('button[aria-label="查看庭院房示範訂房"]'),
  );
  assert.match(
    document.querySelector(".service-order-detail").textContent,
    /庭院房入住/,
  );
  assert.match(
    document.querySelector(".service-order-detail").textContent,
    /5,600/,
  );
  await click(button("混合經營"));
  await click(
    document.querySelector('button[aria-label="查看包棟之後的山景房示範訂房"]'),
  );
  assert.match(
    document.querySelector(".service-order-detail").textContent,
    /山景房入住/,
  );
  assert.match(
    document.querySelector(".service-order-detail").textContent,
    /6,000/,
  );
  await click(button("我想加入使用"));
  await fill(control("旅宿名稱"), "Synthetic Inn");
  await click(
    [...document.querySelectorAll("button[aria-pressed]")].find((b) =>
      b.textContent.startsWith("單房"),
    ),
  );
  await click(button("下一步：房間"));
  await fill(control("房號或房間名稱"), "101\n102");
  await click(button("下一步：目前的資料"));
  await click(button("是，我用 Google Sheet"));
  assert.equal(button("填寫聯絡方式，送出加入申請").disabled, true);
  await fill(
    control("Google Sheet 連結"),
    "https://docs.google.com/spreadsheets/d/synthetic-spreadsheet-0000/edit",
  );
  assert.match(document.body.textContent, /檢視者/);
  assert.match(document.body.textContent, /受限制/);
  await click(document.querySelector("input[type=checkbox]"));
  assert.equal(button("填寫聯絡方式，送出加入申請").disabled, false);
  await click(button("不是／我不確定"));
  assert.equal(button("填寫聯絡方式，送出加入申請"), undefined);
  await fill(control("目前怎麼記錄？（選填）"), "紙本月曆");
  await click(button("請專人協助我開始"));
  await fill(control("怎麼稱呼你？"), "Synthetic Owner");
  await fill(control("Email"), "owner@example.test");
  await click(document.querySelector("dialog input[type=checkbox]"));
  const sends = [];
  let fail = true;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sends.push(JSON.parse(options.body));
    if (fail) {
      fail = false;
      throw Error("lost reply");
    }
    return Response.json({
      id: sends[0].requestKey,
      saved: true,
      status: "awaiting_review",
      notification: "accepted",
    });
  });
  await click(button("送出專人諮詢"));
  assert.ok(button("重試相同需求"));
  assert.equal(document.querySelector("dialog fieldset").disabled, true);
  assert.ok(sessionStorage.getItem("bnb-intake-pending-v1"));
  await act(() => root.unmount());
  root = createRoot(document.getElementById("root"));
  await act(() => root.render(createElement(ServiceJoin, props)));
  assert.ok(button("重試相同需求"));
  await click(button("重試相同需求"));
  assert.deepEqual(sends[1], sends[0]);
  assert.equal(sends[0].intent, "consultation");
  assert.deepEqual(sends[0].rooms, ["101", "102"]);
  assert.equal(sends[0].source, "other");
  assert.equal(sends[0].sourceDescription, "紙本月曆");
  assert.equal(sessionStorage.getItem("bnb-intake-pending-v1"), null);
  assert.match(document.body.textContent, /需求已收到/);
  assert.match(document.body.textContent, /通知信已交由寄信服務/);
});
