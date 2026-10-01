import test from "node:test";
import assert from "node:assert/strict";
import {
  createBooking,
  createWorkspace,
  loadWorkspace,
  view,
} from "../src/lib/customer-workspaces/service.ts";
import {
  accountKey,
  authenticate,
  login,
  sessionFor,
} from "../src/lib/customer-workspaces/auth.ts";
process.env.CUSTOMER_WORKSPACES_ENABLED = "true";
process.env.CUSTOMER_SESSION_SECRET =
  "synthetic-customer-secret-for-tests-only";
function fixture() {
  const values = new Map();
  return {
    values,
    read: async (key) => {
      const raw = values.get(key) ?? null;
      return { raw, value: raw === null ? null : JSON.parse(raw) };
    },
    commit: async (changes) => {
      if (changes.some((c) => (values.get(c.key) ?? null) !== c.before))
        throw new Error("VERSION_CONFLICT");
      for (const c of changes) values.set(c.key, JSON.stringify(c.after));
    },
    limit: async () => {},
  };
}
const password = "Synthetic customer passphrase 2026!";
async function customer(store, email, slug, kind = "mixed") {
  const account = await login(store, {
    mode: "register",
    email,
    password,
    confirmPassword: password,
  });
  await createWorkspace(store, account, {
    name: "Synthetic inn",
    slug,
    kind,
    rooms: ["101", "102"],
    requestKey: `setup-${slug}-00000000`,
  });
  const { workspace } = await loadWorkspace(store, account.id, slug);
  return { account, workspace, property: workspace.properties[0] };
}
function booking(workspace, property, extra = {}) {
  return {
    requestKey: "booking-request-0001",
    version: workspace.version,
    propertyId: property.id,
    roomIds: property.rooms.map((r) => r.id),
    checkIn: "2026-10-05",
    checkOut: "2026-10-07",
    ...extra,
  };
}
test("two customer identities with identical room names remain isolated; forged property and slug rejected", async () => {
  const store = fixture(),
    a = await customer(store, "a@example.test", "test-a"),
    b = await customer(store, "b@example.test", "test-b");
  await assert.rejects(
    loadWorkspace(store, b.account.id, "test-a"),
    /NOT_FOUND/,
  );
  await assert.rejects(
    createBooking(
      store,
      b.account.id,
      "test-a",
      booking(a.workspace, a.property),
    ),
    /NOT_FOUND/,
  );
  await assert.rejects(
    createBooking(
      store,
      b.account.id,
      "test-b",
      booking(b.workspace, a.property),
    ),
    /NOT_FOUND/,
  );
  const first = await createBooking(
    store,
    a.account.id,
    "test-a",
    booking(a.workspace, a.property),
  );
  const second = await createBooking(
    store,
    b.account.id,
    "test-b",
    booking(b.workspace, b.property),
  );
  assert.notEqual(first.booking.id, second.booking.id);
  assert.equal(first.booking.total, null);
  assert.equal(first.booking.guestName, null);
  assert.equal(first.booking.payments.length, 0);
  assert.equal(first.workspace.bookings.length, 1);
  assert.equal(second.workspace.bookings.length, 1);
  assert.equal(
    JSON.stringify(second.workspace).includes(first.booking.id),
    false,
  );
  await assert.rejects(
    loadWorkspace(store, "calendar-owner", "test-a"),
    /NOT_FOUND/,
  );
});
test("multiroom finance occurs once; exact retries return same order and changed retries are rejected", async () => {
  const store = fixture(),
    c = await customer(store, "finance@example.test", "test-finance");
  const input = booking(c.workspace, c.property, {
    total: 3000.25,
    payment: {
      amount: 1000,
      kind: "deposit",
      receivedAt: "2026-10-01T10:00:00+08:00",
      method: "cash",
    },
  });
  const first = await createBooking(store, c.account.id, "test-finance", input);
  const retry = await createBooking(store, c.account.id, "test-finance", input);
  assert.equal(retry.booking.id, first.booking.id);
  assert.equal(retry.workspace.bookings.length, 1);
  assert.equal(first.booking.payments.length, 1);
  assert.equal(first.booking.total, 3000.25);
  assert.equal(first.booking.guestNotified, false);
  assert.equal(
    first.booking.payments[0].receivedAt,
    "2026-10-01T02:00:00.000Z",
  );
  await assert.rejects(
    createBooking(store, c.account.id, "test-finance", {
      ...input,
      total: 4000,
    }),
    /IDEMPOTENCY_CONFLICT/,
  );
});
test("villa blocks individual rooms, individual room blocks villa, checkout remains available, concurrent writes cannot overlap", async () => {
  const store = fixture(),
    c = await customer(store, "inventory@example.test", "test-inventory");
  const input = booking(c.workspace, c.property);
  const attempts = await Promise.allSettled([
    createBooking(store, c.account.id, "test-inventory", input),
    createBooking(store, c.account.id, "test-inventory", {
      ...input,
      requestKey: "booking-request-0002",
    }),
  ]);
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
  let current = (await loadWorkspace(store, c.account.id, "test-inventory"))
    .workspace;
  await assert.rejects(
    createBooking(
      store,
      c.account.id,
      "test-inventory",
      booking(current, c.property, {
        roomIds: [c.property.rooms[0].id],
        requestKey: "booking-request-0003",
      }),
    ),
    /ROOM_CONFLICT/,
  );
  await createBooking(
    store,
    c.account.id,
    "test-inventory",
    booking(current, c.property, {
      roomIds: [c.property.rooms[0].id],
      requestKey: "booking-request-0004",
      checkIn: "2026-10-07",
      checkOut: "2026-10-08",
      total: 0,
    }),
  );
  current = (await loadWorkspace(store, c.account.id, "test-inventory"))
    .workspace;
  await assert.rejects(
    createBooking(
      store,
      c.account.id,
      "test-inventory",
      booking(current, c.property, {
        requestKey: "booking-request-0005",
        checkIn: "2026-10-07",
        checkOut: "2026-10-08",
      }),
    ),
    /ROOM_CONFLICT/,
  );
  assert.equal(current.bookings[1].total, 0);
});
test("roles and all-properties stay inside workspace; price hiding excludes money embedded in notes", async () => {
  const store = fixture(),
    c = await customer(store, "roles@example.test", "test-roles");
  await createBooking(
    store,
    c.account.id,
    "test-roles",
    booking(c.workspace, c.property, {
      total: 12345.67,
      notes: "collected 12345.67",
      contact: "pay 12345.67",
    }),
  );
  let snapshot = await store.read(`workspace:${c.workspace.id}`);
  const member = {
    accountId: "reader",
    role: "viewer_no_price",
    active: true,
    allProperties: true,
    propertyIds: [],
  };
  snapshot.value.members.push(member);
  await store.commit([
    {
      key: `workspace:${c.workspace.id}`,
      before: snapshot.raw,
      after: snapshot.value,
    },
  ]);
  let loaded = await loadWorkspace(store, "reader", "test-roles");
  const projected = view(loaded.workspace, loaded.member);
  assert.equal(JSON.stringify(projected).includes("12345.67"), false);
  assert.equal(JSON.stringify(projected).includes("requestHash"), false);
  await assert.rejects(
    createBooking(
      store,
      "reader",
      "test-roles",
      booking(loaded.workspace, c.property),
    ),
    /FORBIDDEN/,
  );
  member.role = "admin";
  member.allProperties = false;
  member.propertyIds = ["unrelated-property"];
  snapshot = await store.read(`workspace:${c.workspace.id}`);
  snapshot.value.members[1] = member;
  await store.commit([
    {
      key: `workspace:${c.workspace.id}`,
      before: snapshot.raw,
      after: snapshot.value,
    },
  ]);
  loaded = await loadWorkspace(store, "reader", "test-roles");
  assert.equal(view(loaded.workspace, loaded.member).bookings.length, 0);
  await assert.rejects(
    createBooking(
      store,
      "reader",
      "test-roles",
      booking(loaded.workspace, c.property),
    ),
    /NOT_FOUND/,
  );
  member.active = false;
  snapshot = await store.read(`workspace:${c.workspace.id}`);
  snapshot.value.members[1] = member;
  await store.commit([
    {
      key: `workspace:${c.workspace.id}`,
      before: snapshot.raw,
      after: snapshot.value,
    },
  ]);
  await assert.rejects(
    loadWorkspace(store, "reader", "test-roles"),
    /NOT_FOUND/,
  );
});
test("session is purpose-separated and password-bound; account registration and workspace setup persist and retry", async () => {
  const store = fixture(),
    c = await customer(store, "session@example.test", "test-session");
  const token = sessionFor(c.account);
  assert.equal((await authenticate(store, token)).id, c.account.id);
  await assert.rejects(
    authenticate(store, `${token.slice(0, -1)}!`),
    /UNAUTHORIZED/,
  );
  await assert.rejects(
    authenticate(store, token, Date.now() + 8 * 86400000),
    /UNAUTHORIZED/,
  );
  await assert.rejects(
    login(store, { email: c.account.email, password: "wrong" }),
    /UNAUTHORIZED/,
  );
  const repeated = await createWorkspace(store, c.account, {
    name: "Synthetic inn",
    slug: "test-session",
    kind: "mixed",
    rooms: ["101", "102"],
    requestKey: "setup-test-session-00000000",
  });
  assert.equal(repeated.id, c.workspace.id);
  assert.equal(
    (await store.read(accountKey(c.account.email))).value.workspaces.length,
    1,
  );
  const raw = [...store.values.values()].join("");
  assert.equal(raw.includes(password), false);
  await assert.rejects(
    createWorkspace(store, c.account, {
      name: "other",
      slug: "test-session",
      kind: "rooms",
      rooms: ["101"],
      requestKey: "different-setup-0000",
    }),
    /SLUG_EXISTS/,
  );
});
test("invalid dates, missing rooms, decimal precision and stale versions fail before any write", async () => {
  const store = fixture(),
    c = await customer(
      store,
      "validation@example.test",
      "test-validation",
      "villa",
    );
  for (const extra of [
    { checkIn: "2026-02-30" },
    { checkOut: "2026-10-05" },
    { roomIds: [] },
    { roomIds: [c.property.rooms[0].id] },
    { total: 1.001 },
    { total: -1 },
    { payment: { amount: 100, kind: "deposit", receivedAt: "unknown" } },
  ]) {
    await assert.rejects(
      createBooking(
        store,
        c.account.id,
        "test-validation",
        booking(c.workspace, c.property, extra),
      ),
      /INVALID_INPUT/,
    );
  }
  await assert.rejects(
    createBooking(
      store,
      c.account.id,
      "test-validation",
      booking(c.workspace, c.property, { version: 0 }),
    ),
    /VERSION_CONFLICT/,
  );
  assert.equal(
    (await loadWorkspace(store, c.account.id, "test-validation")).workspace
      .bookings.length,
    0,
  );
});
test("lost response after atomic commit is recoverable using original request key", async () => {
  const store = fixture(),
    c = await customer(store, "lost@example.test", "test-lost");
  const commit = store.commit;
  let fail = true;
  store.commit = async (changes) => {
    await commit(changes);
    if (fail) {
      fail = false;
      throw new Error("STORE_UNAVAILABLE");
    }
  };
  const input = booking(c.workspace, c.property);
  await assert.rejects(
    createBooking(store, c.account.id, "test-lost", input),
    /STORE_UNAVAILABLE/,
  );
  const retry = await createBooking(store, c.account.id, "test-lost", input);
  assert.equal(retry.workspace.bookings.length, 1);
});
