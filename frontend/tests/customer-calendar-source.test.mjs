import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  parseCalendarFiles,
  calendarFiles,
  calendarDate,
  calendarRange,
} from "../src/lib/customer-workspaces/calendar-source.ts";
import { normalizeCalendar } from "../src/lib/customer-workspaces/calendar-normalizer.ts";
import {
  fixture,
  range,
  ics,
  event,
  mapping,
} from "./helpers/calendar-fixture.mjs";
const parse = (text, selectedRange = range) =>
  parseCalendarFiles([{ name: "Synthetic.ics", text }], selectedRange);
const source = (text) => ({ ...parse(text), ...range });
test("ICS all-day end is exclusive, ongoing stays are included, end-before-window is excluded", () => {
  const result = parse(
    ics([
      event({ uid: "a", start: "20260930", end: "20261002" }),
      event({ uid: "b", start: "20260929", end: "20261001" }),
      event({ uid: "c", start: "20271001", end: "20271002" }),
    ]),
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].start, "2026-09-30");
  assert.equal(result.events[0].end, "2026-10-02");
  assert.equal(
    normalizeCalendar(
      { ...result, ...range },
      mapping(),
      fixture().workspace.properties[0],
    ).rows[0].draft.checkOut,
    "2026-10-02",
  );
});
test("floating dates use property timezone; UTC and TZID convert to property-local dates", () => {
  const floating = parse(
    ics([
      event({
        start: "20261010T230000",
        end: "20261012T100000",
        allDay: false,
      }),
    ]),
  );
  assert.equal(floating.events[0].start, "2026-10-10T15:00:00.000Z");
  const utc = parse(
    ics([
      event({
        start: "20261010T180000Z",
        end: "20261012T020000Z",
        allDay: false,
      }),
    ]),
  );
  assert.equal(calendarDate(utc.events[0].start, range.timezone), "2026-10-11");
  const tz = parse(
    ics([
      event({ start: "20261010T230000", end: "20261012T100000", allDay: false })
        .replace("DTSTART:", "DTSTART;TZID=America/New_York:")
        .replace("DTEND:", "DTEND;TZID=America/New_York:"),
    ]),
  );
  assert.equal(tz.events[0].start, "2026-10-11T03:00:00.000Z");
});
test("ambiguous and nonexistent DST wall times are quarantined instead of shifted", () => {
  for (const start of ["20261101T013000", "20260308T023000"]) {
    const result = parse(
      ics([
        event({ start, end: "20261103T120000", allDay: false }).replace(
          "DTSTART:",
          "DTSTART;TZID=America/New_York:",
        ),
      ]),
      { ...range, from: "2026-01-01" },
    );
    assert.match(result.events[0].issue, /時區或日期/);
  }
});
test("recurrence expansion respects EXDATE and moved RECURRENCE-ID without duplicates", () => {
  const result = parse(
    ics([
      event({
        uid: "repeat",
        start: "20261010",
        end: "20261011",
        extra: "RRULE:FREQ=DAILY;COUNT=4\r\nEXDATE;VALUE=DATE:20261011\r\n",
      }),
      event({
        uid: "repeat",
        start: "20261015",
        end: "20261016",
        extra: "RECURRENCE-ID;VALUE=DATE:20261012\r\n",
      }),
    ]),
  );
  assert.deepEqual(result.events.map((e) => e.start).sort(), [
    "2026-10-10",
    "2026-10-13",
    "2026-10-15",
  ]);
  assert.equal(
    result.events.find((e) => e.start === "2026-10-15").recurrenceId,
    "2026-10-12",
  );
  assert.equal(
    new Set(result.events.map((e) => e.key)).size,
    result.events.length,
  );
});
test("unsupported old frequent recurrence cannot disappear and make coverage falsely complete", () => {
  const result = parse(
    ics([
      event({
        uid: "hourly",
        start: "20200101T120000Z",
        end: "20200101T130000Z",
        allDay: false,
        extra: "RRULE:FREQ=HOURLY\r\n",
      }),
    ]),
  );
  assert.equal(result.events.length, 1);
  assert.match(result.events[0].issue, /每小時/);
});
test("missing UID, duplicate events, bad dates and nested components fail closed", () => {
  assert.match(parse(ics([event({ uid: "" })])).events[0].issue, /UID/);
  const same = event({ uid: "duplicate" });
  assert.match(parse(ics([same, same])).events[0].issue, /多個版本/);
  assert.match(
    parse(ics([event({ start: "20260230", end: "20260302" })])).events[0].issue,
    /日期/,
  );
  assert.throws(
    () =>
      parse(
        `BEGIN:VCALENDAR\n${"BEGIN:VALARM\n".repeat(20)}${"END:VALARM\n".repeat(20)}END:VCALENDAR`,
      ),
    /CALENDAR_FORMAT/,
  );
  assert.throws(
    () => calendarRange("2026-01-01", "2030-01-01", "Asia/Taipei"),
    /CALENDAR_RANGE/,
  );
});
test("ICS ZIP reads only calendar files, limits expansion and rejects traversal", async () => {
  const zip = new JSZip();
  zip.file("calendar.ics", ics([event()]));
  zip.file("readme.txt", "synthetic");
  const files = await calendarFiles(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    "calendars.zip",
  );
  assert.equal(files.length, 1);
  await assert.rejects(
    calendarFiles(Buffer.from([255, 254]), "calendar.ics"),
    /CALENDAR_FORMAT/,
  );
  const bomb = new JSZip();
  bomb.file("calendar.ics", "x".repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(
    calendarFiles(
      await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      "x.zip",
    ),
    /CALENDAR_SIZE/,
  );
  const traversal = new JSZip();
  traversal.file("aa/a.ics", ics([event()]));
  const raw = Buffer.from(
    (await traversal.generateAsync({ type: "nodebuffer" }))
      .toString("binary")
      .replaceAll("aa/a.ics", "../a.ics"),
    "binary",
  );
  await assert.rejects(calendarFiles(raw, "x.zip"), /CALENDAR_FORMAT/);
});
test("arrival reminders require explicit checkout; guest/amount stay unknown unless labeled", () => {
  const property = fixture().workspace.properties[0],
    s = source(
      ics([
        event({
          start: "20261010T150000",
          end: "20261010T160000",
          allDay: false,
          title: "山景房 王小姐 3000",
        }),
      ]),
    );
  const p = normalizeCalendar(
    s,
    { ...mapping(), dateMode: "arrival" },
    property,
  );
  assert.match(p.rows[0].issues.join(), /退房日期/);
  const key = s.events[0].key,
    corrected = normalizeCalendar(
      s,
      {
        ...mapping(),
        dateMode: "arrival",
        overrides: { [key]: { checkOut: "2026-10-12" } },
      },
      property,
    );
  assert.equal(corrected.rows[0].draft.total, null);
  assert.equal(corrected.rows[0].draft.guestName, null);
});
test("multicalendar same order merges stays and counts repeated deposit once; disagreements quarantine whole group", () => {
  const property = fixture().workspace.properties[0];
  const s = source(
    ics([
      event({
        uid: "room101",
        title: "山景房 客人：測試 訂單編號：A123 總額：12,000 訂金：3,000",
      }),
      event({
        uid: "room102",
        title: "庭院房 客人：測試 訂單編號：A123 總額：12,000 訂金：3,000",
      }),
    ]),
  );
  const m = { ...mapping(), rooms: {}, titleRooms: true };
  const result = normalizeCalendar(s, m, property);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].draft.stays.length, 2);
  assert.equal(result.rows[0].draft.total, 12000);
  assert.equal(result.rows[0].draft.paid, 3000);
  s.events[1].title = s.events[1].title.replace("3,000", "4,000");
  assert.match(
    normalizeCalendar(s, m, property).rows[0].issues.join(),
    /累計已付不同/,
  );
});
test("private reminders require classification, ignore requires reason, maintenance creates a block without revenue", () => {
  const property = fixture().workspace.properties[0],
    s = source(ics([event({ title: "私人生日" }), event({ title: "維修" })]));
  const result = normalizeCalendar(s, mapping(), property);
  assert.match(
    result.rows.find((r) => r.titles[0] === "私人生日").issues.join(),
    /排除的提醒/,
  );
  assert.equal(
    result.rows.find((r) => r.titles[0] === "維修").draft.kind,
    "block",
  );
  assert.equal(
    result.rows.find((r) => r.titles[0] === "維修").draft.total,
    null,
  );
  assert.throws(
    () =>
      normalizeCalendar(
        s,
        {
          ...mapping(),
          overrides: { [s.events[0].key]: { disposition: "ignore" } },
        },
        property,
      ),
    /CALENDAR_IGNORE_REASON/,
  );
  assert.equal(
    normalizeCalendar(
      s,
      {
        ...mapping(),
        overrides: {
          [s.events[0].key]: {
            disposition: "ignore",
            reason: "私人提醒不占房",
          },
        },
      },
      property,
    ).rows.find((r) => r.titles[0] === "私人生日").disposition,
    "ignored",
  );
});

