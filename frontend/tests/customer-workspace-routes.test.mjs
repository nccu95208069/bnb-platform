import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import * as Session from "../src/app/api/customer-session/route.ts";
import * as Workspaces from "../src/app/api/customer-workspaces/route.ts";
import * as Calendar from "../src/app/api/customer-workspaces/[slug]/route.ts";
import * as Legacy from "../src/app/api/calendar-session/route.ts";
const request = (
  path,
  method = "GET",
  body,
  cookie,
  origin = "https://test.local",
) =>
  new NextRequest(`https://test.local/api/${path}`, {
    method,
    headers: { origin, ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
test("API enforces CSRF, tenant boundaries, no-store, separate legacy sessions and feature gate", async (t) => {
  process.env.CUSTOMER_WORKSPACES_ENABLED = "true";
  process.env.CUSTOMER_SESSION_SECRET = "synthetic-session-secret-for-testing";
  process.env.KV_REST_API_URL = "https://redis.invalid";
  process.env.KV_REST_API_TOKEN = "synthetic";
  const data = new Map();
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const c = JSON.parse(options.body);
    let result = null;
    if (c[0] === "GET") result = data.get(c[1]) ?? null;
    if (c[0] === "EVAL") {
      if (c[1].includes("INCR")) result = 1;
      else {
        const keys = c.slice(3, 3 + c[2]),
          args = c.slice(3 + c[2]);
        result = keys.every((key, i) => (data.get(key) ?? "") === args[i * 2])
          ? 1
          : 0;
        if (result) keys.forEach((key, i) => data.set(key, args[i * 2 + 1]));
      }
    }
    return Response.json({ result });
  });
  const context = { params: Promise.resolve({ slug: "api-inn" }) };
  assert.equal(
    (await Calendar.GET(request("customer-workspaces/api-inn"), context))
      .status,
    401,
  );
  const credentials = {
    mode: "register",
    email: "route@example.test",
    password: "Route synthetic passphrase!",
    confirmPassword: "Route synthetic passphrase!",
  };
  assert.equal(
    (
      await Session.POST(
        request(
          "customer-session",
          "POST",
          credentials,
          null,
          "https://evil.test",
        ),
      )
    ).status,
    403,
  );
  const registered = await Session.POST(
    request("customer-session", "POST", credentials),
  );
  assert.equal(registered.status, 200);
  const cookie = `bnb_customer_session=${registered.cookies.get("bnb_customer_session").value}`;
  const profile = await Session.GET(
    request("customer-session", "GET", null, cookie),
  );
  assert.equal(profile.headers.get("cache-control"), "private, no-store");
  assert.equal(
    JSON.stringify(await profile.json()).includes("credential"),
    false,
  );
  assert.equal(
    (
      await Workspaces.POST(
        request(
          "customer-workspaces",
          "POST",
          {
            name: "Synthetic API inn",
            slug: "api-inn",
            kind: "rooms",
            rooms: ["101"],
            requestKey: "api-creation-key-0000",
          },
          cookie,
        ),
      )
    ).status,
    201,
  );
  const calendar = await Calendar.GET(
    request("customer-workspaces/api-inn", "GET", null, cookie),
    context,
  );
  const view = await calendar.json();
  assert.equal(calendar.status, 200);
  const booking = {
    propertyId: view.properties[0].id,
    roomIds: [view.properties[0].rooms[0].id],
    checkIn: "2026-10-02",
    checkOut: "2026-10-03",
    version: view.version,
    requestKey: "api-booking-key-0000",
  };
  assert.equal(
    (
      await Calendar.POST(
        request("customer-workspaces/api-inn", "POST", booking, cookie),
        context,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await Calendar.POST(
        request("customer-workspaces/api-inn", "POST", booking, cookie),
        context,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await Calendar.POST(
        request(
          "customer-workspaces/api-inn",
          "POST",
          booking,
          cookie,
          "https://evil.test",
        ),
        context,
      )
    ).status,
    403,
  );
  const outsider = await Session.POST(
    request("customer-session", "POST", {
      ...credentials,
      email: "outsider@example.test",
    }),
  );
  const otherCookie = `bnb_customer_session=${outsider.cookies.get("bnb_customer_session").value}`;
  assert.equal(
    (
      await Calendar.GET(
        request("customer-workspaces/api-inn", "GET", null, otherCookie),
        context,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await Calendar.POST(
        request("customer-workspaces/api-inn", "POST", booking, otherCookie),
        context,
      )
    ).status,
    404,
  );
  const legacy = await Legacy.GET(
    request("calendar-session", "GET", null, cookie),
  );
  assert.equal((await legacy.json()).authenticated, false);
  assert.equal(
    (
      await Session.GET(
        request("customer-session", "GET", null, "sf_calendar_owner=synthetic"),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await Session.DELETE(request("customer-session", "DELETE", {}, cookie))
    ).cookies.get("bnb_customer_session").value,
    "",
  );
  process.env.CUSTOMER_WORKSPACES_ENABLED = "false";
  assert.equal(
    (
      await Calendar.GET(
        request("customer-workspaces/api-inn", "GET", null, cookie),
        context,
      )
    ).status,
    503,
  );
});
