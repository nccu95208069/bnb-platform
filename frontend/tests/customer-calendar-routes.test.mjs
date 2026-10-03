import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import * as Calendar from "../src/app/api/customer-workspaces/[slug]/calendar-import/route.ts";
import * as Upload from "../src/app/api/customer-workspaces/[slug]/calendar-import/upload/route.ts";
import * as Callback from "../src/app/api/customer-calendar/callback/route.ts";
import * as Cron from "../src/app/api/cron/customer-calendars/route.ts";
import { store as routeStore } from "../src/lib/customer-workspaces/http.ts";
import { login, sessionFor } from "../src/lib/customer-workspaces/auth.ts";
import {
  fixture,
  ics,
  event,
  range,
  mapping,
} from "./helpers/calendar-fixture.mjs";
const origin = "https://test.local";
async function setup(t) {
  process.env.CUSTOMER_WORKSPACES_ENABLED = "true";
  process.env.CUSTOMER_SESSION_SECRET = "synthetic-calendar-route-secret-only";
  process.env.CUSTOMER_SELF_SIGNUP_PREVIEW = "true";
  const f = fixture(),
    account = await login(f.store, {
      mode: "register",
      email: "calendar-route@example.test",
      password: "Synthetic calendar passphrase!",
      confirmPassword: "Synthetic calendar passphrase!",
    });
  const w = await f.current();
  w.members[0].accountId = account.id;
  await f.put(w);
  f.args[1] = account.id;
  for (const name of ["read", "commit", "limit"])
    t.mock.method(routeStore, name, f.store[name]);
  return {
    ...f,
    cookie: `bnb_customer_session=${sessionFor(account)}`,
    context: { params: Promise.resolve({ slug: f.workspace.slug }) },
  };
}
function request(
  path,
  { cookie, method = "POST", body, originHeader = origin, headers = {} } = {},
) {
  return new NextRequest(origin + path, {
    method,
    headers: {
      origin: originHeader,
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body !== undefined
      ? { body: typeof body === "string" ? body : JSON.stringify(body) }
      : {}),
  });
}
test("calendar upload and commit require login, same origin and property access; bounded upload yields durable inventory and no-store results", async (t) => {
  const f = await setup(t),
    route = `/api/customer-workspaces/${f.workspace.slug}/calendar-import`,
    query = new URLSearchParams({
      ...range,
      kind: "android_calendar",
      propertyId: "property",
      filename: "synthetic.ics",
    }),
    content = ics([event({ uid: "route-booking" })]);
  assert.equal(
    (
      await Upload.POST(
        request(`${route}/upload?${query}`, { body: content }),
        f.context,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await Upload.POST(
        request(`${route}/upload?${query}`, {
          cookie: f.cookie,
          body: content,
          originHeader: "https://other.test",
        }),
        f.context,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await Upload.POST(
        request(`${route}/upload?${query}`, {
          cookie: f.cookie,
          body: content,
          headers: { "content-length": "99999999" },
        }),
        f.context,
      )
    ).status,
    400,
  );
  const foreign = new URLSearchParams(query);
  foreign.set("propertyId", "another-property");
  assert.equal(
    (
      await Upload.POST(
        request(`${route}/upload?${foreign}`, {
          cookie: f.cookie,
          body: content,
        }),
        f.context,
      )
    ).status,
    404,
  );
  const response = await Upload.POST(
    request(`${route}/upload?${query}`, { cookie: f.cookie, body: content }),
    f.context,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const source = await response.json();
  const previewResponse = await Calendar.POST(
    request(route, {
      cookie: f.cookie,
      body: {
        action: "preview",
        propertyId: "property",
        snapshotId: source.id,
        mapping: mapping(),
      },
    }),
    f.context,
  );
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  const input = {
    action: "commit",
    propertyId: "property",
    previewId: preview.id,
    selected: preview.rows.map((r) => r.id),
    confirmed: true,
    confirmedCoverage: true,
    mode: "migration",
  };
  assert.equal(
    (
      await Calendar.POST(
        request(route, {
          cookie: f.cookie,
          body: input,
          originHeader: "https://other.test",
        }),
        f.context,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await Calendar.POST(
        request(route, { cookie: f.cookie, body: input }),
        f.context,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await Calendar.POST(
        request(route, { cookie: f.cookie, body: input }),
        f.context,
      )
    ).status,
    200,
  );
  assert.equal((await f.current()).bookings.length, 1);
  const w = await f.current();
  w.members[0].role = "viewer";
  await f.put(w);
  assert.equal(
    (
      await Calendar.POST(
        request(route, {
          cookie: f.cookie,
          body: { action: "status", propertyId: "property" },
        }),
        f.context,
      )
    ).status,
    403,
  );
});
test("calendar feature gate, callback sanitization and cron authentication cannot be bypassed", async (t) => {
  const f = await setup(t),
    route = `/api/customer-workspaces/${f.workspace.slug}/calendar-import`;
  process.env.CUSTOMER_WORKSPACES_ENABLED = "false";
  assert.equal(
    (
      await Calendar.POST(
        request(route, {
          cookie: f.cookie,
          body: { action: "status", propertyId: "property" },
        }),
        f.context,
      )
    ).status,
    503,
  );
  const callback = await Callback.GET(
    request(
      "/api/customer-calendar/callback?state=bad&code=synthetic-secret-code",
      { method: "GET", cookie: f.cookie },
    ),
  );
  assert.equal(callback.status, 307);
  assert.equal(
    callback.headers.get("location").includes("synthetic-secret-code"),
    false,
  );
  assert.match(callback.headers.get("set-cookie"), /Max-Age=0/);
  delete process.env.CRON_SECRET;
  assert.equal(
    (await Cron.GET(request("/api/cron/customer-calendars", { method: "GET" })))
      .status,
    401,
  );
  process.env.CRON_SECRET = "synthetic-cron";
  assert.equal(
    (
      await Cron.GET(
        request("/api/cron/customer-calendars", {
          method: "GET",
          headers: { authorization: "Bearer wrong" },
        }),
      )
    ).status,
    401,
  );
  const disabled = await Cron.GET(
    request("/api/cron/customer-calendars", {
      method: "GET",
      headers: { authorization: "Bearer synthetic-cron" },
    }),
  );
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).enabled, false);
});
