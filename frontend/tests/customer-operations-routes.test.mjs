import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import * as Session from "../src/app/api/customer-session/route.ts";
import * as Workspaces from "../src/app/api/customer-workspaces/route.ts";
import * as Workspace from "../src/app/api/customer-workspaces/[slug]/route.ts";
import * as Operations from "../src/app/api/customer-workspaces/[slug]/operations/route.ts";
import * as Invite from "../src/app/api/customer-invitation/route.ts";
import * as Import from "../src/app/api/customer-workspaces/[slug]/import/route.ts";
import * as Admin from "../src/app/api/onboarding-admin/route.ts";
import { accountKey } from "../src/lib/customer-workspaces/auth.ts";
import { RedisCustomerStore } from "../src/lib/customer-workspaces/store.ts";
import { invitationUrl } from "../src/lib/customer-workspaces/invitations.ts";
import { listSupportRequests } from "../src/lib/customer-workspaces/support.ts";
const origin = "https://operations.test",
  slug = "http-operations",
  context = { params: Promise.resolve({ slug }) },
  base = `/api/customer-workspaces/${slug}`;
const password = "Synthetic HTTP operations password!";
function request(path, cookie, input, requestOrigin = origin) {
  return new NextRequest(origin + path, {
    method: input === undefined ? "GET" : "POST",
    headers: { origin: requestOrigin, ...(cookie ? { cookie } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
async function result(response, status = 200) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
test("HTTP multi-property, invitation, scoped prices, receipts, readable sources with unrelated creator accounts use the same persisted authorizations", async (t) => {
  process.env.CUSTOMER_WORKSPACES_ENABLED = "true";
  process.env.CUSTOMER_SELF_SIGNUP_PREVIEW = "true";
  process.env.CUSTOMER_INTAKE_PREVIEW = "true";
  process.env.CUSTOMER_SESSION_SECRET = "synthetic-http-operations-secret-only";
  process.env.KV_REST_API_URL = "https://redis.invalid";
  process.env.KV_REST_API_TOKEN = "synthetic";
  delete process.env.CALENDAR_OWNER_PASSWORD;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.CUSTOMER_SHEET_READER_CREDENTIALS = JSON.stringify({
    client_email: "reader@synthetic.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const values = new Map(),
    external = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const u = String(url);
    if (u === "https://redis.invalid") {
      const command = JSON.parse(options.body);
      let result = null;
      if (command[0] === "GET") result = values.get(command[1]) ?? null;
      else if (command[0] === "EVAL") {
        if (command[1].includes("INCR")) result = 1;
        else {
          const keys = command.slice(3, 3 + command[2]),
            args = command.slice(3 + command[2]),
            step = command[1].includes("i*3") ? 3 : 2;
          result = keys.every(
            (key, i) => (values.get(key) ?? "") === args[i * step],
          )
            ? 1
            : 0;
          if (result)
            keys.forEach((key, i) => values.set(key, args[i * step + 1]));
        }
      } else throw new Error("unexpected store command");
      return Response.json({ result });
    }
    external.push(u);
    if (u === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "synthetic" });
    if (u.includes("unshared-source"))
      return Response.json({ error: "unavailable" }, { status: 403 });
    if (u.startsWith("https://www.googleapis.com/drive/v3/files/"))
      return Response.json({
        owners: [
          {
            emailAddress: u.includes("other-source")
              ? "someone-else@example.test"
              : "owner@example.test",
          },
        ],
      });
    if (u.includes("/values/"))
      return Response.json({
        values: [
          ["入住", "退房", "房間"],
          ["2027-05-01", "2027-05-02", "201"],
        ],
      });
    if (u.startsWith("https://sheets.googleapis.com/v4/spreadsheets/"))
      return Response.json({
        properties: { title: "Private source title" },
        sheets: [
          {
            properties: {
              sheetId: 0,
              title: "Orders",
              gridProperties: { rowCount: 100, columnCount: 5 },
            },
          },
        ],
      });
    throw new Error("Unexpected outbound request, including any real email");
  });
  const register = async (email) => {
    const response = await Session.POST(
      request("/api/customer-session", null, {
        mode: "register",
        email,
        password,
        confirmPassword: password,
      }),
    );
    await result(response);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const ownerCookie = await register("owner@example.test"),
    strangerCookie = await register("stranger@example.test");
  await result(
    await Workspaces.POST(
      request("/api/customer-workspaces", ownerCookie, {
        requestKey: randomUUID(),
        name: "Synthetic inns",
        slug,
        kind: "mixed",
        rooms: ["101", "102", "103"],
      }),
    ),
    201,
  );
  const current = async (cookie) =>
    result(await Workspace.GET(request(base, cookie), context));
  const write = async (input, status = 200, cookie = ownerCookie) => {
    const data = await current(ownerCookie);
    return result(
      await Operations.POST(
        request(`${base}/operations`, cookie, {
          requestKey: randomUUID(),
          version: data.version,
          ...input,
        }),
        context,
      ),
      status,
    );
  };
  const first = (await current(ownerCookie)).properties[0];
  await result(
    await Operations.POST(
      request(`${base}/operations`, null, { action: "property" }),
      context,
    ),
    401,
  );
  await result(
    await Operations.POST(
      request(
        `${base}/operations`,
        ownerCookie,
        { action: "property" },
        "https://foreign.test",
      ),
      context,
    ),
    403,
  );
  await result(
    await Workspace.GET(request(base, strangerCookie), context),
    404,
  );
  const second = await write({
    action: "property",
    name: "Second inn",
    kind: "rooms",
    rooms: ["201"],
    mode: "sheet",
  });
  await write({
    action: "pricing",
    propertyId: first.id,
    pricing: {
      currency: "TWD",
      enabled: true,
      base: { [first.rooms[0].id]: 87654.32 },
      overrides: [],
    },
  });
  await write(
    {
      action: "invite",
      email: "cleaner@example.test",
      role: "owner",
      allProperties: true,
      propertyIds: [],
    },
    400,
  );
  const invitation = await write({
    action: "invite",
    email: "cleaner@example.test",
    role: "viewer_no_price",
    allProperties: false,
    propertyIds: [first.id],
  });
  assert.equal(invitation.delivery, "preview");
  assert.equal(JSON.stringify(invitation).includes("generation"), false);
  const store = new RedisCustomerStore(),
    workspaceId = (await current(ownerCookie)).id,
    raw = (await store.read(`workspace:${workspaceId}`)).value;
  const invite = raw.invitations.find((i) => i.id === invitation.invitationId),
    token = invitationUrl(workspaceId, invite).split("#")[1];
  await result(
    await Invite.POST(
      request(
        "/api/customer-invitation",
        null,
        { action: "accept", token, password, confirmPassword: password },
        "https://foreign.test",
      ),
    ),
    403,
  );
  const accepted = await Invite.POST(
    request("/api/customer-invitation", null, {
      action: "accept",
      token,
      password,
      confirmPassword: password,
    }),
  );
  await result(accepted);
  const cleanerCookie = accepted.headers.get("set-cookie").split(";")[0];
  const restricted = await current(cleanerCookie);
  assert.deepEqual(
    restricted.properties.map((p) => p.id),
    [first.id],
  );
  assert.equal(JSON.stringify(restricted).includes("87654.32"), false);
  const q = `?view=availability&propertyId=${first.id}&from=2027-01-01&to=2027-01-02&showPrices=true`;
  const available = await result(
    await Operations.GET(
      request(`${base}/operations${q}`, cleanerCookie),
      context,
    ),
  );
  assert.equal(available.showPrices, false);
  assert.equal(JSON.stringify(available).includes('"amount"'), false);
  await result(
    await Operations.GET(
      request(
        `${base}/operations${q.replace(first.id, second.propertyId)}`,
        cleanerCookie,
      ),
      context,
    ),
    404,
  );
  await result(
    await Operations.GET(
      request(`${base}/operations?view=members`, cleanerCookie),
      context,
    ),
    403,
  );
  const bookingInput = {
    requestKey: randomUUID(),
    version: (await current(ownerCookie)).version,
    propertyId: first.id,
    stays: [
      {
        checkIn: "2027-01-05",
        checkOut: "2027-01-06",
        roomIds: first.rooms.map((r) => r.id),
      },
      {
        checkIn: "2027-01-08",
        checkOut: "2027-01-10",
        roomIds: [first.rooms[1].id],
      },
    ],
    total: 9000,
  };
  const created = await result(
    await Workspace.POST(request(base, ownerCookie, bookingInput), context),
    201,
  );
  const payment = {
    action: "payment",
    bookingId: created.bookingId,
    bookingVersion: 1,
    amount: 3000,
    kind: "deposit",
    receivedAt: "2026-01-01T00:00:00Z",
  };
  await write(payment, 403, cleanerCookie);
  const paid = await write(payment);
  assert.equal(paid.summary.remaining, 6000);
  const readClean = await current(cleanerCookie);
  assert.equal(readClean.bookings[0].total, null);
  assert.deepEqual(readClean.bookings[0].payments, []);
  const cleaner = (await store.read(accountKey("cleaner@example.test"))).value;
  await write({
    action: "member",
    accountId: cleaner.id,
    role: "viewer_no_price",
    allProperties: false,
    propertyIds: [first.id],
    active: false,
  });
  await result(await Workspace.GET(request(base, cleanerCookie), context), 404);
  assert.deepEqual(
    (
      await result(
        await Session.GET(request("/api/customer-session", cleanerCookie)),
      )
    ).workspaces,
    [],
  );
  const owner = await store.read(accountKey("owner@example.test"));
  const ownUrl =
    "https://docs.google.com/spreadsheets/d/own-source-synthetic-00000000/edit";
  const bind = (id, url) =>
    Import.POST(
      request(`${base}/import`, ownerCookie, {
        action: "bind",
        propertyId: id,
        url,
      }),
      context,
    );
  await result(await bind(second.propertyId, ownUrl), 403);
  await store.commit([
    {
      key: accountKey("owner@example.test"),
      before: owner.raw,
      after: { ...owner.value, emailVerifiedAt: new Date().toISOString() },
    },
  ]);
  const bound = await result(await bind(second.propertyId, ownUrl));
  assert.equal(bound.status, "approved");
  const third = await write({
    action: "property",
    name: "Third inn",
    kind: "rooms",
    rooms: ["201"],
    mode: "sheet",
  });
  const review = await result(
    await bind(
      third.propertyId,
      "https://docs.google.com/spreadsheets/d/other-source-synthetic-00000000/edit",
    ),
  );
  assert.equal(review.status, "approved");
  assert.equal(JSON.stringify(review).includes("Private source title"), false);
  assert.equal(
    external.some((url) =>
      url.startsWith("https://www.googleapis.com/drive/v3/files/"),
    ),
    false,
  );
  assert.equal(
    (await listSupportRequests(store)).filter((r) => r.kind === "source")
      .length,
    0,
  );
  await result(
    await Admin.GET(request("/api/onboarding-admin", ownerCookie)),
    403,
  );
  const tabs = await result(
    await Import.POST(
      request(`${base}/import`, ownerCookie, {
        action: "tabs",
        propertyId: third.propertyId,
      }),
      context,
    ),
  );
  assert.equal(tabs.title, "Private source title");
  const help = await result(
    await Import.POST(
      request(`${base}/import`, ownerCookie, {
        action: "help",
        propertyId: third.propertyId,
        message: "Synthetic nightly format assistance",
      }),
      context,
    ),
  );
  assert.equal(help.notification, "preview");
  assert.equal(
    (await listSupportRequests(store)).filter((r) => r.kind === "format")
      .length,
    1,
  );
  assert.equal(
    external.some((url) => /gmail|smtp|messages/.test(url)),
    false,
  );
});
