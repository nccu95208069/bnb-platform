import test from "node:test";
import assert from "node:assert/strict";
import { accountKey, login } from "../src/lib/customer-workspaces/auth.ts";
import {
  createWorkspace,
  createBooking,
  loadWorkspace,
  view,
} from "../src/lib/customer-workspaces/service.ts";
import {
  addProperty,
  availability,
  bookingOperation,
  saveAvailabilityList,
  setPricing,
} from "../src/lib/customer-workspaces/operations.ts";
import {
  acceptInvitation,
  createInvitation,
  invitationInfo,
  invitationUrl,
  manageMember,
  memberSettings,
} from "../src/lib/customer-workspaces/invitations.ts";
import { financeSummary } from "../src/lib/customer-workspaces/domain.ts";
import { suggestFormat } from "../src/lib/customer-workspaces/format-assistant.ts";
import { reviewSupport } from "../src/lib/customer-workspaces/support.ts";
import {
  previewImport,
  commitImport,
  undoImport,
} from "../src/lib/customer-workspaces/sheet-import.ts";
process.env.CUSTOMER_WORKSPACES_ENABLED = "true";
process.env.CUSTOMER_SELF_SIGNUP_PREVIEW = "true";
process.env.CUSTOMER_SESSION_SECRET =
  "synthetic-customer-operations-secret-2026";
