import test from "node:test";
import assert from "node:assert/strict";
import { orderMutation } from "../src/lib/customer-workspaces/order-mutations.ts";
import {
  queryOrders,
  stayCounts,
  tagsFor,
} from "../src/lib/customer-workspaces/order-query.ts";
import { financeSummary } from "../src/lib/customer-workspaces/domain.ts";
import { view } from "../src/lib/customer-workspaces/service.ts";
import { buildStandardWorkbook } from "../src/lib/customer-workspaces/standard-sheet.ts";
import { fixture, booking } from "./helpers/order-fixture.mjs";

test("cross-month multi-room queries use source booking date, notes, normalized names and exclusive checkout; paginate orders once", async () => {
  const f = fixture(),
    w = await f.current(),
    data = view(w, w.members[0]);
  assert.deepEqual(stayCounts(data.bookings[0]), { nights: 2, roomNights: 4 });
  assert.equal(
    queryOrders(data, {
      q: "  TEST guest  ",
      platform: "booking",
      dateKind: "bookedAt",
      from: "2026-09-30",
      to: "2026-09-30",
    }).total,
    1,
  );
  assert.equal(
    queryOrders(data, {
      q: "test-123",
      dateKind: "stay",
      from: "2027-02-01",
      to: "2027-02-01",
      room: "102",
    }).total,
    1,
  );
  assert.equal(
    queryOrders(data, { from: "2027-02-02", to: "2027-02-02" }).total,
    0,
  );
  assert.equal(
    queryOrders(data, {
      dateKind: "checkOut",
      from: "2027-02-02",
      to: "2027-02-02",
    }).total,
    1,
  );
  assert.equal(
    queryOrders(data, {
      dateKind: "bookedAt",
      from: "2026-10-01",
      to: "2026-10-01",
    }).total,
    0,
  );
  delete data.bookings[0].bookedAt;
  assert.equal(queryOrders(data, { missingDate: "true" }).total, 1);
  assert.equal(queryOrders(data, { q: "收據" }).total, 1);
  assert.throws(
    () => queryOrders(data, { from: "2027-02-30" }),
    /INVALID_INPUT/,
  );
  data.bookings = Array.from({ length: 65 }, (_, i) => ({
    ...booking,
    id: `order-${i}`,
  }));
  const page = queryOrders(data, { page: "2" });
  assert.equal(page.bookings.length, 30);
  assert.equal(page.pages, 3);
  assert.equal(page.total, 65);
});
test("room date filters match the same stay, and pending source records remain separate from confirmed totals", async () => {
  const f = fixture(),
    w = await f.current();
  w.bookings[0].stays = [
    { checkIn: "2027-01-31", checkOut: "2027-02-01", roomIds: ["101"] },
    { checkIn: "2027-02-04", checkOut: "2027-02-05", roomIds: ["102"] },
  ];
  w.reviewRecords = [
    {
      id: "review-1",
      propertyId: "p1",
      label: "Synthetic unresolved source",
      sourceId: "s1",
      source: "sheet",
      guestName: null,
      checkIn: null,
      checkOut: null,
      roomIds: [],
      issues: ["分組待確認"],
    },
  ];
  const data = view(w, w.members[0]);
  assert.equal(
    queryOrders(data, { room: "102", from: "2027-01-31", to: "2027-01-31" })
      .total,
    0,
  );
  assert.equal(queryOrders(data, {}).reviewCount, 1);
  assert.deepEqual(stayCounts(data.bookings[0]), { nights: 2, roomNights: 2 });
  const limited = view(w, w.members[1]);
  assert.equal(queryOrders(limited, {}).reviewCount, 0);
  assert.throws(() => queryOrders(limited, { property: "p1" }), /NOT_FOUND/);
});
test("notes and shared tag edits are persisted, audited, scope checked, versioned and retry-safe", async () => {
  const f = fixture();
  const input = await f.input({
    action: "order-details",
    notes: "人工需求",
    platform: "LINE",
    bookedAt: null,
  });
  await orderMutation(f.store, "owner", "test-orders", input);
  await orderMutation(f.store, "owner", "test-orders", input);
  assert.equal((await f.current()).version, 2);
  assert.equal((await f.current()).audit.length, 1);
  await assert.rejects(
    orderMutation(f.store, "owner", "test-orders", {
      ...input,
      notes: "不同内容",
    }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    orderMutation(f.store, "owner", "test-orders", {
      ...input,
      requestKey: "stale-version-request",
    }),
    /VERSION_CONFLICT/,
  );
  await assert.rejects(
    f.mutate({ action: "order-details", notes: "unauthorized" }, "limited"),
    /NOT_FOUND/,
  );
  await assert.rejects(
    f.mutate({ action: "order-details", notes: "unauthorized" }, "hidden"),
    /FORBIDDEN/,
  );
  await f.mutate({ action: "order-tags", tagIds: ["receipt"] });
  await f.mutate({
    action: "tag",
    tagId: "receipt",
    name: "發票收據",
    short: "票",
    color: "rose",
  });
  const w = await f.current();
  assert.equal(w.bookings[0].tagIds[0], "receipt");
  assert.equal(
    tagsFor(w.properties[0]).find((t) => t.id === "receipt").short,
    "票",
  );
  await assert.rejects(
    f.mutate({ action: "tag", name: "Duplicate", short: "票", color: "blue" }),
    /TAG_EXISTS/,
  );
  await assert.rejects(
    f.mutate({ action: "order-tags", tagIds: ["not-in-this-property"] }),
    /INVALID_INPUT/,
  );
  await f.mutate({ action: "order-tags", tagIds: [] });
  assert.deepEqual((await f.current()).bookings[0].tagIds, []);
});
test("receipts share one ledger, extra fees do not settle room charges, accounts stay in property scope and unknown openings stay unknown", async () => {
  const f = fixture();
  const account = await f.mutate({
    action: "receipt-account",
    name: "Synthetic account",
    last4: "1234",
  });
  await f.pay({
    kind: "deposit",
    amount: 3000,
    receiptAccountId: account.targetId,
    method: "匯款",
    note: "payment note",
  });
  await f.pay({ kind: "other", amount: 500, method: "現金" });
  let w = await f.current(),
    b = w.bookings[0],
    s = financeSummary(b);
  assert.equal(s.received, 3000);
  assert.equal(s.extraReceived, 500);
  assert.equal(s.remaining, 6000);
  assert.equal(b.notes, "需要收據");
  await assert.rejects(
    f.pay({ kind: "balance", amount: 1, receiptAccountId: "foreign-account" }),
    /NOT_FOUND/,
  );
  await f.pay({ kind: "refund", allocation: "extra", amount: 200 });
  await assert.rejects(
    f.pay({ kind: "refund", allocation: "extra", amount: 301 }),
    /REFUND_TOO_LARGE/,
  );
  w = await f.current();
  const hidden = view(w, w.members[2]);
  assert.equal(hidden.properties[0].receiptAccounts, undefined);
  assert.deepEqual(hidden.bookings[0].payments, []);
  assert.equal(hidden.bookings[0].notes, null);
  assert.equal(hidden.bookings[0].total, null);
  const workbook = buildStandardWorkbook(w);
  assert.equal(workbook.tables.orders[1][22], 300);
  assert.ok(
    workbook.tables.payments.some((r) => r[10] === "其他費用（不抵房費）"),
  );
  assert.ok(
    workbook.tables.payments.some(
      (r) => r[11] === "Synthetic account" && r[12] === "1234",
    ),
  );
  const unknown = {
    ...w.bookings[0],
    entry: "calendar",
    importedFinance: { propertyReceived: null },
  };
  assert.equal(financeSummary(unknown).received, null);
  assert.equal(financeSummary(unknown).remaining, null);
  assert.equal(financeSummary(unknown).extraReceived, 300);
  const legacy = { ...booking, payments: [{ kind: "other", amount: 100 }] };
  assert.equal(
    financeSummary(legacy).received,
    100,
    "legacy receipts retain their recorded room-fee semantics",
  );
});

test("a receipt alone cannot confirm a mismatched saved note, including an identical retry", async () => {
  const f = fixture(),
    commit = f.store.commit;
  f.store.commit = async (changes) =>
    commit(
      changes.map((change) =>
        change.key === "workspace:ws"
          ? {
              ...change,
              after: {
                ...change.after,
                bookings: change.after.bookings.map((b) => ({
                  ...b,
                  notes: "Synthetic corrupted write",
                })),
              },
            }
          : change,
      ),
    );
  const input = await f.input({
    action: "order-details",
    notes: "Expected saved note",
  });
  await assert.rejects(
    orderMutation(f.store, "owner", "test-orders", input),
    /WRITE_UNCONFIRMED/,
  );
  await assert.rejects(
    orderMutation(f.store, "owner", "test-orders", input),
    /WRITE_UNCONFIRMED/,
  );
});
