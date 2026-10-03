import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  beginCalendarGoogle,
  finishCalendarGoogle,
  listGoogleCalendars,
  readGoogleCalendar,
} from "../src/lib/customer-workspaces/calendar-google.ts";
import {
  previewCalendar,
  commitCalendar,
} from "../src/lib/customer-workspaces/calendar-import.ts";
import {
  verifyGoogleCalendarPreview,
  synchronizeCalendarWorkspace,
} from "../src/lib/customer-workspaces/calendar-sync.ts";
import { runCalendarJobs } from "../src/lib/customer-workspaces/calendar-jobs.ts";
import {
  financeSummary,
  propertyReadiness,
} from "../src/lib/customer-workspaces/domain.ts";
import {
  fixture,
  range,
  googleConfig,
  scopes,
} from "./helpers/calendar-fixture.mjs";
const rules = {
  calendarIds: ["google-calendar"],
  rooms: { "google-calendar": ["101"] },
  dateMode: "stay",
  titleRooms: false,
  extractLabels: true,
  overrides: {},
};
const activity = {
  id: "google-event",
  iCalUID: "stable-uid",
  summary: "客人：測試 總額：6000 訂金：2000",
  start: { date: "2026-10-10" },
  end: { date: "2026-10-12" },
  updated: "2026-10-01T00:00:00Z",
};
async function connected(t, { pages = false } = {}) {
  googleConfig();
  const f = fixture(),
    started = await beginCalendarGoogle(...f.args),
    state = new URL(started.url).searchParams.get("state"),
    requests = [];
  let events = [structuredClone(activity)],
    revoked = false,
    refreshes = 0;
  t.mock.method(globalThis, "fetch", async (raw, options) => {
    const url = new URL(raw);
    requests.push(url);
    if (url.hostname === "oauth2.googleapis.com") {
      const body = new URLSearchParams(options.body);
      if (body.get("grant_type") === "authorization_code")
        assert.equal(
          createHash("sha256")
            .update(body.get("code_verifier"))
            .digest("base64url"),
          new URL(started.url).searchParams.get("code_challenge"),
        );
      else refreshes++;
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        expires_in: refreshes ? 3600 : 60,
        scope: scopes,
      });
    }
    assert.equal(options.headers.Authorization, "Bearer synthetic-access");
    if (revoked) return Response.json({ error: "denied" }, { status: 403 });
    if (url.pathname.endsWith("/calendarList"))
      return Response.json({
        items: [
          {
            id: "google-calendar",
            summary: "Synthetic room calendar",
            accessRole: "owner",
          },
        ],
      });
    assert.match(url.pathname, /calendars\/google-calendar\/events$/);
    assert.equal(url.searchParams.get("singleEvents"), "true");
    assert.equal(url.searchParams.get("showDeleted"), "false");
    return Response.json(
      pages && !url.searchParams.get("pageToken")
        ? { items: [], nextPageToken: "next" }
        : { items: events },
    );
  });
  await finishCalendarGoogle(
    f.store,
    "calendar-owner",
    state,
    started.nonce,
    "code",
  );
  return {
    ...f,
    started,
    state,
    requests,
    setEvents: (value) => {
      events = value;
    },
    revoke: () => {
      revoked = true;
    },
    refreshes: () => refreshes,
  };
}
test("Calendar OAuth is readonly, offline, PKCE, single-use and account/nonce bound; refresh tokens stay encrypted", async (t) => {
  googleConfig();
  const f = fixture(),
    started = await beginCalendarGoogle(...f.args),
    url = new URL(started.url),
    state = url.searchParams.get("state");
  assert.equal(url.searchParams.get("scope"), scopes);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  await assert.rejects(
    finishCalendarGoogle(f.store, "other", state, started.nonce, "code"),
    /FORBIDDEN/,
  );
  await assert.rejects(
    finishCalendarGoogle(f.store, "calendar-owner", state, "wrong", "code"),
    /FORBIDDEN/,
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      access_token: "do-not-save",
      refresh_token: "also-not-save",
      expires_in: 3600,
      scope: "openid",
    }),
  );
  await assert.rejects(
    finishCalendarGoogle(
      f.store,
      "calendar-owner",
      state,
      started.nonce,
      "code",
    ),
    /CALENDAR_CONNECT_REQUIRED/,
  );
  assert.equal(
    [...f.store.data.keys()].some((k) => k.startsWith("calendar-connection:")),
    false,
  );
  const full = await connected(t);
  assert.equal(
    [...full.store.data.values()].join("").includes("synthetic-refresh"),
    false,
  );
  assert.equal(
    [...full.store.data.values()].join("").includes("synthetic-access"),
    false,
  );
  await assert.rejects(
    finishCalendarGoogle(
      full.store,
      "calendar-owner",
      full.state,
      full.started.nonce,
      "code",
    ),
    /FORBIDDEN/,
  );
});
test("Google reads every page only for selected calendars, renews expired access and rejects source changes after preview", async (t) => {
  const f = await connected(t, { pages: true });
  assert.equal((await listGoogleCalendars(...f.args)).calendars.length, 1);
  const input = {
    ...range,
    kind: "ios_calendar",
    calendarIds: ["google-calendar"],
  };
  const source = await readGoogleCalendar(...f.args, input);
  assert.equal(source.events.length, 1);
  assert.equal(source.kind, "ios_calendar");
  assert.equal(
    f.requests.some((u) => u.searchParams.get("pageToken") === "next"),
    true,
  );
  await assert.rejects(
    readGoogleCalendar(...f.args, {
      ...input,
      calendarIds: ["foreign-calendar"],
    }),
    /CALENDAR_CONNECT_REQUIRED/,
  );
  const p = await previewCalendar(...f.args, source.id, rules);
  await verifyGoogleCalendarPreview(...f.args, p.id);
  f.setEvents([{ ...activity, end: { date: "2026-10-13" } }]);
  await assert.rejects(
    verifyGoogleCalendarPreview(...f.args, p.id),
    /CALENDAR_SOURCE_CHANGED/,
  );
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 31000);
  await listGoogleCalendars(...f.args);
  assert.equal(f.refreshes(), 1);
});
test("connected import registers durable work atomically; sync updates stays without changing money and holds cancellations/financial changes", async (t) => {
  const f = await connected(t);
  const source = await readGoogleCalendar(...f.args, {
      ...range,
      kind: "android_calendar",
      calendarIds: ["google-calendar"],
    }),
    p = await previewCalendar(...f.args, source.id, rules);
  const batch = await commitCalendar(...f.args, {
    previewId: p.id,
    selected: p.rows.map((r) => r.id),
    confirmed: true,
    confirmedCoverage: true,
    mode: "connected",
  });
  assert.equal(
    (await f.store.read("calendar-sync-index")).value[0].workspaceId,
    f.workspace.id,
  );
  const target = { workspaceId: f.workspace.id, slug: f.workspace.slug };
  f.setEvents([
    {
      ...activity,
      start: { date: "2026-10-13" },
      end: { date: "2026-10-15" },
      updated: "2026-10-02T00:00:00Z",
    },
  ]);
  await synchronizeCalendarWorkspace(f.store, target, Date.now() + 230000);
  let w = await f.current();
  assert.equal(w.bookings.length, 1);
  assert.equal(w.bookings[0].checkIn, "2026-10-13");
  assert.equal(w.bookings[0].total, 6000);
  assert.equal(financeSummary(w.bookings[0]).received, null);
  assert.equal(w.calendarSources[0].pendingCount, 0);
  const batches = w.calendarBatches.length;
  await synchronizeCalendarWorkspace(f.store, target, Date.now() + 230000);
  w = await f.current();
  assert.equal(
    w.calendarBatches.length,
    batches,
    "unchanged polling must not create import batches",
  );
  f.setEvents([
    {
      ...activity,
      summary: "客人：測試 總額：9000 訂金：3000",
      start: { date: "2026-10-13" },
      end: { date: "2026-10-15" },
    },
  ]);
  await synchronizeCalendarWorkspace(f.store, target, Date.now() + 230000);
  w = await f.current();
  assert.equal(w.bookings[0].total, 6000);
  assert.equal(w.calendarSources[0].pendingCount, 1);
  assert.equal(propertyReadiness(w, w.properties[0]).complete, false);
  f.setEvents([]);
  await synchronizeCalendarWorkspace(f.store, target, Date.now() + 230000);
  w = await f.current();
  assert.equal(w.bookings[0].status, "confirmed");
  assert.equal(w.calendarSources[0].pendingCount, 1);
  f.revoke();
  await synchronizeCalendarWorkspace(f.store, target, Date.now() + 230000);
  w = await f.current();
  assert.equal(w.calendarSources[0].error, "CALENDAR_CONNECT_REQUIRED");
  assert.equal(propertyReadiness(w, w.properties[0]).complete, false);
  assert.equal(w.calendarSources[0].id, batch.bindingId);
});
test("durable jobs use leases, recover expired work and do not run concurrent workers twice", async () => {
  const f = fixture(),
    target = { workspaceId: f.workspace.id, slug: f.workspace.slug };
  f.store.data.set("calendar-sync-index", JSON.stringify([target]));
  let calls = 0,
    release;
  const gate = new Promise((r) => {
    release = r;
  });
  const first = runCalendarJobs(f.store, async () => {
    calls++;
    await gate;
  });
  await new Promise((r) => setImmediate(r));
  const second = await runCalendarJobs(f.store, async () => {
    calls++;
  });
  assert.equal(second.processed, 0);
  release();
  await first;
  assert.equal(calls, 1);
  f.store.data.set(
    `calendar-job:${f.workspace.id}`,
    JSON.stringify({
      due: 0,
      leaseUntil: Date.now() - 1,
      lease: "expired-process",
    }),
  );
  const recovered = await runCalendarJobs(f.store, async () => {
    calls++;
  });
  assert.equal(recovered.processed, 1);
  assert.equal(calls, 2);
});

