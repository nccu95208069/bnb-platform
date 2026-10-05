import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { AnalysisDashboard } from "../../src/components/order-health/analysis-dashboard.tsx";
import { tablesFromMatrices } from "../../src/lib/order-health/parser.ts";
import { analyze } from "../../src/lib/order-health/engine.ts";

function fixture() {
  return analyze({
    id: "synthetic-dashboard", sourceHash: "synthetic-dashboard", sourceTitle: "合成資料", receptionKind: "villa",
    answers: { unit: "night", money: "total", booked: "yes" },
    tables: tablesFromMatrices([{ title: "合成訂單", matrix: [
      ["訂單編號", "入住日期", "退房日期", "金額", "平台", "狀態", "預訂日期"],
      ["", "2026-09-30", "2026-10-01", "3000", "官網", "已確認", "2026-08-01"],
      ["", "2026-10-01", "2026-10-02", "4000", "官網", "已確認", "2026-08-01"],
      ["known", "2026-10-02", "2026-10-03", "5000", "官網", "已確認", "2026-10-01"],
    ] }]),
  }, new Date("2026-10-05T09:00:00Z"));
}
async function mount(t) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://synthetic.test/revenue" });
  const originals = {};
  for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) originals[key] = globalThis[key];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const report = fixture();
  await act(() => root.render(createElement(AnalysisDashboard, { report })));
  t.after(async () => { await act(() => root.unmount()); Object.assign(globalThis, originals); dom.window.close(); });
  return {
    dom, root, report,
    click: async (element) => { assert.ok(element); await act(() => element.click()); },
    nav: () => document.querySelector('[aria-label="每日圖表月份切換"]'),
  };
}

test("monthly card uses confirmed nights instead of a misleading zero order count", async (t) => {
  await mount(t);
  assert.ok(!document.body.textContent.includes("至少 0 筆"));
  const card = document.querySelector('.monthCard[aria-pressed="true"]');
  assert.equal(card.querySelector("strong").textContent, "2 晚");
  assert.match(card.textContent, /已識別 1 筆，完整筆數待確認/);
  assert.match(card.textContent, /NT\$ 9,000/);
});

test("chart changes previous and next month without returning to the cards", async (t) => {
  const { click, nav } = await mount(t);
  await click(nav().querySelector('[aria-label="查看上一個月"]'));
  assert.equal(nav().querySelector("input").value, "2026-09");
  assert.match(nav().parentElement.querySelector("h3").textContent, /2026\/09/);
  assert.equal(document.querySelector('.monthCard[aria-pressed="true"] > span').textContent, "2026/09 月");
  const monthChart = nav().closest('.monthDetail').querySelector('.barPlot');
  assert.ok(monthChart.querySelector('button[aria-label^="09/30"]'));
  assert.equal(monthChart.querySelector('button[aria-label^="10/01"]'), null);
  await click(nav().querySelector('[aria-label="查看下一個月"]'));
  assert.equal(nav().querySelector("input").value, "2026-10");
});

test("background report rerenders do not force the month carousel back to October", async (t) => {
  const { root, report } = await mount(t);
  const rail = document.querySelector('.monthCards');
  rail.scrollLeft = 317;
  await act(() => root.render(createElement(AnalysisDashboard, { report: structuredClone(report) })));
  assert.equal(rail.scrollLeft, 317);
});

test("future booking dates are blank, and future cards do not claim zero bookings", async (t) => {
  const { click, nav } = await mount(t);
  await click([...document.querySelectorAll("button")].find((b) => b.textContent === "按下訂月份"));
  const monthChart = nav().closest('.monthDetail').querySelector('.barPlot');
  const future = monthChart.querySelector('button[aria-label^="10/06"]');
  assert.match(future.getAttribute("aria-label"), /快照日之後/);
  assert.match(future.getAttribute("aria-label"), /—/);
  const november = [...document.querySelectorAll('.monthCard')].find((c) => c.querySelector("span").textContent === "2026/11 月");
  assert.equal(november.querySelector("strong").textContent, "尚未到來");
});

test("month navigation crosses the year boundary and returns to snapshot month", async (t) => {
  const { click, nav } = await mount(t);
  const january = [...document.querySelectorAll('.monthCard')].find((c) => c.querySelector("span").textContent === "2026/01 月");
  await click(january);
  await click(nav().querySelector('[aria-label="查看上一個月"]'));
  assert.equal(nav().querySelector("input").value, "2025-12");
  await click([...nav().querySelectorAll("button")].find((b) => b.textContent === "回到本月"));
  assert.equal(nav().querySelector("input").value, "2026-10");
});

test("month picker jumps directly and chart selection still highlights a bar", async (t) => {
  const { dom, click, nav } = await mount(t);
  const input = nav().querySelector('input[type="month"]');
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "2026-09");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert.match(nav().parentElement.querySelector("h3").textContent, /2026\/09/);
  const chart = nav().closest('.monthDetail');
  const bar = chart.querySelector('button[aria-label^="09/30"]');
  await click(bar);
  assert.equal(bar.getAttribute("aria-pressed"), "true");
  assert.equal(bar.getAttribute("data-active"), "true");
  assert.match(chart.querySelector('.chartReadout').textContent, /3,000/);
});