const password = "Synthetic operations password 2026!";
const receivedAt = "2026-01-01T10:00:00+08:00";
function storeFixture() {
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
async function fixture() {
  const store = storeFixture(),
    account = await login(store, {
      mode: "register",
      email: "owner@example.test",
      password,
      confirmPassword: password,
    });
  await createWorkspace(store, account, {
    name: "Synthetic guesthouses",
    slug: "test-operations",
    rooms: ["101", "102", "103"],
    kind: "mixed",
    requestKey: "workspace-synthetic-001",
  });
  const current = async () =>
    (await loadWorkspace(store, account.id, "test-operations")).workspace;
  const workspace = await current();
  let n = 0;
  const command = async (input) => ({
    version: (await current()).version,
    requestKey: `operation-synthetic-${++n}`,
    ...input,
  });
  return {
    store,
    account,
    workspace,
    property: workspace.properties[0],
    current,
    command,
    slug: workspace.slug,
  };
}
async function invite(f, email, permissions = {}) {
  const result = await createInvitation(
    f.store,
    f.account,
    f.slug,
    await f.command({
      email,
      role: "viewer_no_price",
      allProperties: false,
      propertyIds: [f.property.id],
      ...permissions,
    }),
  );
  return {
    ...result,
    token: invitationUrl(result.workspace.id, result.invitation).split("#")[1],
  };
}
async function booking(f, extra = {}) {
  const current = await f.current();
  return createBooking(
    f.store,
    f.account.id,
    f.slug,
    await f.command({
      propertyId: f.property.id,
      checkIn: "2027-01-05",
      checkOut: "2027-01-06",
      roomIds: [f.property.rooms[0].id],
      total: 9000,
      ...extra,
      version: current.version,
    }),
  );
}
test("a pending source approval cannot restore a removed administrator's scope", async () => {
  const f = await fixture();
  const invited = await invite(f, "former-admin@example.test", {
    role: "admin",
  });
  const accepted = await acceptInvitation(
    f.store,
    invited.token,
    password,
    password,
  );
  const id = "a".repeat(64);
  await f.store.commit([
    {
      key: `support:${id}`,
      before: null,
      after: {
        id,
        kind: "source",
        workspaceId: f.workspace.id,
        slug: f.slug,
        propertyId: f.property.id,
        propertyName: f.property.name,
        accountId: accepted.account.id,
        email: accepted.account.email,
        message: "Synthetic source approval",
        sheetUrl: "https://docs.google.com/spreadsheets/d/synthetic/edit",
        status: "open",
        createdAt: new Date().toISOString(),
      },
    },
  ]);
  await manageMember(
    f.store,
    f.account.id,
    f.slug,
    await f.command({
      action: "member",
      accountId: accepted.account.id,
      role: "viewer_no_price",
      active: true,
      allProperties: false,
      propertyIds: [f.property.id],
    }),
  );
  await assert.rejects(
    reviewSupport(
      f.store,
      "operator",
      {
        id,
        action: "source-approve",
        confirmIdentity: true,
      },
      async () => {
        throw new Error("unexpected mail");
      },
      true,
    ),
    /FORBIDDEN/,
  );
  assert.equal((await f.store.read(`support:${id}`)).value.status, "open");
});
test("one order contains three rooms, one deposit and separate date segments without blocking the gaps", async () => {
  const f = await fixture(),
    ids = f.property.rooms.map((r) => r.id);
  const result = await booking(f, {
    stays: [
      { checkIn: "2027-01-05", checkOut: "2027-01-06", roomIds: ids },
      { checkIn: "2027-01-08", checkOut: "2027-01-10", roomIds: [ids[1]] },
    ],
    payment: { amount: 3000, kind: "deposit", receivedAt, method: "cash" },
  });
  assert.equal(result.booking.payments.length, 1);
  assert.equal(financeSummary(result.booking).remaining, 6000);
  assert.equal(result.booking.stays.length, 2);
  const list = await availability(f.store, f.account.id, f.slug, {
    propertyId: f.property.id,
    from: "2027-01-05",
    to: "2027-01-10",
    showPrices: false,
  });
  assert.equal(
    list.rows.some((r) => r.date === "2027-01-05"),
    false,
  );
  assert.equal(list.rows.filter((r) => r.date === "2027-01-06").length, 4);
  assert.equal(
    list.rows.some((r) => r.date === "2027-01-09" && r.roomId === ids[1]),
    false,
  );
  assert.equal(
    list.rows.some((r) => r.date === "2027-01-09" && r.roomId === ids[0]),
    true,
  );
  assert.equal(
    list.rows.some((r) => r.date === "2027-01-09" && r.roomId === "villa"),
    false,
  );
  await booking(f, {
    checkIn: "2027-01-06",
    checkOut: "2027-01-08",
    roomIds: [ids[1]],
  });
  await assert.rejects(
    booking(f, {
      checkIn: "2027-01-08",
      checkOut: "2027-01-09",
      roomIds: [ids[1]],
    }),
    /ROOM_CONFLICT/,
  );
  await assert.rejects(
    booking(f, {
      stays: [
        { checkIn: "2027-02-01", checkOut: "2027-02-03", roomIds: [ids[0]] },
        { checkIn: "2027-02-02", checkOut: "2027-02-04", roomIds: [ids[0]] },
      ],
    }),
    /ROOM_CONFLICT/,
  );
});
test("additional properties have independent readiness and the same room names do not combine their inventory", async () => {
  const f = await fixture();
  const pending = await addProperty(
    f.store,
    f.account.id,
    f.slug,
    await f.command({
      name: "Second inn",
      kind: "rooms",
      rooms: ["101"],
      mode: "sheet",
    }),
  );
  await assert.rejects(
    availability(f.store, f.account.id, f.slug, {
      propertyId: pending.propertyId,
      from: "2027-01-01",
      to: "2027-01-03",
    }),
    /IMPORT_INCOMPLETE/,
  );
  await booking(f);
  await assert.rejects(
    addProperty(
      f.store,
      f.account.id,
      f.slug,
      await f.command({
        name: "Third inn",
        kind: "rooms",
        rooms: ["101"],
        mode: "empty",
      }),
    ),
    /INVALID_INPUT/,
  );
  const emptyInput = await f.command({
    name: "Third inn",
    kind: "rooms",
    rooms: ["101"],
    mode: "empty",
    confirmedEmpty: true,
  });
  const ready = await addProperty(f.store, f.account.id, f.slug, emptyInput);
  assert.equal(
    (await addProperty(f.store, f.account.id, f.slug, emptyInput)).propertyId,
    ready.propertyId,
  );
  const p = (await f.current()).properties.find(
    (p) => p.id === ready.propertyId,
  );
  await booking(f, { propertyId: p.id, roomIds: [p.rooms[0].id] });
  assert.equal((await f.current()).bookings.length, 2);
  assert.equal((await f.current()).properties.length, 3);
});
test("invitation accepts new and existing accounts without replacing credentials; scope, revocation and suspension are enforced on the server", async () => {
  const f = await fixture();
  const second = await addProperty(
    f.store,
    f.account.id,
    f.slug,
    await f.command({
      name: "Restricted inn",
      kind: "rooms",
      rooms: ["101"],
      mode: "empty",
      confirmedEmpty: true,
    }),
  );
  const other = await login(f.store, {
    mode: "register",
    email: "existing@example.test",
    password,
    confirmPassword: password,
  });
  const original = JSON.stringify(other.credential);
  const existing = await invite(f, other.email, { role: "housekeeper" });
  assert.equal(
    (await invitationInfo(f.store, existing.token)).existingAccount,
    true,
  );
  await assert.rejects(
    acceptInvitation(f.store, existing.token, "wrong", "wrong"),
    /UNAUTHORIZED/,
  );
  const accepted = await acceptInvitation(
    f.store,
    existing.token,
    password,
    undefined,
  );
  assert.equal(JSON.stringify(accepted.account.credential), original);
  const retry = await acceptInvitation(
    f.store,
    existing.token,
    password,
    undefined,
  );
  assert.equal(retry.account.workspaces.length, 1);
  const member = await loadWorkspace(f.store, other.id, f.slug);
  assert.deepEqual(
    view(member.workspace, member.member).properties.map((p) => p.id),
    [f.property.id],
  );
  await assert.rejects(
    availability(f.store, other.id, f.slug, {
      propertyId: second.propertyId,
      from: "2027-01-01",
      to: "2027-01-02",
    }),
    /NOT_FOUND/,
  );
  await assert.rejects(
    addProperty(
      f.store,
      other.id,
      f.slug,
      await f.command({
        name: "Forbidden",
        kind: "rooms",
        rooms: ["1"],
        mode: "empty",
        confirmedEmpty: true,
      }),
    ),
    /FORBIDDEN/,
  );
  await assert.rejects(memberSettings(f.store, other.id, f.slug), /FORBIDDEN/);
  await manageMember(
    f.store,
    f.account.id,
    f.slug,
    await f.command({
      action: "member",
      accountId: other.id,
      active: false,
      role: "housekeeper",
      allProperties: false,
      propertyIds: [f.property.id],
    }),
  );
  await assert.rejects(loadWorkspace(f.store, other.id, f.slug), /NOT_FOUND/);
  await assert.rejects(
    acceptInvitation(f.store, existing.token, password, undefined),
    /INVITATION_INVALID/,
  );
  await assert.rejects(
    manageMember(
      f.store,
      f.account.id,
      f.slug,
      await f.command({
        action: "member",
        accountId: f.account.id,
        active: false,
        role: "admin",
        allProperties: true,
        propertyIds: [],
      }),
    ),
    /FORBIDDEN/,
  );
  const fresh = await invite(f, "cleaner@example.test");
  assert.equal(
    (await invitationInfo(f.store, fresh.token)).existingAccount,
    false,
  );
  await manageMember(
    f.store,
    f.account.id,
    f.slug,
    await f.command({ action: "revoke", invitationId: fresh.invitation.id }),
  );
  await assert.rejects(
    acceptInvitation(f.store, fresh.token, password, password),
    /INVITATION_INVALID/,
  );
  assert.equal(
    (await f.store.read(accountKey("cleaner@example.test"))).value,
    null,
  );
  const newest = await invite(f, "new@example.test");
  const joined = await acceptInvitation(
    f.store,
    newest.token,
    password,
    password,
  );
  assert.equal(
    (await loadWorkspace(f.store, joined.account.id, f.slug)).member.role,
    "viewer_no_price",
  );
  assert.equal(
    JSON.stringify(
      await memberSettings(f.store, f.account.id, f.slug),
    ).includes("generation"),
    false,
  );
  const expiry = await invite(f, "expiry@example.test");
  const snap = await f.store.read(`workspace:${f.workspace.id}`);
  snap.value.invitations.find((i) => i.id === expiry.invitation.id).expiresAt =
    Date.now() - 1;
  await f.store.commit([
    { key: `workspace:${f.workspace.id}`, before: snap.raw, after: snap.value },
  ]);
  await assert.rejects(
    invitationInfo(f.store, expiry.token),
    /INVITATION_INVALID/,
  );
  await assert.rejects(
    invitationInfo(f.store, `${newest.token.slice(0, -1)}!`),
    /INVITATION_INVALID/,
  );
});
test("prices are off until configured; dated prices and zero prices work; no-price roles receive no rate or financial values", async () => {
  const f = await fixture(),
    roomId = f.property.rooms[0].id;
  await assert.rejects(
    saveAvailabilityList(
      f.store,
      f.account.id,
      f.slug,
      await f.command({
        title: "Future vacancies",
        propertyId: f.property.id,
        from: "2027-02-01",
        to: "2027-02-03",
        showPrices: true,
      }),
    ),
    /PRICING_NOT_ENABLED/,
  );
  const pricing = {
    currency: "TWD",
    enabled: true,
    base: { [roomId]: 54321.67, villa: 98765.43 },
    overrides: [{ roomId, from: "2027-02-02", to: "2027-02-02", amount: 0 }],
  };
  await setPricing(
    f.store,
    f.account.id,
    f.slug,
    await f.command({ propertyId: f.property.id, pricing }),
  );
  const list = await saveAvailabilityList(
    f.store,
    f.account.id,
    f.slug,
    await f.command({
      title: "Future vacancies",
      propertyId: f.property.id,
      from: "2027-02-01",
      to: "2027-02-03",
      showPrices: true,
    }),
  );
  const priced = await availability(f.store, f.account.id, f.slug, {
    listId: list.listId,
  });
  assert.equal(
    priced.rows.find((r) => r.date === "2027-02-02" && r.roomId === roomId)
      .amount,
    0,
  );
  assert.equal(
    priced.rows.find((r) => r.date === "2027-02-01" && r.roomId === roomId)
      .amount,
    54321.67,
  );
  await assert.rejects(
    setPricing(
      f.store,
      f.account.id,
      f.slug,
      await f.command({
        propertyId: f.property.id,
        pricing: {
          ...pricing,
          overrides: [
            ...pricing.overrides,
            { roomId, from: "2027-02-01", to: "2027-02-03", amount: 1 },
          ],
        },
      }),
    ),
    /RATE_CONFLICT/,
  );
  await booking(f, {
    total: 54321.67,
    expectedDeposit: 54321.67,
    notes: "price 54321.67",
  });
  const invited = await invite(f, "noprice@example.test"),
    joined = await acceptInvitation(f.store, invited.token, password, password);
  const restricted = await loadWorkspace(f.store, joined.account.id, f.slug);
  const output = JSON.stringify(view(restricted.workspace, restricted.member));
  assert.equal(output.includes("54321.67"), false);
  assert.equal(output.includes("98765.43"), false);
  assert.equal(output.includes('"pricing"'), false);
  const unpriced = await availability(f.store, joined.account.id, f.slug, {
    listId: list.listId,
    showPrices: true,
  });
  assert.equal(unpriced.showPrices, false);
  assert.equal(JSON.stringify(unpriced).includes('"amount"'), false);
  await assert.rejects(
    bookingOperation(
      f.store,
      joined.account.id,
      f.slug,
      await f.command({
        action: "terms",
        bookingId: (await f.current()).bookings[0].id,
        total: 10,
      }),
    ),
    /FORBIDDEN/,
  );
});
test("payments are order-level immutable receipts with explicit overpayment, refunds, concurrency and retry recovery", async () => {
  const f = await fixture(),
    created = await booking(f, { total: 1000.25, expectedDeposit: 300 });
  const id = created.booking.id;
  const pay = await f.command({
    action: "payment",
    bookingId: id,
    bookingVersion: 1,
    amount: 300.1,
    kind: "deposit",
    receivedAt,
    method: "transfer",
  });
  const first = await bookingOperation(f.store, f.account.id, f.slug, pay);
  assert.equal(first.summary.received, 300.1);
  assert.equal(first.summary.remaining, 700.15);
  assert.equal(
    (await bookingOperation(f.store, f.account.id, f.slug, pay)).workspace
      .bookings[0].payments.length,
    1,
  );
  await assert.rejects(
    bookingOperation(f.store, f.account.id, f.slug, { ...pay, amount: 300.2 }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const v2 = (await f.current()).bookings[0];
  const stale = await f.command({
    action: "payment",
    bookingId: id,
    bookingVersion: 1,
    amount: 10,
    kind: "other",
    receivedAt,
  });
  await assert.rejects(
    bookingOperation(f.store, f.account.id, f.slug, stale),
    /VERSION_CONFLICT/,
  );
  const oversized = await f.command({
    action: "payment",
    bookingId: id,
    bookingVersion: v2.version,
    amount: 800,
    kind: "balance",
    receivedAt,
  });
  await assert.rejects(
    bookingOperation(f.store, f.account.id, f.slug, oversized),
    /OVERPAYMENT_CONFIRMATION_REQUIRED/,
  );
  const overpaid = await bookingOperation(f.store, f.account.id, f.slug, {
    ...oversized,
    allowOverpayment: true,
  });
  assert.equal(overpaid.summary.credit, 99.85);
  const refund = await f.command({
    action: "payment",
    bookingId: id,
    bookingVersion: 3,
    amount: 99.85,
    kind: "refund",
    receivedAt,
  });
  const refunded = await bookingOperation(
    f.store,
    f.account.id,
    f.slug,
    refund,
  );
  assert.equal(refunded.summary.received, 1000.25);
  assert.equal(refunded.summary.status, "paid");
  assert.equal(refunded.workspace.bookings[0].payments.length, 3);
  await assert.rejects(
    bookingOperation(
      f.store,
      f.account.id,
      f.slug,
      await f.command({
        ...refund,
        requestKey: "refund-too-big-0000",
        version: (await f.current()).version,
        bookingVersion: 4,
        amount: 1001,
      }),
    ),
    /REFUND_TOO_LARGE/,
  );
  await assert.rejects(
    bookingOperation(
      f.store,
      f.account.id,
      f.slug,
      await f.command({ action: "cancel", bookingId: id, bookingVersion: 4 }),
    ),
    /CANCELLATION_REQUIRES_SETTLEMENT/,
  );
  const commit = f.store.commit;
  let fail = true;
  f.store.commit = async (changes) => {
    await commit(changes);
    if (fail) {
      fail = false;
      throw new Error("STORE_UNAVAILABLE");
    }
  };
  const finalRefund = await f.command({
    action: "payment",
    bookingId: id,
    bookingVersion: 4,
    amount: 1000.25,
    kind: "refund",
    receivedAt,
  });
  await assert.rejects(
    bookingOperation(f.store, f.account.id, f.slug, finalRefund),
    /STORE_UNAVAILABLE/,
  );
  const retry = await bookingOperation(
    f.store,
    f.account.id,
    f.slug,
    finalRefund,
  );
  assert.equal(retry.summary.received, 0);
  assert.equal(retry.workspace.bookings[0].payments.length, 4);
  await bookingOperation(
    f.store,
    f.account.id,
    f.slug,
    await f.command({ action: "cancel", bookingId: id, bookingVersion: 5 }),
  );
  assert.equal((await f.current()).bookings[0].status, "cancelled");
});
test("concurrent receipt writes have one winner and housekeepers cannot refund or alter price terms", async () => {
  const f = await fixture(),
    created = await booking(f);
  const input = await f.command({
    action: "payment",
    bookingId: created.booking.id,
    bookingVersion: 1,
    amount: 100,
    kind: "deposit",
    receivedAt,
  });
  const results = await Promise.allSettled([
    bookingOperation(f.store, f.account.id, f.slug, input),
    bookingOperation(f.store, f.account.id, f.slug, {
      ...input,
      requestKey: "competing-receipt-0001",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await f.current()).bookings[0].payments.length, 1);
  const invited = await invite(f, "keeper@example.test", {
      role: "housekeeper",
    }),
    joined = await acceptInvitation(f.store, invited.token, password, password);
  const common = { bookingId: created.booking.id, bookingVersion: 2 };
  await assert.rejects(
    bookingOperation(
      f.store,
      joined.account.id,
      f.slug,
      await f.command({
        ...common,
        action: "payment",
        amount: 1,
        kind: "refund",
        receivedAt,
      }),
    ),
    /FORBIDDEN/,
  );
  await assert.rejects(
    bookingOperation(
      f.store,
      joined.account.id,
      f.slug,
      await f.command({ ...common, action: "terms", total: 1 }),
    ),
    /FORBIDDEN/,
  );
  await assert.rejects(
    bookingOperation(
      f.store,
      joined.account.id,
      f.slug,
      await f.command({
        ...common,
        action: "payment",
        amount: 1,
        kind: "deposit",
        receivedAt: "2099-01-01T10:00:00+08:00",
      }),
    ),
    /FUTURE_RECEIPT/,
  );
  await assert.rejects(
    bookingOperation(
      f.store,
      joined.account.id,
      f.slug,
      await f.command({
        ...common,
        action: "payment",
        amount: 0.001,
        kind: "deposit",
        receivedAt,
      }),
    ),
    /INVALID_INPUT/,
  );
  await bookingOperation(
    f.store,
    joined.account.id,
    f.slug,
    await f.command({
      ...common,
      action: "payment",
      amount: 50,
      kind: "other",
      receivedAt,
    }),
  );
  assert.equal(financeSummary((await f.current()).bookings[0]).received, 150);
});
test("Sheet paid-to-platform totals remain unknown cash until opening receipts are confirmed; edited imports cannot be undone", async () => {
  const f = await fixture();
  const source = {
    spreadsheetId: "synthetic-source-id-1234",
    sheetId: 0,
    title: "Synthetic",
    rows: [
      ["入住", "退房", "房間", "房費", "已付"],
      ["2027-03-01", "2027-03-03", "101", "5000", "2000"],
    ],
  };
  const mapping = {
    headerRow: 1,
    columns: {
      checkIn: 0,
      checkOut: 1,
      rooms: 2,
      total: 3,
      received: 4,
      guestName: -1,
      externalId: -1,
    },
    roomMap: { 101: [f.property.rooms[0].id] },
    granularity: "order",
    amountBasis: "order",
    receivedMeaning: "guest",
    currency: "TWD",
    from: "2027-01-01",
  };
  const preview = await previewImport(
    f.store,
    f.account.id,
    f.slug,
    f.property.id,
    source,
    mapping,
  );
  const batch = await commitImport(
    f.store,
    f.account.id,
    f.slug,
    f.property.id,
    preview.id,
    [2],
  );
  const b = (await f.current()).bookings[0];
  assert.equal(financeSummary(b).received, null);
  assert.equal(financeSummary(b).remaining, null);
  await bookingOperation(
    f.store,
    f.account.id,
    f.slug,
    await f.command({
      action: "payment",
      bookingId: b.id,
      bookingVersion: 1,
      amount: 1000,
      kind: "balance",
      receivedAt,
    }),
  );
  assert.equal(financeSummary((await f.current()).bookings[0]).received, null);
  const opening = await bookingOperation(
    f.store,
    f.account.id,
    f.slug,
    await f.command({
      action: "opening",
      bookingId: b.id,
      bookingVersion: 2,
      amount: 0,
      asOf: "2026-01-01",
      note: "No direct receipts before import",
    }),
  );
  assert.equal(opening.summary.received, 1000);
  assert.equal(opening.summary.remaining, 4000);
  assert.equal(opening.workspace.bookings[0].payments.length, 1);
  const undone = await undoImport(
    f.store,
    f.account.id,
    f.slug,
    f.property.id,
    batch.id,
    (await f.current()).version,
  );
  assert.deepEqual(undone.cancelled, []);
  assert.deepEqual(undone.skipped, [b.id]);
});
test("format suggestions require semantic confirmation and send unsupported nightly/grid structures for assistance", async () => {
  const f = await fixture();
  const simple = suggestFormat(
    [
      ["資料說明"],
      ["入住日期", "退房日期", "房號", "訂單總額", "已付"],
      ["2027-01-01", "2027-01-02", "101", "3000", "1000"],
    ],
    f.property,
  );
  assert.equal(simple.headerRow, 2);
  assert.equal(simple.layout, "orders");
  assert.equal(simple.columns.total, 3);
  assert.deepEqual(simple.roomMap["101"], [f.property.rooms[0].id]);
  assert.equal(simple.questions.length, 3);
  assert.equal("amountBasis" in simple, false);
  assert.equal("receivedMeaning" in simple, false);
  assert.equal(
    suggestFormat(
      [
        ["房號", "2027/1/1", "2027/1/2", "2027/1/3"],
        ["101", "Guest", "Guest", ""],
      ],
      f.property,
    ).layout,
    "grid",
  );
  assert.equal(
    suggestFormat([["訂单編號", "住宿日期", "房號", "房費"]], f.property)
      .layout,
    "nightly",
  );
  const ambiguous = suggestFormat(
    [["入住日期", "退房日期", "房號", "房費", "總額"]],
    f.property,
  );
  assert.equal(ambiguous.columns.total, -1);
  assert.ok(ambiguous.messages.length > 1);
});
test("an empty verified source requires explicit confirmation and never declares dates before the coverage start available", async () => {
  const f = await fixture();
  const source = {
    spreadsheetId: "synthetic-empty-source-123",
    sheetId: 0,
    title: "Empty future orders",
    rows: [["入住", "退房", "房間"]],
  };
  const mapping = {
    headerRow: 1,
    columns: {
      checkIn: 0,
      checkOut: 1,
      rooms: 2,
      total: -1,
      received: -1,
      guestName: -1,
      externalId: -1,
    },
    roomMap: {},
    granularity: "order",
    amountBasis: "none",
    receivedMeaning: "none",
    currency: "TWD",
    from: "2027-05-01",
  };
  const preview = await previewImport(
    f.store,
    f.account.id,
    f.slug,
    f.property.id,
    source,
    mapping,
  );
  await assert.rejects(
    commitImport(f.store, f.account.id, f.slug, f.property.id, preview.id, []),
    /FORMAT_CONFIRMATION_REQUIRED/,
  );
  const batch = await commitImport(
    f.store,
    f.account.id,
    f.slug,
    f.property.id,
    preview.id,
    [],
    true,
  );
  assert.deepEqual(batch.bookingIds, []);
  await assert.rejects(
    availability(f.store, f.account.id, f.slug, {
      propertyId: f.property.id,
      from: "2027-04-30",
      to: "2027-05-01",
    }),
    /SOURCE_COVERAGE/,
  );
  await assert.rejects(
    booking(f, { checkIn: "2027-04-30", checkOut: "2027-05-01" }),
    /SOURCE_COVERAGE/,
  );
  assert.equal(
    (
      await availability(f.store, f.account.id, f.slug, {
        propertyId: f.property.id,
        from: "2027-05-01",
        to: "2027-05-01",
      })
    ).rows.length,
    4,
  );
});
