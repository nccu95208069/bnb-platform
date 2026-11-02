import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as Operations from "../src/app/api/customer-workspaces/[slug]/operations/route.ts";
import { RedisCustomerStore } from "../src/lib/customer-workspaces/store.ts";
import { accountKey, sessionFor } from "../src/lib/customer-workspaces/auth.ts";
import { newPasswordlessCredential } from "../src/lib/customer-workspaces/identity.ts";
import { fixture } from "./helpers/order-fixture.mjs";
const origin = "https://orders.test",
  path = "/api/customer-workspaces/test-orders/operations",
  context = { params: Promise.resolve({ slug: "test-orders" }) };
function request(cookie, query = "", input, requestOrigin = origin) {
  return new NextRequest(origin + path + query, {
    method: input ? "POST" : "GET",
    headers: { origin: requestOrigin, ...(cookie ? { cookie } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
}
test("order query and month endpoints enforce sessions, property scope and redaction; edits verify origin, roles and durable retry", async (t) => {
  process.env.CUSTOMER_WORKSPACES_ENABLED = "true";
  process.env.CUSTOMER_SESSION_SECRET = "synthetic-order-routes-secret-2026";
  const f = fixture(),
    snapshot = await f.store.read("workspace:ws");
  const accounts = ["owner", "limited", "hidden"].map((name) => ({
    id: randomUUID(),
    email: `${name}@example.test`,
    credential: newPasswordlessCredential(),
    workspaces: [],
  }));
  const w = snapshot.value;
  w.members.push(
    ...accounts.map((a, i) => ({ ...w.members[i], accountId: a.id })),
  );
  await f.store.commit([
    { key: "workspace:ws", before: snapshot.raw, after: w },
    ...accounts.map((a) => ({
      key: accountKey(a.email),
      before: null,
      after: a,
    })),
  ]);
  for (const name of ["read", "commit", "limit"])
    t.mock.method(RedisCustomerStore.prototype, name, (...args) =>
      f.store[name](...args),
    );
  const cookies = accounts.map((a) => `bnb_customer_session=${sessionFor(a)}`);
  assert.equal(
    (await Operations.GET(request(null, "?view=orders"), context)).status,
    401,
  );
  const owner = await Operations.GET(
    request(cookies[0], "?view=orders&q=test-123"),
    context,
  );
  assert.equal(owner.status, 200);
  assert.match(owner.headers.get("cache-control"), /private, no-store/);
  assert.equal((await owner.json()).total, 1);
  assert.equal(
    (
      await Operations.GET(
        request(cookies[1], "?view=orders&property=p1"),
        context,
      )
    ).status,
    404,
  );
  const hidden = await (
    await Operations.GET(request(cookies[2], "?view=orders"), context)
  ).json();
  assert.equal(hidden.bookings[0].total, null);
  assert.deepEqual(hidden.bookings[0].payments, []);
  assert.equal(hidden.bookings[0].notes, null);
  const month = await (
    await Operations.GET(
      request(cookies[0], "?view=calendar&property=p1&month=2027-02"),
      context,
    )
  ).json();
  assert.equal(month.properties.length, 1);
  assert.equal(month.bookings.length, 1);
  assert.equal(month.bookings[0].checkIn, "2027-01-31");
  assert.equal(
    (
      await Operations.GET(
        request(cookies[1], "?view=calendar&property=p1&month=2027-02"),
        context,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await Operations.GET(
        request(cookies[0], "?view=calendar&property=p1&month=bad"),
        context,
      )
    ).status,
    400,
  );
  const input = await f.input({
    action: "order-details",
    notes: "HTTP persisted note",
  });
  assert.equal(
    (
      await Operations.POST(
        request(cookies[0], "", input, "https://elsewhere.test"),
        context,
      )
    ).status,
    403,
  );
  assert.equal(
    (await Operations.POST(request(cookies[2], "", input), context)).status,
    403,
  );
  assert.equal(
    (await Operations.POST(request(cookies[1], "", input), context)).status,
    404,
  );
  const saved = await Operations.POST(request(cookies[0], "", input), context);
  assert.equal(saved.status, 200);
  const retry = await Operations.POST(request(cookies[0], "", input), context);
  assert.equal(retry.status, 200);
  assert.equal((await f.current()).audit.length, 1);
  const read = await (
    await Operations.GET(request(cookies[0], "?view=orders&q=HTTP"), context)
  ).json();
  assert.equal(read.bookings[0].notes, "HTTP persisted note");
});
