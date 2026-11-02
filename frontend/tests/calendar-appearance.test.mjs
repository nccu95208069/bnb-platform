import test from "node:test";
import assert from "node:assert/strict";
import { CALENDAR_PALETTES, CHANNELS, DEFAULT_PALETTE } from "../src/lib/calendar-palettes.ts";
import { CalendarAppearanceStore } from "../src/lib/calendar-appearance-store.ts";

function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
test("all five palettes keep small platform labels readable at AA contrast", () => {
  assert.equal(new Set(CALENDAR_PALETTES.map(p => p.id)).size, 5);
  for (const palette of CALENDAR_PALETTES) for (const channel of CHANNELS) {
    const { background, foreground } = palette.colors[channel];
    const [a, b] = [luminance(background), luminance(foreground)].sort((x, y) => y - x);
    assert.ok((a + .05) / (b + .05) >= 4.5, `${palette.id}/${channel}`);
  }
});
test("preference storage isolates account keys and verifies writes; failures never claim success", async (t) => {
  process.env.KV_REST_API_URL = "https://preferences.invalid";
  process.env.KV_REST_API_TOKEN = "synthetic-test-token";
  const values = new Map(); let unavailable = false; let dropWrite = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (unavailable) return Response.json({error:"unavailable"}, {status:503});
    const [command, key, value] = JSON.parse(options.body);
    if (command === "SET" && !dropWrite) values.set(key, value);
    return Response.json({result:command === "GET" ? values.get(key) ?? null : "OK"});
  });
  const store = new CalendarAppearanceStore();
  assert.equal(await store.read("account-A"), DEFAULT_PALETTE);
  await store.save("account-A", "jewel");
  await store.save("account-B", "coast");
  assert.equal(await new CalendarAppearanceStore().read("account-A"), "jewel");
  assert.equal(await store.read("account-B"), "coast");
  dropWrite = true;
  await assert.rejects(store.save("account-A", "earth"), /UNCONFIRMED/);
  await assert.rejects(store.save("account-A", "arbitrary-css"), /INVALID/);
  unavailable = true;
  await assert.rejects(store.read("account-A"), /UNAVAILABLE/);
});
