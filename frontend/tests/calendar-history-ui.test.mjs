import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createJSONStorage } from "zustand/middleware";
import { localTodayIso } from "../src/components/calendar/calendar-utils.ts";
import { mount } from "./helpers/customer-dom.mjs";

globalThis.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
const { useCalendarHistory } = await import("../src/components/calendar/calendar-history.ts");
const { useCalendarPreferences } = await import("../src/components/calendar/calendar-preferences.ts");

function Probe() {
  const ready = useCalendarHistory();
  const date = useCalendarPreferences((s) => s.anchorDate);
  return createElement("output", null, ready ? date : "loading");
}

test("old saved September date is ignored, while filters survive and future dates are not persisted", async () => {
  let saved = JSON.stringify({ state: { anchorDate: "2026-09-01", view: "month", availabilityRoom: "101" }, version: 0 });
  useCalendarPreferences.setState({ anchorDate: localTodayIso() });
  useCalendarPreferences.persist.setOptions({ storage: createJSONStorage(() => ({
    getItem: () => saved,
    setItem: (_key, value) => { saved = value; },
    removeItem: () => { saved = null; },
  })) });
  await useCalendarPreferences.persist.rehydrate();
  assert.equal(useCalendarPreferences.getState().anchorDate, localTodayIso());
  assert.equal(useCalendarPreferences.getState().availabilityRoom, "101");
  useCalendarPreferences.getState().setAnchorDate("2026-09-01");
  assert.equal(Object.hasOwn(JSON.parse(saved).state, "anchorDate"), false);
});

test("a fresh calendar visit resets an old in-memory month to today", async (t) => {
  useCalendarPreferences.setState({ anchorDate: "2026-09-01" });
  await mount(t, Probe, {}, "calendar");
  assert.equal(document.querySelector("output").textContent, localTodayIso());
  assert.equal(new URLSearchParams(location.search).get("date"), localTodayIso());
});

test("a saved old-date URL starts today, but in-session Back/Forward retain manually chosen months", async (t) => {
  await mount(t, Probe, {}, "calendar?view=month&date=2026-09-15");
  assert.equal(document.querySelector("output").textContent, localTodayIso());
  await act(() => useCalendarPreferences.getState().setAnchorDate("2026-09-15"));
  assert.equal(document.querySelector("output").textContent, "2026-09-15");
  await act(() => useCalendarPreferences.getState().setAnchorDate("2026-11-15"));
  assert.equal(new URLSearchParams(location.search).get("date"), "2026-11-15");
  async function traverse(action) {
    await act(async () => {
      const changed = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
      history[action]();
      await changed;
    });
  }
  await traverse("back");
  assert.equal(document.querySelector("output").textContent, "2026-09-15");
  await traverse("forward");
  assert.equal(document.querySelector("output").textContent, "2026-11-15");
});

test("reopening the calendar ignores a matching old browser history snapshot", async (t) => {
  const { root } = await mount(t, Probe, {}, "calendar");
  await act(() => useCalendarPreferences.getState().setAnchorDate("2026-09-15"));
  assert.equal(history.state.bnbCalendar.anchorDate, "2026-09-15");
  await act(() => root.render(createElement(Probe, { key: "reopened" })));
  assert.equal(document.querySelector("output").textContent, localTodayIso());
  assert.equal(history.state.bnbCalendar.anchorDate, localTodayIso());
});

test("a link to a specific booking still opens that booking's date", async (t) => {
  await mount(t, Probe, {}, "calendar?date=2026-09-15&order=synthetic-order");
  assert.equal(document.querySelector("output").textContent, "2026-09-15");
  assert.equal(useCalendarPreferences.getState().selectedBookingId, "synthetic-order");
});

test("foregrounding a suspended calendar resets its old month without interrupting an open booking", async (t) => {
  const { dom } = await mount(t, Probe, {}, "calendar");
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const foreground = async () => act(() => {
    visibility = "hidden";
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
  });
  await act(() => useCalendarPreferences.setState({ anchorDate: "2026-09-15", expandedWeeks: ["2026-09-14"] }));
  await foreground();
  assert.equal(document.querySelector("output").textContent, localTodayIso());
  assert.deepEqual(useCalendarPreferences.getState().expandedWeeks, []);
  assert.equal(new URLSearchParams(location.search).get("date"), localTodayIso());
  await act(() => useCalendarPreferences.setState({ anchorDate: "2026-09-15", selectedBookingId: "synthetic-order" }));
  await foreground();
  assert.equal(document.querySelector("output").textContent, "2026-09-15");
  await act(() => {
    useCalendarPreferences.setState({ selectedBookingId: null });
    window.dispatchEvent(new dom.window.PageTransitionEvent("pageshow", { persisted: true }));
  });
  assert.equal(document.querySelector("output").textContent, localTodayIso());
});

test("invalid date links fall back to today", async (t) => {
  useCalendarPreferences.setState({ anchorDate: "2026-09-01" });
  await mount(t, Probe, {}, "calendar?date=2026-02-30");
  assert.equal(document.querySelector("output").textContent, localTodayIso());
});

test("a new visit after a month or year rollover computes today again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2027, 0, 1, 9).getTime() });
  useCalendarPreferences.setState({ anchorDate: "2026-12-31" });
  await mount(t, Probe, {}, "calendar");
  assert.equal(document.querySelector("output").textContent, "2027-01-01");
});
