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

test("explicit date links and real browser Back/Forward retain the chosen month", async (t) => {
  await mount(t, Probe, {}, "calendar?view=month&date=2026-09-15");
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