test("disconnect removes this property's credentials atomically, preserves orders and blocks availability until rechecked", async (t) => {
  const { disconnectCalendarGoogle } =
      await import("../src/lib/customer-workspaces/calendar-google.ts"),
    { randomUUID } = await import("node:crypto");
  const f = await connected(t),
    source = await readGoogleCalendar(...f.args, {
      ...range,
      kind: "google_calendar",
      calendarIds: ["google-calendar"],
    }),
    p = await previewCalendar(...f.args, source.id, rules);
  await commitCalendar(...f.args, {
    previewId: p.id,
    selected: p.rows.map((r) => r.id),
    confirmed: true,
    confirmedCoverage: true,
    mode: "connected",
  });
  const w = await f.current();
  const input = {
    requestKey: randomUUID(),
    version: w.version,
    confirmed: true,
  };
  await disconnectCalendarGoogle(...f.args, input);
  assert.deepEqual(await disconnectCalendarGoogle(...f.args, input), {
    disconnected: true,
  });
  const after = await f.current();
  assert.equal(after.bookings.length, 1);
  assert.equal(after.bookings[0].status, "confirmed");
  assert.equal(after.calendarSources[0].mode, "migration");
  assert.equal(propertyReadiness(after, after.properties[0]).complete, false);
  await assert.rejects(
    listGoogleCalendars(...f.args),
    /CALENDAR_CONNECT_REQUIRED/,
  );
  assert.equal(
    [...f.store.data.entries()]
      .filter(([key]) => key.startsWith("calendar-connection:"))
      .every(([, value]) => value === "null"),
    true,
  );
});
