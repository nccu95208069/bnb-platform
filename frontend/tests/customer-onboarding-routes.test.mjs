import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as Intake from "../src/app/api/customer-intake/route.ts";
import * as SheetCheck from "../src/app/api/customer-intake/sheet-check/route.ts";
import * as Account from "../src/app/api/customer-account/route.ts";
import * as Session from "../src/app/api/customer-session/route.ts";
import * as Admin from "../src/app/api/onboarding-admin/route.ts";
import * as Import from "../src/app/api/customer-workspaces/[slug]/import/route.ts";
import * as Calendar from "../src/app/api/customer-workspaces/[slug]/route.ts";
import {
  accountLinkUrl,
  issueAccountLink,
} from "../src/lib/customer-workspaces/account-links.ts";
import { RedisCustomerStore } from "../src/lib/customer-workspaces/store.ts";
const origin = "https://onboarding.test";
function req(path, input, cookie, requestOrigin = origin, method = "POST") {
  return new NextRequest(origin + path, {
    method,
    headers: { origin: requestOrigin, ...(cookie ? { cookie } : {}) },
    ...(method === "GET" ? {} : { body: JSON.stringify(input) }),
  });
}
test("public check -> receipt -> verified account -> source preview -> changed-source refusal -> persisted calendar; admin and foreign sources remain protected", async (t) => {
  process.env.CUSTOMER_WORKSPACES_ENABLED = "true";
  process.env.CUSTOMER_ONBOARDING_ENABLED = "true";
  process.env.CUSTOMER_INTAKE_ENABLED = "true";
  process.env.CUSTOMER_INTAKE_PREVIEW = "true";
  process.env.CUSTOMER_SESSION_SECRET =
    "synthetic-route-onboarding-secret-only";
  process.env.KV_REST_API_URL = "https://redis.invalid";
  process.env.KV_REST_API_TOKEN = "synthetic";
  delete process.env.CUSTOMER_SELF_SIGNUP_PREVIEW;
  delete process.env.CALENDAR_OWNER_PASSWORD;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.CUSTOMER_SHEET_READER_CREDENTIALS = JSON.stringify({
    client_email: "reader@synthetic.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const data = new Map(),
    googleUrls = [];
  let readable = false;
  const rows = [
    ["In", "Out", "Room", "Name", "ID", "Total", "Received"],
    ["2026-10-10", "2026-10-12", "101", "Synthetic", "ONE", "6000", "2000"],
  ];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === "https://redis.invalid") {
      const c = JSON.parse(options.body);
      let result = null;
      if (c[0] === "GET") result = data.get(c[1]) ?? null;
      if (c[0] === "EVAL") {
        if (c[1].includes("INCR")) result = 1;
        else {
          const keys = c.slice(3, 3 + c[2]),
            args = c.slice(3 + c[2]),
            step = c[1].includes("i*3") ? 3 : 2;
          result = keys.every((k, i) => (data.get(k) ?? "") === args[i * step])
            ? 1
            : 0;
          if (result) keys.forEach((k, i) => data.set(k, args[i * step + 1]));
        }
      }
      return Response.json({ result });
    }
    const u = String(url);
    googleUrls.push(u);
    if (u === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "synthetic" });
    if (!readable) return Response.json({ error: "denied" }, { status: 403 });
    if (u.startsWith("https://www.googleapis.com/drive/v3/files/"))
      return Response.json({
        owners: [{ emailAddress: "applicant@example.test" }],
      });
    if (u.includes("/values/")) return Response.json({ values: rows });
    if (u.startsWith("https://sheets.googleapis.com/v4/spreadsheets/"))
      return Response.json({
        properties: { title: "Private synthetic" },
        sheets: [
          {
            properties: {
              sheetId: 0,
              title: "Orders",
              gridProperties: { rowCount: 100, columnCount: 8 },
            },
          },
        ],
      });
    throw new Error("Unexpected external call, including real email");
  });
  const url =
    "https://docs.google.com/spreadsheets/d/synthetic-bound-sheet-00000000/edit";
  assert.equal(
    (
      await SheetCheck.POST(
        req(
          "/api/customer-intake/sheet-check",
          { url },
          null,
          "https://evil.test",
        ),
      )
    ).status,
    403,
  );
  let r = await SheetCheck.POST(
    req("/api/customer-intake/sheet-check", { url }),
  );
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, "SHEET_NOT_SHARED");
  readable = true;
  r = await SheetCheck.POST(req("/api/customer-intake/sheet-check", { url }));
  const check = await r.json();
  assert.equal(check.readable, true);
  assert.equal(JSON.stringify(check).includes("Private synthetic"), false);
  assert.equal(
    (await Admin.GET(req("/api/onboarding-admin", null, null, origin, "GET")))
      .status,
    403,
  );
  const input = {
    requestKey: randomUUID(),
    intent: "join",
    propertyName: "Synthetic",
    kind: "rooms",
    rooms: ["101"],
    source: "sheet",
    sheetUrl: url,
    sharingDeclared: true,
    contactName: "Synthetic",
    email: "applicant@example.test",
    consent: true,
  };
  r = await Intake.POST(req("/api/customer-intake", input));
  assert.equal(r.status, 201);
  const receipt = await r.json();
  assert.equal(receipt.applicantNotification, "preview");
  assert.equal(receipt.sheetAccess, "verified");
  assert.equal(
    JSON.stringify(receipt).includes("applicant@example.test"),
    false,
  );
  assert.deepEqual(
    await (await Intake.POST(req("/api/customer-intake", input))).json(),
    receipt,
  );
  const store = new RedisCustomerStore(),
    link = await issueAccountLink(
      store,
      "onboarding",
      input.requestKey,
      input.email,
    ),
    token = accountLinkUrl(link).split("#")[1],
    password = "Synthetic route passphrase 88!";
  r = await Account.POST(
    req(
      "/api/customer-account",
      { action: "activate", token, password, confirmPassword: password },
      null,
      "https://evil.test",
    ),
  );
  assert.equal(r.status, 403);
  r = await Account.POST(
    req("/api/customer-account", {
      action: "activate",
      token,
      password,
      confirmPassword: password,
    }),
  );
  assert.equal(r.status, 200);
  const accountResult = await r.json(),
    slug = accountResult.destination.split("/")[2],
    cookie =
      "bnb_customer_session=" + r.cookies.get("bnb_customer_session").value,
    context = { params: Promise.resolve({ slug }) };
  const profile = await (
    await Session.GET(req("/api/customer-session", null, cookie, origin, "GET"))
  ).json();
  assert.equal(profile.workspaces.length, 1);
  const initial = await (
      await Calendar.GET(
        req("/api/customer-workspaces/" + slug, null, cookie, origin, "GET"),
        context,
      )
    ).json(),
    propertyId = initial.properties[0].id;
  const call = (input) =>
    Import.POST(
      req(
        "/api/customer-workspaces/" + slug + "/import",
        { ...input, propertyId },
        cookie,
      ),
      context,
    );
  const tabs = await (
    await call({ action: "tabs", url: "https://attacker.invalid/" })
  ).json();
  assert.equal(tabs.spreadsheetId, "synthetic-bound-sheet-00000000");
  assert.ok(googleUrls.every((u) => !u.includes("attacker")));
  let source = await (
    await call({
      action: "read",
      spreadsheetId: "foreign-sheet-id-00000000",
      sheetId: 0,
    })
  ).json();
  assert.equal(source.rows.length, 2);
  assert.ok(googleUrls.every((u) => !u.includes("foreign-sheet")));
  const mapping = {
    headerRow: 1,
    columns: {
      checkIn: 0,
      checkOut: 1,
      rooms: 2,
      guestName: 3,
      externalId: 4,
      total: 5,
      received: 6,
    },
    roomMap: { 101: [initial.properties[0].rooms[0].id] },
    granularity: "order",
    amountBasis: "order",
    receivedMeaning: "property",
    currency: "TWD",
    from: "2026-10-01",
  };
  let preview = await (
    await call({ action: "preview", sourceId: source.id, mapping })
  ).json();
  rows[1][5] = "6500";
  r = await call({
    action: "commit",
    previewId: preview.id,
    selected: [2],
    confirmed: true,
  });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "SOURCE_CHANGED");
  let calendar = await (
    await Calendar.GET(
      req("/api/customer-workspaces/" + slug, null, cookie, origin, "GET"),
      context,
    )
  ).json();
  assert.equal(calendar.bookings.length, 0);
  source = await (await call({ action: "read", sheetId: 0 })).json();
  preview = await (
    await call({ action: "preview", sourceId: source.id, mapping })
  ).json();
  r = await call({
    action: "commit",
    previewId: preview.id,
    selected: [2],
    confirmed: true,
  });
  assert.equal(r.status, 200);
  const batch = await r.json();
  readable = false;
  assert.deepEqual(
    await (
      await call({
        action: "commit",
        previewId: preview.id,
        selected: [2],
        confirmed: true,
      })
    ).json(),
    batch,
  );
  calendar = await (
    await Calendar.GET(
      req("/api/customer-workspaces/" + slug, null, cookie, origin, "GET"),
      context,
    )
  ).json();
  assert.equal(calendar.bookings.length, 1);
  assert.equal(calendar.bookings[0].total, 6500);
  assert.equal(calendar.onboarding.complete, true);
  assert.equal(
    (
      await Calendar.GET(
        req("/api/customer-workspaces/" + slug, null, null, origin, "GET"),
        context,
      )
    ).status,
    401,
  );
  const forbidden = await Session.POST(
    req("/api/customer-session", {
      mode: "register",
      email: "new@example.test",
      password,
      confirmPassword: password,
    }),
  );
  assert.equal(forbidden.status, 403);
});
