import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { ServiceJoin } from "../src/components/customer-intake/service-join.tsx";
import { AccountSetup } from "../src/components/customer-workspaces/account-setup.tsx";
import { Onboarding } from "../src/components/customer-workspaces/onboarding.tsx";
async function mount(t, component, props = {}, hash = "") {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://service.test/join" + hash,
  });
  const original = {};
  for (const key of [
    "window",
    "document",
    "sessionStorage",
    "location",
    "history",
    "FormData",
    "IS_REACT_ACT_ENVIRONMENT",
  ])
    original[key] = globalThis[key];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    sessionStorage: dom.window.sessionStorage,
    location: dom.window.location,
    history: dom.window.history,
    FormData: dom.window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.scrollTo = function () {};
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
      const proto =
        el.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  return { dom, root, button, control, click, fill };
}
test("sharing check shows refusal and success, changing the URL invalidates success and ignores stale responses", async (t) => {
  let mode = "denied",
    resolvePending;
  t.mock.method(globalThis, "fetch", async () =>
    mode === "pending"
      ? new Promise((resolve) => {
          resolvePending = resolve;
        })
      : mode === "denied"
        ? Response.json({ detail: "尚未分享" }, { status: 400 })
        : Response.json({ readable: true }),
  );
  const { button, control, click, fill } = await mount(t, ServiceJoin, {
    enabled: true,
    workflowEnabled: true,
    shareEmail: "reader@synthetic.iam.gserviceaccount.com",
    contactEmail: "operator@example.test",
  });
  await click(button("申請使用"));
  await fill(control("旅宿名稱"), "Synthetic");
  await click(
    [...document.querySelectorAll("button[aria-pressed]")].find((b) =>
      b.textContent.startsWith("散客（分房出租）"),
    ),
  );
  await click(button("下一步：房間"));
  await fill(control("房號或房間名稱"), "101");
  await click(button("下一步：目前的資料"));
  await click(button("是，我用 Google Sheet"));
  const url =
    "https://docs.google.com/spreadsheets/d/synthetic-sheet-000000000/edit";
  await fill(control("Google Sheet 連結"), url);
  assert.equal(button("下一步：聯絡資料").disabled, true);
  await click(button("檢查分享權限"));
  assert.match(document.body.textContent, /尚未分享/);
  assert.ok(document.querySelector(".lucide-circle-x"));
  assert.equal(button("下一步：聯絡資料").disabled, true);
  mode = "accepted";
  await click(button("檢查分享權限"));
  assert.equal(button("下一步：聯絡資料").disabled, false);
  assert.ok(document.querySelector(".lucide-circle-check"));
  await fill(control("Google Sheet 連結"), url + "?changed=1");
  assert.equal(button("下一步：聯絡資料").disabled, true);
  mode = "pending";
  await click(button("檢查分享權限"));
  await fill(control("Google Sheet 連結"), url + "?changed=2");
  await act(() => resolvePending(Response.json({ readable: true })));
  assert.equal(button("下一步：聯絡資料").disabled, true);
  assert.match(document.body.textContent, /尚未檢查/);
});
test("account setup removes the token from URL and keeps errors visible without claiming activation", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return body.action === "info"
      ? Response.json({ email: "customer@example.test", purpose: "onboarding" })
      : Response.json({ detail: "連結已過期，請重新取得" }, { status: 400 });
  });
  const { button, control, click, fill } = await mount(
    t,
    AccountSetup,
    {},
    "#synthetic-token",
  );
  assert.equal(location.hash, "");
  assert.equal(calls[0].token, "synthetic-token");
  await fill(control("新密碼"), "synthetic passphrase 99");
  await fill(control("再次輸入密碼"), "synthetic passphrase 99");
  await click(button("確認並繼續"));
  assert.equal(calls[1].action, "activate");
  assert.match(
    document.querySelector("[role=alert]").textContent,
    /連結已過期/,
  );
  assert.ok(button("確認並繼續"));
});
test("password recovery uses a generic response and has no public registration option", async (t) => {
  let submitted;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options?.body)
      return Response.json({ detail: "登入" }, { status: 401 });
    submitted = JSON.parse(options.body);
    return Response.json({
      ok: true,
      detail: "如果這個信箱已有帳號，我們會寄出密碼重設連結。",
    });
  });
  const { button, control, click, fill } = await mount(t, Onboarding);
  assert.equal(button("建立帳號"), undefined);
  await click(button("忘記密碼"));
  assert.equal(document.querySelector("input[type=password]"), null);
  await fill(control("Email"), "customer@example.test");
  await click(button("寄送重設密碼連結"));
  assert.equal(submitted.action, "recover");
  assert.match(
    document.querySelector("[role=status]").textContent,
    /如果這個信箱已有帳號/,
  );
});
