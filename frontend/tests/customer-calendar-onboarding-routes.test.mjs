import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { NextRequest } from "next/server";
import * as PublicCalendar from "../src/app/api/customer-calendar-onboarding/route.ts";
import * as Upload from "../src/app/api/customer-calendar-onboarding/upload/route.ts";
import * as Login from "../src/app/api/customer-login/route.ts";
import * as Callback from "../src/app/api/customer-calendar/callback/route.ts";
import { store as routeStore } from "../src/lib/customer-workspaces/http.ts";
import { sealMailPassword } from "../src/lib/workspace-auth/mail.ts";
import { accountKey, sessionFor } from "../src/lib/customer-workspaces/auth.ts";
import { newPasswordlessCredential } from "../src/lib/customer-workspaces/identity.ts";
import {
  draftForHash,
  draftHash,
} from "../src/lib/customer-workspaces/calendar-onboarding.ts";
import { beginGoogleSignIn } from "../src/lib/customer-workspaces/google-signin.ts";
import {
  fixture,
  ics,
  event,
  range,
  googleConfig,
} from "./helpers/calendar-fixture.mjs";
const origin = "https://test.local",
  path = "/api/customer-calendar-onboarding";
function request(path, body, cookie = "", other = {}) {
  return new NextRequest(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, cookie, ...other },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
async function setup(t) {
  Object.assign(process.env, {
    CUSTOMER_WORKSPACES_ENABLED: "true",
    CUSTOMER_INTAKE_ENABLED: "true",
    CUSTOMER_ONBOARDING_ENABLED: "true",
    CUSTOMER_INTAKE_PREVIEW: "false",
    CUSTOMER_SESSION_SECRET: "synthetic-route-login-secret-at-least-thirty-two",
    CALENDAR_OWNER_SESSION_SECRET: "a".repeat(64),
    CUSTOMER_DEPLOYMENT_LINKS: "true",
    VERCEL_URL: "synthetic-login.vercel.app",
    KV_REST_API_URL: "https://redis.invalid",
    KV_REST_API_TOKEN: "synthetic",
  });
  const { store } = fixture();
  store.data.clear();
  for (const name of ["read", "commit", "limit"])
    t.mock.method(routeStore, name, store[name]);
  const mail = [],
    secret = sealMailPassword("synthetic-password");
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), "https://redis.invalid");
    return Response.json({ result: JSON.stringify({ secret }) });
  });
  t.mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (message) => {
      mail.push(message);
      return { accepted: [message.to], messageId: "synthetic-mail" };
    },
    close() {},
  }));
  return { store, mail };
}
async function preview(f) {
  const start = await PublicCalendar.POST(
    request(path, {
      action: "start",
      name: "Public Synthetic Inn",
      kind: "rooms",
      rooms: ["101"],
      calendarKind: "ios_calendar",
    }),
  );
  assert.equal(start.status, 200);
  assert.match(start.headers.get("set-cookie"), /HttpOnly/);
  const cookie = start.headers.get("set-cookie").split(";")[0],
    hash = draftHash(cookie.split("=")[1]),
    draft = (await draftForHash(f.store, hash)).value;
  const get = await PublicCalendar.GET(request(path, undefined, cookie));
  assert.equal(get.status, 200);
  const view = await get.json(),
    query = new URLSearchParams({
      ...range,
      kind: "ios_calendar",
      propertyId: draft.propertyId,
      filename: "synthetic.ics",
    });
  const up = await Upload.POST(
    request(
      `${path}/upload?${query}`,
      ics([event({ uid: "public-event", title: "客人：Synthetic" })]),
      cookie,
    ),
  );
  assert.equal(up.status, 200);
  const source = await up.json();
  const response = await PublicCalendar.POST(
    request(
      path,
      {
        action: "preview",
        snapshotId: source.id,
        mapping: {
          calendarIds: source.calendars.map((c) => c.id),
          rooms: { [source.calendars[0].id]: [view.property.rooms[0].id] },
          dateMode: "stay",
          titleRooms: false,
          extractLabels: true,
          overrides: {},
        },
      },
      cookie,
    ),
  );
  assert.equal(response.status, 200);
  const p = await response.json();
  const command = {
    action: "commit",
    previewId: p.id,
    selected: p.rows.map((r) => r.id),
    confirmed: true,
    confirmedCoverage: true,
    mode: "migration",
  };
  assert.equal(
    (await (await PublicCalendar.POST(request(path, command, cookie))).json())
      .loginRequired,
    true,
  );
  return { ...f, cookie, hash, draft, command, query, source, preview: p };
}
test("public ICS route previews before signup, emails only at save, restores selection and atomically saves once after explicit account confirmation", async (t) => {
  const f = await preview(await setup(t));
  assert.equal(f.mail.length, 0);
  assert.equal(
    [...f.store.data.keys()].some((k) => /^(account|workspace):/.test(k)),
    false,
  );
  const prep = await Login.POST(
    request("/api/customer-login", { action: "prepare" }, f.cookie),
  );
  const proofCookie = prep.headers.get("set-cookie").split(";")[0],
    cookie = `${f.cookie}; ${proofCookie}`;
  const input = {
    action: "request",
    destination: "calendar",
    email: "owner@example.test",
    requestKey: randomUUID(),
  };
  assert.equal(
    (await Login.POST(request("/api/customer-login", input, cookie))).status,
    200,
  );
  assert.equal(
    (await Login.POST(request("/api/customer-login", input, cookie))).status,
    200,
  );
  assert.equal(f.mail.length, 1);
  assert.match(f.mail[0].text, /不需要設定密碼/);
  const token = f.mail[0].text.match(/\/signin#([^\s]+)/)[1];
  assert.equal(
    (
      await Login.POST(
        request("/api/customer-login", { action: "consume", token }, f.cookie),
      )
    ).status,
    400,
  );
  const signed = await Login.POST(
    request("/api/customer-login", { action: "consume", token }, cookie),
  );
  assert.equal(signed.status, 200);
  assert.equal((await signed.json()).url, "/join/calendar?verified=1");
  const session = signed.headers.get("set-cookie").split(";")[0],
    authenticated = `${cookie}; ${session}`;
  const restored = await (
    await PublicCalendar.GET(request(path, undefined, authenticated))
  ).json();
  assert.deepEqual(restored.prepared.selected, f.command.selected);
  assert.equal(restored.account.email, input.email);
  assert.equal(JSON.stringify(restored).includes("credential"), false);
  assert.equal(
    [...f.store.data.keys()].some((k) => k.startsWith("workspace:")),
    false,
  );
  const unconfirmed = await PublicCalendar.POST(
    request(path, f.command, authenticated),
  );
  assert.equal((await unconfirmed.json()).loginRequired, true);
  const command = { ...f.command, accountId: restored.account.id };
  const saved = await (
    await PublicCalendar.POST(request(path, command, authenticated))
  ).json();
  assert.ok(saved.completed.url.startsWith("/w/"));
  const retry = await (
    await PublicCalendar.POST(request(path, command, authenticated))
  ).json();
  assert.deepEqual(retry, saved);
  assert.equal(
    (await f.store.read(`workspace:${f.draft.workspaceId}`)).value.bookings
      .length,
    1,
  );
  assert.equal(
    (await f.store.read(accountKey(input.email))).value.workspaces.length,
    1,
  );
});
test("public flow rejects CSRF, swapped tenants/accounts, unprepared mail, stale links after edit, oversized uploads and disabled features", async (t) => {
  const f = await setup(t);
  assert.equal(
    (
      await PublicCalendar.POST(
        request(path, { action: "start" }, "", { origin: "https://evil.test" }),
      )
    ).status,
    403,
  );
  assert.equal((await PublicCalendar.GET(request(path))).status, 409);
  const p = await preview(f);
  assert.equal(
    (await Upload.POST(request(`${path}/upload?${p.query}`, "body", p.cookie)))
      .status,
    409,
  );
  assert.equal(
    (
      await PublicCalendar.POST(
        request(
          path,
          { action: "preview", snapshotId: randomUUID() },
          p.cookie,
        ),
      )
    ).status,
    409,
  );
  const prep = await Login.POST(
    request("/api/customer-login", { action: "prepare" }, p.cookie),
  );
  const cookie = `${p.cookie}; ${prep.headers.get("set-cookie").split(";")[0]}`;
  const input = {
    action: "request",
    destination: "calendar",
    email: "intended@example.test",
    requestKey: randomUUID(),
  };
  await Login.POST(request("/api/customer-login", input, cookie));
  const token = p.mail[0].text.match(/\/signin#([^\s]+)/)[1];
  const other = {
    id: randomUUID(),
    email: "other@example.test",
    emailVerifiedAt: new Date().toISOString(),
    credential: newPasswordlessCredential(),
    workspaces: [],
  };
  await p.store.commit([
    { key: accountKey(other.email), before: null, after: other },
  ]);
  assert.equal(
    (
      await PublicCalendar.POST(
        request(
          path,
          { ...p.command, accountId: other.id },
          `${cookie}; bnb_customer_session=${sessionFor(other)}`,
        ),
      )
    ).status,
    409,
  );
  assert.equal(
    (await PublicCalendar.POST(request(path, { action: "edit" }, cookie)))
      .status,
    200,
  );
  assert.equal(
    (
      await Login.POST(
        request("/api/customer-login", { action: "consume", token }, cookie),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await Login.POST(
        request(
          "/api/customer-login",
          { ...input, requestKey: randomUUID() },
          cookie,
        ),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await Upload.POST(
        request(`${path}/upload?${p.query}`, "body", cookie, {
          "content-length": "99999999",
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await PublicCalendar.POST(
        request(
          path,
          { action: "preview", snapshotId: p.source.id, propertyId: "foreign" },
          cookie,
        ),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await PublicCalendar.POST(
        request(path, { action: "preview", snapshotId: "foreign" }, cookie),
      )
    ).status,
    404,
  );
  process.env.CUSTOMER_ONBOARDING_ENABLED = "false";
  assert.equal(
    (await PublicCalendar.GET(request(path, undefined, cookie))).status,
    503,
  );
  process.env.CUSTOMER_WORKSPACES_ENABLED = "false";
  assert.equal(
    (
      await Login.POST(
        request("/api/customer-login", { action: "prepare" }, cookie),
      )
    ).status,
    503,
  );
});
test("expired Google consent returns to the existing draft without creating an account or exposing provider details", async (t) => {
  const f = await setup(t);
  googleConfig();
  const start = await PublicCalendar.POST(
    request(path, {
      action: "start",
      name: "Expired Consent Inn",
      kind: "rooms",
      rooms: ["101"],
      calendarKind: "google_calendar",
    }),
  );
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const before = [...f.store.data.entries()];
  const response = await Callback.GET(
    request(
      "/api/customer-calendar/callback?state=expired&error=access_denied&error_description=private-provider-detail",
      undefined,
      cookie,
    ),
  );
  assert.equal(response.status, 307);
  assert.equal(
    new URL(response.headers.get("location")).pathname +
      new URL(response.headers.get("location")).search,
    "/join/calendar?calendar=failed",
  );
  assert.equal(response.headers.get("location").includes("private-provider-detail"), false);
  assert.equal(response.headers.get("set-cookie").includes("bnb_customer_session"), false);
  assert.deepEqual([...f.store.data.entries()], before);
  assert.equal((await PublicCalendar.GET(request(path, undefined, cookie))).status, 200);
  const noDraft = await Callback.GET(
    request("/api/customer-calendar/callback?state=expired&error=access_denied"),
  );
  assert.equal(new URL(noDraft.headers.get("location")).search, "?google=failed");
});
test("feature-disabled Google callback cannot consume public OAuth state or issue a session", async (t) => {
  const f = await setup(t);
  googleConfig();
  const started = await beginGoogleSignIn(f.store),
    state = new URL(started.url).searchParams.get("state");
  process.env.CUSTOMER_WORKSPACES_ENABLED = "false";
  const response = await Callback.GET(
    request(
      `/api/customer-calendar/callback?state=${state}&code=private-code`,
      undefined,
      `bnb_calendar_state=${started.browser}`,
    ),
  );
  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("set-cookie").includes("bnb_customer_session"),
    false,
  );
  assert.equal(
    response.headers.get("location").includes("private-code"),
    false,
  );
  assert.equal(
    [...f.store.data.entries()]
      .find(([k]) => k.startsWith("google-signin:"))[1]
      .includes('"used":false'),
    true,
  );
});
