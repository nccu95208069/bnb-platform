import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  previewImport,
  commitImport,
  undoImport,
} from "../src/lib/customer-workspaces/sheet-import.ts";
import {
  beginGoogle,
  finishGoogle,
  readSheet,
  sourceFor,
  spreadsheetId,
} from "../src/lib/customer-workspaces/customer-google.ts";
import { view } from "../src/lib/customer-workspaces/service.ts";
import { RedisCustomerStore } from "../src/lib/customer-workspaces/store.ts";
function fixture() {
  const workspace = {
    id: "workspace-a",
    slug: "test-import",
    name: "Synthetic",
    version: 1,
    members: [
      {
        accountId: "owner-a",
        role: "owner",
        active: true,
        allProperties: true,
        propertyIds: [],
      },
    ],
    properties: [
      {
        id: "property-a",
        name: "Synthetic",
        kind: "mixed",
        sourceMode: "native",
        rooms: [
          { id: "room-a", name: "101" },
          { id: "room-b", name: "102" },
        ],
        villaRoomIds: ["room-a", "room-b"],
      },
    ],
    bookings: [],
    audit: [],
  };
  const data = new Map([
    ["slug:test-import", JSON.stringify(workspace.id)],
    ["workspace:workspace-a", JSON.stringify(workspace)],
  ]);
  const store = {
    data,
    read: async (key) => ({
      raw: data.get(key) ?? null,
      value: JSON.parse(data.get(key) ?? "null"),
    }),
    commit: async (changes) => {
      if (changes.some((c) => (data.get(c.key) ?? null) !== c.before))
        throw Error("VERSION_CONFLICT");
      for (const c of changes) data.set(c.key, JSON.stringify(c.after));
    },
    limit: async () => {},
  };
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
    roomMap: { villa: ["room-a", "room-b"], single: ["room-a"] },
    granularity: "order",
    amountBasis: "order",
    receivedMeaning: "guest",
    currency: "TWD",
    from: "2026-10-02",
  };
  const source = {
    spreadsheetId: "synthetic-spreadsheet-id-0000",
    sheetId: 0,
    title: "Synthetic / reservations",
    rows: [
      ["In", "Out", "Room", "Name", "ID", "Total", "Paid"],
      ["2026/10/1", "2026/10/3", "villa", "", "id-1", "", ""],
      [
        "2026-10-05",
        "2026-10-07",
        "single",
        "Example",
        "id-2",
        "3,000.25",
        "1000",
      ],
      ["2026-10-08", "2026-10-09", "unknown", "", "id-3", "", ""],
    ],
  };
  return {
    store,
    mapping,
    source,
    args: [store, "owner-a", "test-import", "property-a"],
    workspace,
  };
}
async function current(store) {
  return (await store.read("workspace:workspace-a")).value;
}
test("preview includes ongoing stays, null money, multiroom one order, quarantines unknown room; commit partial and repeat idempotently", async () => {
  const { store, args, source, mapping } = fixture();
  const p = await previewImport(...args, source, mapping);
  assert.equal(p.rows[0].issues.length, 0);
  assert.equal(p.rows[0].draft.total, null);
  assert.equal(p.rows[0].draft.roomIds.length, 2);
  assert.match(p.rows[2].issues.join(""), /房間尚未對應/);
  await assert.rejects(commitImport(...args, p.id, [4]), /INVALID_INPUT/);
  const batch = await commitImport(...args, p.id, [2, 3]);
  assert.equal(batch.bookingIds.length, 2);
  const w = await current(store);
  assert.equal(w.bookings[1].total, 3000.25);
  assert.deepEqual(w.bookings[1].payments, []);
  assert.equal(w.bookings[1].importedFinance.propertyReceived, null);
  assert.equal(w.bookings[1].importedFinance.guestPaid, 1000);
  assert.deepEqual(await commitImport(...args, p.id, [3, 2]), batch);
  await assert.rejects(
    commitImport(...args, p.id, [2]),
    /IDEMPOTENCY_CONFLICT/,
  );
  const again = await previewImport(
    ...args,
    { ...source, rows: [source.rows[0], source.rows[2], source.rows[1]] },
    mapping,
  );
  assert.ok(
    again.rows.every((r) => r.issues.some((x) => x.includes("已匯入"))),
  );
  const reader = {
    role: "viewer_no_price",
    allProperties: true,
    propertyIds: [],
  };
  assert.equal(JSON.stringify(view(w, reader)).includes("3000.25"), false);
  assert.equal(JSON.stringify(view(w, reader)).includes("guestPaid"), false);
});
test("nightly all-room total and actual property receipt remain distinct from transaction history", async () => {
  const { args, source, mapping, store } = fixture();
  const p = await previewImport(...args, source, {
    ...mapping,
    amountBasis: "night",
    receivedMeaning: "property",
  });
  await commitImport(...args, p.id, [3]);
  const b = (await current(store)).bookings[0];
  assert.equal(b.total, 6000.5);
  assert.equal(b.importedFinance.propertyReceived, 1000);
  assert.equal(b.importedFinance.guestPaid, null);
  assert.equal(b.payments.length, 0);
});
test("ambiguous duplicate IDs, repeated rows, invalid year and contradictory mappings do not import", async () => {
  const { args, source, mapping } = fixture();
  source.rows.push([
    "2026-11-01",
    "2026-11-02",
    "single",
    "Other",
    "id-2",
    "100",
    "",
  ]);
  source.rows.push(["10/5", "10/6", "single", "", "id-4", "", ""]);
  const p = await previewImport(...args, source, mapping);
  assert.match(p.rows[1].issues.join(""), /多列/);
  assert.match(p.rows[3].issues.join(""), /多列/);
  assert.equal(p.rows[4].draft, null);
  await assert.rejects(
    previewImport(...args, source, { ...mapping, granularity: "night" }),
    /INVALID_INPUT/,
  );
  await assert.rejects(
    previewImport(...args, source, { ...mapping, receivedMeaning: "none" }),
    /INVALID_INPUT/,
  );
});
test("cross-account, property and role access rejected; source and staged preview cannot be substituted", async () => {
  const { args, source, mapping, store } = fixture();
  const p = await previewImport(...args, source, mapping);
  await assert.rejects(
    commitImport(store, "outsider", "test-import", "property-a", p.id, [2]),
    /NOT_FOUND/,
  );
  let w = await current(store);
  w.members.push({
    accountId: "other-admin",
    role: "admin",
    active: true,
    allProperties: true,
    propertyIds: [],
  });
  w.members.push({
    accountId: "reader",
    role: "viewer",
    active: true,
    allProperties: true,
    propertyIds: [],
  });
  store.data.set("workspace:workspace-a", JSON.stringify(w));
  await assert.rejects(
    commitImport(store, "other-admin", "test-import", "property-a", p.id, [2]),
    /NOT_FOUND/,
  );
  await assert.rejects(
    previewImport(
      store,
      "reader",
      "test-import",
      "property-a",
      source,
      mapping,
    ),
    /FORBIDDEN/,
  );
  await assert.rejects(
    previewImport(
      store,
      "owner-a",
      "test-import",
      "property-b",
      source,
      mapping,
    ),
    /NOT_FOUND/,
  );
});
test("stale preview and concurrent commits are rejected, lost response recovers one batch", async () => {
  const { args, source, mapping, store } = fixture();
  const p = await previewImport(...args, source, mapping);
  const second = await previewImport(...args, source, mapping);
  const attempts = await Promise.allSettled([
    commitImport(...args, p.id, [2]),
    commitImport(...args, second.id, [2]),
  ]);
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
  assert.equal((await current(store)).bookings.length, 1);
  const fresh = await previewImport(...args, source, mapping);
  const commit = store.commit;
  let fail = true;
  store.commit = async (changes) => {
    await commit(changes);
    if (fail) {
      fail = false;
      throw Error("STORE_UNAVAILABLE");
    }
  };
  await assert.rejects(
    commitImport(...args, fresh.id, [3]),
    /STORE_UNAVAILABLE/,
  );
  const recovered = await commitImport(...args, fresh.id, [3]);
  assert.equal(recovered.bookingIds.length, 1);
  assert.equal((await current(store)).bookings.length, 2);
  await assert.rejects(
    commitImport(...args, second.id, [3]),
    /VERSION_CONFLICT/,
  );
});
test("undo cancels unchanged only, keeps modified bookings, retains audit and stable replay", async () => {
  const { args, source, mapping, store } = fixture();
  const p = await previewImport(...args, source, mapping);
  const batch = await commitImport(...args, p.id, [2, 3]);
  let w = await current(store);
  w.bookings[1].version++;
  w.bookings[1].guestName = "Edited";
  w.version++;
  store.data.set("workspace:workspace-a", JSON.stringify(w));
  const result = await undoImport(...args, batch.id, w.version);
  assert.equal(result.cancelled.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(await undoImport(...args, batch.id, 1), result);
  w = await current(store);
  assert.equal(w.bookings[0].status, "cancelled");
  assert.equal(w.bookings[1].status, "confirmed");
  assert.equal(w.audit.at(-1).action, "sheet.undo");
});
function config() {
  process.env.CUSTOMER_GOOGLE_CLIENT_ID = "synthetic-client";
  process.env.CUSTOMER_GOOGLE_CLIENT_SECRET = "synthetic-secret";
  process.env.CUSTOMER_GOOGLE_REDIRECT_URI =
    "https://test.local/api/customer-google/callback";
  process.env.CUSTOMER_GOOGLE_TOKEN_KEY = Buffer.alloc(32, 7).toString(
    "base64",
  );
}
test("Google OAuth uses PKCE, one-use state, browser binding, encrypted scoped short-lived token and readonly Sheets", async (t) => {
  config();
  const { args, store } = fixture();
  const started = await beginGoogle(...args);
  const url = new URL(started.url),
    state = url.searchParams.get("state");
  assert.equal(
    url.searchParams.get("scope"),
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  );
  assert.equal(url.searchParams.get("access_type"), "online");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  await assert.rejects(
    finishGoogle(store, "owner-a", state, "wrong", "code"),
    /FORBIDDEN/,
  );
  await assert.rejects(
    finishGoogle(store, "outsider", state, started.nonce, "code"),
    /FORBIDDEN/,
  );
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      const body = new URLSearchParams(options.body);
      assert.equal(
        createHash("sha256")
          .update(body.get("code_verifier"))
          .digest("base64url"),
        new URL(started.url).searchParams.get("code_challenge"),
      );
      return Response.json({
        access_token: "synthetic-google-token",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      });
    }
    assert.equal(
      options.headers.Authorization,
      "Bearer synthetic-google-token",
    );
    assert.ok(String(url).startsWith("https://sheets.googleapis.com/"));
    if (String(url).includes("/values/"))
      return Response.json({
        values: [
          ["in", "out"],
          ["2026-10-01", "2026-10-02"],
        ],
      });
    return Response.json({
      properties: { title: "Synthetic" },
      sheets: [{ properties: { sheetId: 0, title: "Bob's tab" } }],
    });
  });
  await finishGoogle(store, "owner-a", state, started.nonce, "synthetic-code");
  assert.equal(
    [...store.data.values()].join("").includes("synthetic-google-token"),
    false,
  );
  await assert.rejects(
    finishGoogle(store, "owner-a", state, started.nonce, "synthetic-code"),
    /FORBIDDEN/,
  );
  const snapshot = await readSheet(...args, "synthetic-spreadsheet-id-0000", 0);
  assert.equal(snapshot.rows.length, 2);
  assert.equal((await sourceFor(...args, snapshot.id)).sheetId, 0);
  await assert.rejects(
    sourceFor(store, "outsider", "test-import", "property-a", snapshot.id),
    /NOT_FOUND/,
  );
  assert.throws(
    () =>
      spreadsheetId(
        "https://evil.example/spreadsheets/d/synthetic-spreadsheet-id-0000",
      ),
    /INVALID_INPUT/,
  );
});
test("Google expired state and missing consent never save a connection", async (t) => {
  config();
  const { args, store } = fixture();
  const start = await beginGoogle(...args),
    state = new URL(start.url).searchParams.get("state");
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      access_token: "do-not-store",
      expires_in: 3600,
      scope: "openid",
    }),
  );
  await assert.rejects(
    finishGoogle(store, "owner-a", state, start.nonce, "code"),
    /GOOGLE_CONNECT_FAILED/,
  );
  assert.equal(
    [...store.data.keys()].some((k) => k.startsWith("customer-google:")),
    false,
  );
  const start2 = await beginGoogle(...args);
  const key = [...store.data.keys()]
    .filter((k) => k.startsWith("google-state:"))
    .at(-1);
  const data = JSON.parse(store.data.get(key));
  data.expiresAt = 0;
  store.data.set(key, JSON.stringify(data));
  await assert.rejects(
    finishGoogle(
      store,
      "owner-a",
      new URL(start2.url).searchParams.get("state"),
      start2.nonce,
      "code",
    ),
    /FORBIDDEN/,
  );
});
test("Redis commit keeps CAS atomic and emits expiry for OAuth and preview records", async (t) => {
  process.env.KV_REST_API_URL = "https://redis.invalid";
  process.env.KV_REST_API_TOKEN = "synthetic";
  let command;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    command = JSON.parse(options.body);
    return Response.json({ result: 1 });
  });
  await new RedisCustomerStore().commit([
    { key: "temporary", before: null, after: { test: true }, ttlSeconds: 600 },
  ]);
  assert.match(command[1], /EXPIRE/);
  assert.equal(command.at(-1), 600);
  assert.equal(command[2], 1);
});