test("unrelated recurring UIDs keep their own exceptions and custom VTIMEZONE is bounded", () => {
  const result = parse(
    ics([
      event({ uid: "one", extra: "RRULE:FREQ=DAILY;COUNT=2\r\n" }),
      event({ uid: "two", extra: "RRULE:FREQ=DAILY;COUNT=2\r\n" }),
      event({
        uid: "two",
        start: "20261020",
        end: "20261022",
        extra: "RECURRENCE-ID;VALUE=DATE:20261011\r\n",
      }),
    ]),
  );
  assert.equal(result.events.filter((e) => e.uid === "one").length, 2);
  assert.equal(result.events.filter((e) => e.uid === "two").length, 2);
  assert.ok(
    result.events.some((e) => e.uid === "two" && e.start === "2026-10-20"),
  );
  const zone =
    "BEGIN:VTIMEZONE\r\nTZID:Synthetic/Taipei\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n";
  const timed = event({
    start: "20261010T230000",
    end: "20261012T100000",
    allDay: false,
  })
    .replace("DTSTART:", "DTSTART;TZID=Synthetic/Taipei:")
    .replace("DTEND:", "DTEND;TZID=Synthetic/Taipei:");
  assert.equal(
    parse(ics([timed], { extra: zone })).events[0].start,
    "2026-10-10T15:00:00.000Z",
  );
  assert.throws(
    () =>
      parse(
        ics([timed], {
          extra: zone.replace(
            "TZOFFSETTO:+0800",
            "TZOFFSETTO:+0800\r\nRRULE:FREQ=DAILY;INTERVAL=7;BYDAY=MO",
          ),
        }),
      ),
    /CALENDAR_TIMEZONE/,
  );
});
test("potentially non-terminating recurrence filters become visible unresolved rows", () => {
  const result = parse(
    ics([
      event({
        uid: "bounded",
        extra: "RRULE:FREQ=DAILY;INTERVAL=7;BYDAY=MO\r\n",
      }),
    ]),
  );
  assert.equal(result.events.length, 1);
  assert.match(result.events[0].issue, /重複規則/);
});

test("malformed recurrence end and duplicate start dates cannot disappear from coverage", () => {
  const invalidUntil = parse(
    ics([
      event({
        uid: "bad-until",
        start: "20260101",
        end: "20260102",
        extra: "RRULE:FREQ=DAILY;UNTIL=20260230\r\n",
      }),
    ]),
  );
  assert.equal(invalidUntil.events.length, 1);
  assert.match(invalidUntil.events[0].issue, /日期/);
  const duplicateStart = parse(
    ics([
      event({ uid: "double-start", extra: "DTSTART;VALUE=DATE:20261030\r\n" }),
    ]),
  );
  assert.equal(duplicateStart.events.length, 1);
  assert.match(duplicateStart.events[0].issue, /日期/);
});
