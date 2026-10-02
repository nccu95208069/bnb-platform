import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement, useCallback, useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { serviceTheme } from "../src/lib/customer-intake/theme.ts";
import { ServiceJoin } from "../src/components/customer-intake/service-join.tsx";
test("join questionnaire branches into Sheet sharing and optional consultation; non-Sheet gets assisted entry; uncertain send restores after reload", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://service.test/join",
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
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.scrollTo = function () {};
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
  function Harness() {
    const [contactPage, setContactPage] = useState(
      window.location.pathname === "/join/contact",
    );
    useEffect(() => {
      const pop = () =>
        setContactPage(window.location.pathname === "/join/contact");
      window.addEventListener("popstate", pop);
      return () => window.removeEventListener("popstate", pop);
    }, []);
    const open = useCallback(() => {
      window.history.pushState({}, "", "/join/contact");
      setContactPage(true);
    }, []);
    const back = useCallback(() => {
      window.history.pushState({}, "", "/join");
      setContactPage(false);
    }, []);
    return createElement(ServiceJoin, {
      ...props,
      initialTheme: serviceTheme(document.cookie.match(/bnb-service-theme-v1=([^;]+)/)?.[1]),
      contactPage,
      onOpenContact: open,
      onRestoreContact: open,
      onBack: back,
    });
  }
  await act(() => root.render(createElement(Harness)));
  const themeSelect = () => document.querySelector('select[aria-label="外觀模式"]');
  assert.equal(document.querySelector("main").dataset.theme, "system");
  for (const mode of ["dark", "light", "system", "dark"]) {
    await act(() => {
      themeSelect().value = mode;
      themeSelect().dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(document.querySelector("main").dataset.theme, mode);
    assert.ok(document.cookie.includes(`bnb-service-theme-v1=${mode}`));
  }
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
  await click(button("申請使用"));
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
  assert.equal(button("下一步：聯絡資料").disabled, true);
  await fill(
    control("Google Sheet 連結"),
    "https://docs.google.com/spreadsheets/d/synthetic-spreadsheet-0000/edit",
  );
  assert.match(document.body.textContent, /檢視者/);
  assert.match(document.body.textContent, /受限制/);
  await click(document.querySelector("input[type=checkbox]"));
  assert.equal(button("下一步：聯絡資料").disabled, false);
  await click(button("不是／我不確定"));
  assert.equal(button("下一步：聯絡資料"), undefined);
  await fill(control("目前使用的記錄工具（選填）"), "紙本月曆");
  await click(button("諮詢導入方式"));
  assert.equal(window.location.pathname, "/join/contact");
  assert.equal(document.querySelector("main").dataset.theme, "dark");
  assert.equal(document.querySelector("dialog"), null);
  assert.equal(document.querySelector(".service-hero"), null);
  assert.match(document.querySelector("h1").textContent, /專人諮詢/);
  await click(button("返回問卷"));
  assert.equal(control("目前使用的記錄工具（選填）").value, "紙本月曆");
  await click(button("諮詢導入方式"));
  await fill(control("聯絡人姓名"), "Synthetic Owner");
  await fill(control("Email"), "owner@example.test");
  await click(document.querySelector(".service-contact input[type=checkbox]"));
  // Refresh on the contact route restores both the questionnaire and unsent contact draft.
  await act(() => root.unmount());
  root = createRoot(document.getElementById("root"));
  await act(() => root.render(createElement(Harness)));
  assert.equal(document.querySelector("main").dataset.theme, "dark");
  assert.equal(control("聯絡人姓名").value, "Synthetic Owner");
  assert.equal(control("Email").value, "owner@example.test");
  assert.match(
    document.querySelector(".service-contact-context").textContent,
    /Synthetic Inn/,
  );
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
  assert.equal(
    document.querySelector(".service-contact fieldset").disabled,
    true,
  );
  assert.ok(sessionStorage.getItem("bnb-intake-pending-v1"));
  // Browser Back may leave a pending request: the questionnaire stays frozen until retry.
  await act(() => {
    window.history.pushState({}, "", "/join");
    window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  });
  assert.equal(
    document.querySelector("#join-questions > fieldset").disabled,
    true,
  );
  await click(button("專人諮詢"));
  assert.ok(button("重試相同需求"));
  await act(() => root.unmount());
  root = createRoot(document.getElementById("root"));
  await act(() => root.render(createElement(Harness)));
  assert.ok(button("重試相同需求"));
  await click(button("重試相同需求"));
  assert.deepEqual(sends[1], sends[0]);
  assert.equal(sends[0].intent, "consultation");
  assert.deepEqual(sends[0].rooms, ["101", "102"]);
  assert.equal(sends[0].source, "other");
  assert.equal(sends[0].sourceDescription, "紙本月曆");
  assert.equal(sessionStorage.getItem("bnb-intake-pending-v1"), null);
  assert.equal(sessionStorage.getItem("bnb-intake-draft-v1"), null);
  assert.match(document.body.textContent, /需求已收到/);
  assert.ok(themeSelect());
  assert.match(document.body.textContent, /通知信已交由寄信服務/);
});

test("direct contact entry is a full document section with one heading and no overlay", () => {
  const html = renderToStaticMarkup(
    createElement(ServiceJoin, {
      enabled: true,
      contactPage: true,
      initialTheme: "dark",
      shareEmail: "operator@example.test",
      contactEmail: "operator@example.test",
    }),
  );
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /value="dark" selected=""/);
  assert.equal((html.match(/<h1/g) || []).length, 1);
  assert.match(html, /專人諮詢/);
  assert.match(html, /返回服務頁/);
  assert.doesNotMatch(html, /<dialog|service-hero|backdrop/);
});
