import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  uploadCalendar,
  stageCalendar,
  calendarSnapshotFor,
  previewCalendar,
  commitCalendar,
  undoCalendar,
} from "../src/lib/customer-workspaces/calendar-import.ts";
import {
  propertyReadiness,
  financeSummary,
} from "../src/lib/customer-workspaces/domain.ts";
import { createBooking, view } from "../src/lib/customer-workspaces/service.ts";
import {
  availability,
  bookingOperation,
} from "../src/lib/customer-workspaces/operations.ts";
import { calendarKey } from "../src/lib/customer-workspaces/calendar-source.ts";
import { buildStandardWorkbook } from "../src/lib/customer-workspaces/standard-sheet.ts";
import {
  fixture,
  ics,
  event,
  mapping,
  range,
} from "./helpers/calendar-fixture.mjs";
async function upload(f, text, kind = "google_calendar") {
  return uploadCalendar(...f.args, Buffer.from(text), "synthetic.ics", {
    ...range,
    kind,
  });
}
const command = (p, extra = {}) => ({
  previewId: p.id,
  confirmed: true,
  confirmedCoverage: true,
  selected: p.rows
    .filter((r) => r.disposition === "ready" && !r.issues.length)
    .map((r) => r.id),
  mode: "migration",
  ...extra,
});
async function imported(
  f,
  text = ics([
    event({ uid: "booking", title: "客人：測試 總額：6000 訂金：2000" }),
  ]),
) {
  const source = await upload(f, text),
    p = await previewCalendar(...f.args, source.id, mapping());
  const batch = await commitCalendar(...f.args, command(p));
  return { source, p, batch };
}
const bookingRequest = (
  w,
  from = "2026-10-10",
  to = "2026-10-11",
  room = "101",
) => ({
  propertyId: "property",
  version: w.version,
  requestKey: randomUUID(),
  checkIn: from,
  checkOut: to,
  roomIds: [room],
  guestName: "Synthetic",
});
test("all three calendar entry kinds persist real orders, retain unknown receipts and retry idempotently", async () => {
  for (const kind of ["google_calendar", "ios_calendar", "android_calendar"]) {
    const f = fixture(),
      s = await upload(
        f,
        ics([
          event({ uid: "same", title: "客人：測試 總額：6000 訂金：2000" }),
        ]),
        kind,
      ),
      p = await previewCalendar(...f.args, s.id, mapping());
    const input = command(p),
      batch = await commitCalendar(...f.args, input);
    assert.deepEqual(await commitCalendar(...f.args, input), batch);
    const w = await f.current();
    assert.equal(w.bookings.length, 1);
    assert.equal(w.bookings[0].entry, "calendar");
    assert.equal(w.bookings[0].total, 6000);
    assert.equal(w.bookings[0].importedFinance.sourcePaid, 2000);
    assert.equal(financeSummary(w.bookings[0]).received, null);
    assert.equal(w.properties[0].setup.calendarKind, kind);
    assert.equal(propertyReadiness(w, w.properties[0]).complete, true);
    await assert.rejects(
      commitCalendar(...f.args, { ...input, confirmedCoverage: false }),
      /IDEMPOTENCY_CONFLICT/,
    );
    const p2 = await previewCalendar(
      ...f.args,
      s.id,
      mapping(),
      batch.bindingId,
    );
    assert.equal(p2.rows[0].disposition, "existing");
    await commitCalendar(...f.args, command(p2));
    assert.equal((await f.current()).bookings.length, 1);
  }
});
test("unknown rooms and unconfirmed coverage cannot publish available inventory; blocks exclude all overlapping entry points", async () => {
  const f = fixture(),
    s = await upload(f, ics([event({ uid: "block", title: "維修" })])),
    p = await previewCalendar(...f.args, s.id, mapping());
  await commitCalendar(...f.args, command(p, { confirmedCoverage: false }));
  let w = await f.current();
  assert.equal(w.bookings.length, 0);
  assert.equal(w.blocks.length, 1);
  assert.equal(propertyReadiness(w, w.properties[0]).complete, false);
  await assert.rejects(
    availability(...f.args.slice(0, 3), {
      propertyId: "property",
      from: "2026-10-10",
      to: "2026-10-12",
    }),
    /IMPORT_INCOMPLETE/,
  );
  const p2 = await previewCalendar(
    ...f.args,
    s.id,
    mapping(),
    w.calendarSources[0].id,
  );
  await commitCalendar(...f.args, command(p2));
  w = await f.current();
  await assert.rejects(
    createBooking(...f.args.slice(0, 3), bookingRequest(w)),
    /ROOM_CONFLICT/,
  );
  const result = await availability(...f.args.slice(0, 3), {
    propertyId: "property",
    from: "2026-10-10",
    to: "2026-10-12",
  });
  assert.equal(
    result.rows.some((r) => r.roomId === "101" && r.date === "2026-10-10"),
    false,
  );
  assert.equal(
    result.rows.some((r) => r.roomId === "101" && r.date === "2026-10-12"),
    true,
  );
  await assert.rejects(
    createBooking(
      ...f.args.slice(0, 3),
      bookingRequest(w, "2027-09-30", "2027-10-02", "102"),
    ),
    /SOURCE_COVERAGE/,
  );
  await assert.rejects(
    availability(...f.args.slice(0, 3), {
      propertyId: "property",
      from: "2027-09-30",
      to: "2027-10-01",
    }),
    /SOURCE_COVERAGE/,
  );
  const book = buildStandardWorkbook(w);
  assert.equal(book.tables.orders.length, 1);
  assert.equal(book.tables.blocks.length, 3);
  assert.equal(book.tables.calendarSources.length, 2);
  assert.equal(book.tables.sources.length, 1);
});
test("calendar snapshot, preview, room mapping and commit enforce actor/property isolation, expiry and CAS", async () => {
  const f = fixture(),
    s = await upload(f, ics([event({ uid: "a" })]));
  let w = await f.current();
  w.members.push(
    {
      accountId: "admin",
      role: "admin",
      active: true,
      allProperties: true,
      propertyIds: [],
    },
    {
      accountId: "scoped",
      role: "admin",
      active: true,
      allProperties: false,
      propertyIds: [],
    },
  );
  await f.put(w);
  await assert.rejects(
    calendarSnapshotFor(f.store, "admin", w.slug, "property", s.id),
    /NOT_FOUND/,
  );
  await assert.rejects(
    calendarSnapshotFor(f.store, "scoped", w.slug, "property", s.id),
    /NOT_FOUND/,
  );
  await assert.rejects(
    previewCalendar(...f.args, s.id, {
      ...mapping(),
      rooms: { "room-cal": ["foreign-room"] },
    }),
    /INVALID_INPUT/,
  );
  const p = await previewCalendar(...f.args, s.id, mapping());
  w.version++;
  await f.put(w);
  await assert.rejects(
    commitCalendar(...f.args, command(p)),
    /VERSION_CONFLICT/,
  );
  assert.equal((await f.current()).bookings.length, 0);
  const snapshot = await f.store.read(`calendar-snapshot:${s.id}`);
  f.store.data.set(
    `calendar-snapshot:${s.id}`,
    JSON.stringify({ ...snapshot.value, expiresAt: 1 }),
  );
  await assert.rejects(
    calendarSnapshotFor(...f.args, s.id),
    /CALENDAR_EXPIRED/,
  );
});
test("updated occupancy preserves accepted terms/payments, cancellation requires zero settled balance, undo skips edited orders", async () => {
  const f = fixture(),
    { batch } = await imported(f);
  let w = await f.current(),
    b = w.bookings[0];
  b.openingReceived = { amount: 2000, asOf: "2026-10-01", note: null };
  b.payments = [
    {
      id: "receipt",
      amount: 1000,
      kind: "balance",
      receivedAt: "2026-10-01T00:00:00Z",
      method: null,
      actor: "calendar-owner",
    },
  ];
  b.total = 9000;
  b.notes = "Keep accepted notes";
  b.platform = "LINE";
  b.bookedAt = "2026-09-25";
  b.tagIds = ["pet"];
  b.version++;
  w.version++;
  await f.put(w);
  const s2 = await upload(
      f,
      ics([
        event({
          uid: "booking",
          start: "20261013",
          end: "20261015",
          title: "客人：測試 總額：7000 訂金：2500",
        }),
      ]),
    ),
    p2 = await previewCalendar(...f.args, s2.id, mapping(), batch.bindingId);
  assert.equal(p2.rows[0].disposition, "changed");
  await assert.rejects(
    commitCalendar(...f.args, command(p2, { selected: [p2.rows[0].id] })),
    /CALENDAR_CHANGES_CONFIRM/,
  );
  await commitCalendar(
    ...f.args,
    command(p2, { selected: [p2.rows[0].id], acceptChanges: true }),
  );
  w = await f.current();
  b = w.bookings[0];
  assert.equal(b.checkIn, "2026-10-13");
  assert.equal(b.total, 9000);
  assert.equal(b.notes, "Keep accepted notes");
  assert.equal(b.platform, "LINE");
  assert.equal(b.bookedAt, "2026-09-25");
  assert.deepEqual(b.tagIds, ["pet"]);
  assert.equal(financeSummary(b).received, 3000);
  const empty = await upload(f, ics([])),
    cancel = await previewCalendar(
      ...f.args,
      empty.id,
      mapping(),
      batch.bindingId,
    );
  assert.equal(cancel.rows[0].disposition, "cancelled");
  await assert.rejects(
    commitCalendar(
      ...f.args,
      command(cancel, { selected: [cancel.rows[0].id], acceptChanges: true }),
    ),
    /CANCELLATION_REQUIRES_SETTLEMENT/,
  );
  const undone = await undoCalendar(...f.args, {
    batchId: batch.id,
    version: w.version,
  });
  assert.equal(undone.removed.length, 0);
  assert.equal(undone.skipped.length, 1);
  assert.equal((await f.current()).bookings[0].status, "confirmed");
});
test("unmodified batch undo is idempotent, preserves audit and prevents source resurrection", async () => {
  const f = fixture(),
    { batch, source } = await imported(f);
  const input = { batchId: batch.id, version: (await f.current()).version };
  const result = await undoCalendar(...f.args, input);
  assert.equal(result.removed.length, 1);
  assert.deepEqual(await undoCalendar(...f.args, input), result);
  const w = await f.current();
  assert.equal(w.bookings[0].status, "cancelled");
  assert.equal(propertyReadiness(w, w.properties[0]).complete, false);
  assert.equal(w.audit.at(-1).action, "calendar.import-undone");
  const p = await previewCalendar(
    ...f.args,
    source.id,
    mapping(),
    batch.bindingId,
  );
  assert.match(p.rows[0].issues.join(), /不能自動重新建立/);
});
test("file-to-Google migration reconciles UID then persists new references; a new source cannot bypass duplicates", async () => {
  const f = fixture(),
    { source, batch } = await imported(f);
  const events = source.events.map((e) => ({
    ...e,
    calendarId: "google-id",
    eventId: "google-event",
    key: calendarKey("google-id", e.uid, e.recurrenceId),
  }));
  const api = await stageCalendar(...f.args, {
    ...range,
    kind: "google_calendar",
    transport: "google",
    connectionId: "synthetic",
    calendars: [{ id: "google-id", name: "Google room", count: 1 }],
    events,
  });
  const rules = {
    ...mapping(),
    calendarIds: ["google-id"],
    rooms: { "google-id": ["101"] },
  };
  const dupe = await previewCalendar(...f.args, api.id, rules);
  assert.match(dupe.rows[0].issues.join(), /另一個日曆來源/);
  const p = await previewCalendar(...f.args, api.id, rules, batch.bindingId);
  assert.equal(p.rows[0].disposition, "existing");
  await commitCalendar(...f.args, command(p));
  const p2 = await previewCalendar(...f.args, api.id, rules, batch.bindingId);
  assert.equal(p2.rows[0].disposition, "existing");
  assert.equal(
    (await f.current()).bookings[0].calendar.references[0].calendarId,
    "google-id",
  );
});
test("financial metadata never leaks to no-price viewers; imported unknown opening can be explicitly confirmed", async () => {
  const f = fixture();
  await imported(f);
  let w = await f.current();
  const hidden = view(w, {
    role: "viewer_no_price",
    allProperties: true,
    propertyIds: [],
  });
  assert.equal(hidden.bookings[0].calendar, undefined);
  assert.equal(hidden.bookings[0].importedFinance, undefined);
  assert.equal(hidden.bookings[0].total, null);
  const booking = w.bookings[0];
  const result = await bookingOperation(...f.args.slice(0, 3), {
    action: "opening",
    requestKey: randomUUID(),
    version: w.version,
    bookingVersion: booking.version,
    bookingId: booking.id,
    amount: 0,
    asOf: "2026-10-01",
  });
  assert.equal(result.summary.received, 0);
});
test("stale or failing connected bindings fail closed and prohibit local occupancy creation", async () => {
  const f = fixture();
  await imported(f);
  let w = await f.current();
  w.calendarSources[0].mode = "connected";
  w.calendarSources[0].lastSuccessfulAt = new Date().toISOString();
  await f.put(w);
  await assert.rejects(
    createBooking(
      ...f.args.slice(0, 3),
      bookingRequest(w, "2026-10-15", "2026-10-16"),
    ),
    /CALENDAR_SOURCE_OWNS_OCCUPANCY/,
  );
  w.calendarSources[0].lastSuccessfulAt = new Date(
    Date.now() - 11 * 60000,
  ).toISOString();
  assert.equal(propertyReadiness(w, w.properties[0]).complete, false);
  w.calendarSources[0].lastSuccessfulAt = new Date().toISOString();
  w.calendarSources[0].error = "CALENDAR_CONNECT_REQUIRED";
  assert.equal(propertyReadiness(w, w.properties[0]).complete, false);
});

test("calendar descriptions survive import and source updates without overwriting owner notes", async () => {
  const f = fixture();
  const first = await imported(f, ics([event({uid: "notes", description: "需要嬰兒床"})]));
  assert.equal((await f.current()).bookings[0].notes, "需要嬰兒床");
  async function update(description) {
    const source = await upload(f, ics([event({uid: "notes", description})]));
    const preview = await previewCalendar(...f.args, source.id, mapping(), first.batch.bindingId);
    assert.equal(preview.rows[0].disposition, "changed");
    await commitCalendar(...f.args, command(preview, {selected: [preview.rows[0].id], acceptChanges: true}));
  }
  await update("需要嬰兒床，晚上九點抵達");
  assert.equal((await f.current()).bookings[0].notes, "需要嬰兒床，晚上九點抵達");
  const w = await f.current(); w.bookings[0].notes = "已與旅客確認晚到"; await f.put(w);
  await update("來源新增需求");
  assert.equal((await f.current()).bookings[0].notes, "已與旅客確認晚到");
  assert.equal((await f.current()).bookings[0].calendar.sourceNotes, "來源新增需求");
});
