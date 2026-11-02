import ICAL from "ical.js";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { digest } from "./auth.ts";
import { dateValue } from "./service.ts";
import type { CalendarEvent, CalendarSnapshot } from "./calendar-types.ts";

export const CALENDAR_UPLOAD_LIMIT = 3 * 1024 * 1024;
export const CALENDAR_EXPANDED_LIMIT = 8 * 1024 * 1024;
export const CALENDAR_EVENT_LIMIT = 2000;
export function calendarTimezone(value: unknown) {
  if (typeof value !== "string" || value.length > 100)
    throw new Error("CALENDAR_TIMEZONE");
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
  } catch {
    throw new Error("CALENDAR_TIMEZONE");
  }
  return value;
}
export function calendarRange(from: unknown, to: unknown, timezone: unknown) {
  const start = dateValue(from),
    end = dateValue(to);
  if (start >= end || Date.parse(end) - Date.parse(start) > 731 * 86400000)
    throw new Error("CALENDAR_RANGE");
  return { from: start, to: end, timezone: calendarTimezone(timezone) };
}
export function calendarDate(value: string, timezone: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dateValue(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("CALENDAR_DATE");
  return dateValue(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value)),
  );
}
export function calendarKey(
  calendarId: string,
  uid: string,
  recurrenceId?: string,
) {
  return digest(JSON.stringify([calendarId, uid, recurrenceId ?? ""]));
}
export function calendarContentHash(
  events: CalendarEvent[],
  calendars: { id: string }[],
) {
  return digest(
    JSON.stringify({
      calendars: calendars.map((c) => c.id).sort(),
      events: [...events].sort((a, b) => a.key.localeCompare(b.key)),
    }),
  );
}

// Resolve floating/IANA wall times without changing ICAL's process-global timezone registry.
function wallTime(time: ICAL.Time, zone: string): string {
  calendarTimezone(zone);
  const value = Date.UTC(
    time.year,
    time.month - 1,
    time.day,
    time.hour,
    time.minute,
    time.second,
  );
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = (stamp: number) =>
    Object.fromEntries(
      formatter
        .formatToParts(new Date(stamp))
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, Number(p.value)]),
    );
  const candidates = new Set<number>();
  for (const shift of [-36, -12, 0, 12, 36]) {
    const stamp = value + shift * 3600000,
      p = parts(stamp);
    const offset =
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - stamp;
    const candidate = value - offset,
      actual = parts(candidate);
    if (
      actual.year === time.year &&
      actual.month === time.month &&
      actual.day === time.day &&
      actual.hour === time.hour &&
      actual.minute === time.minute &&
      actual.second === time.second
    )
      candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new Error("CALENDAR_DATE");
  return new Date([...candidates][0]).toISOString();
}
function icalTime(
  time: ICAL.Time,
  property: ICAL.Property | null,
  fallback: string,
) {
  if (!time) throw new Error("CALENDAR_DATE");
  if (time.isDate) return dateValue(time.toString());
  const tzid = property?.getParameter("tzid");
  if (typeof tzid === "string") {
    let known = false;
    try {
      calendarTimezone(tzid);
      known = true;
    } catch {
      /* Embedded custom zone is checked before use. */
    }
    if (known) return wallTime(time, tzid);
  }
  if (time.zone && time.zone.tzid !== "floating") {
    const result = new Date(time.toUnixTime() * 1000).toISOString();
    calendarDate(result, fallback);
    return result;
  }
  return wallTime(time, typeof tzid === "string" ? tzid : fallback);
}
function safeText(value: unknown, max: number) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > max)
    throw new Error("CALENDAR_SIZE");
  return value;
}
function decode(buffer: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(buffer)
      .replace(/^\uFEFF/, "");
  } catch {
    throw new Error("CALENDAR_FORMAT");
  }
}
export async function calendarFiles(
  buffer: Buffer,
  filename: string,
): Promise<{ name: string; text: string }[]> {
  if (
    !buffer.length ||
    buffer.length > CALENDAR_UPLOAD_LIMIT ||
    filename.length > 240
  )
    throw new Error("CALENDAR_SIZE");
  if (/\.ics$/i.test(filename))
    return [{ name: filename, text: decode(buffer) }];
  if (!/\.zip$/i.test(filename)) throw new Error("CALENDAR_FORMAT");
  return new Promise((resolve, reject) => {
    let archive: ZipFile | undefined,
      bytes = 0,
      entries = 0,
      settled = false;
    const files: { name: string; text: string }[] = [];
    const fail = (code = "CALENDAR_FORMAT") => {
      if (settled) return;
      settled = true;
      archive?.close();
      reject(new Error(code));
    };
    fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (err, zip) => {
        if (err || !zip) return fail();
        archive = zip;
        if (zip.entryCount > 100) return fail("CALENDAR_SIZE");
        zip.on("error", () => fail());
        zip.on("end", () => {
          if (!settled) {
            settled = true;
            if (files.length) resolve(files);
            else reject(new Error("CALENDAR_FORMAT"));
          }
        });
        zip.on("entry", (entry: Entry) => {
          if (
            ++entries > 100 ||
            entry.uncompressedSize > CALENDAR_EXPANDED_LIMIT ||
            bytes + entry.uncompressedSize > CALENDAR_EXPANDED_LIMIT
          )
            return fail("CALENDAR_SIZE");
          if (
            entry.isEncrypted() ||
            /(^|\/)\.\.(\/|$)|^\/|\\|^[A-Za-z]:/.test(entry.fileName)
          )
            return fail();
          if (
            /\/$/.test(entry.fileName) ||
            entry.fileName.startsWith("__MACOSX/") ||
            !/\.ics$/i.test(entry.fileName)
          ) {
            zip.readEntry();
            return;
          }
          if (files.length >= 30) return fail("CALENDAR_SIZE");
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) return fail();
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > CALENDAR_EXPANDED_LIMIT) {
                stream.destroy();
                fail("CALENDAR_SIZE");
              } else chunks.push(chunk);
            });
            stream.on("error", () => fail());
            stream.on("end", () => {
              if (settled) return;
              try {
                files.push({
                  name: entry.fileName,
                  text: decode(Buffer.concat(chunks)),
                });
                zip.readEntry();
              } catch {
                fail();
              }
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

// Keep local expansion to common, bounded calendar rules. More complex rules
// can be expanded by Google's API or explicitly reviewed instead of looping in
// an untrusted RFC recurrence iterator with no internal time budget.
function boundedRule(component: ICAL.Component) {
  if (component.getAllProperties("rdate").some((p) => p.type === "period"))
    return false;
  if (
    component.hasProperty("exrule") ||
    component.getAllProperties("rrule").length > 1
  )
    return false;
  for (const rule of component.getAllProperties("rrule")) {
    const parts = Object.fromEntries(
      rule
        .toICALString()
        .slice(6)
        .split(";")
        .map((part) => {
          const at = part.indexOf("=");
          return [part.slice(0, at).toUpperCase(), part.slice(at + 1)];
        }),
    );
    const frequency = parts.FREQ;
    const allowed = [
      "FREQ",
      "INTERVAL",
      "COUNT",
      "UNTIL",
      "WKST",
      ...(frequency === "WEEKLY"
        ? ["BYDAY"]
        : frequency === "MONTHLY"
          ? ["BYDAY", "BYMONTHDAY"]
          : []),
    ];
    if (
      !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(frequency) ||
      Object.keys(parts).some((key) => !allowed.includes(key))
    )
      return false;
    if (
      parts.INTERVAL &&
      (!/^\d+$/.test(parts.INTERVAL) ||
        Number(parts.INTERVAL) < 1 ||
        Number(parts.INTERVAL) > 366)
    )
      return false;
    if (
      parts.COUNT &&
      (!/^\d+$/.test(parts.COUNT) ||
        Number(parts.COUNT) < 1 ||
        Number(parts.COUNT) > 30000)
    )
      return false;
    if (
      parts.BYDAY &&
      !parts.BYDAY.split(",").every((day) =>
        (frequency === "WEEKLY"
          ? /^(MO|TU|WE|TH|FR|SA|SU)$/
          : /^(?:-?[1-4])?(MO|TU|WE|TH|FR|SA|SU)$/
        ).test(day),
      )
    )
      return false;
    if (
      parts.BYMONTHDAY &&
      (parts.BYDAY ||
        !parts.BYMONTHDAY.split(",").every(
          (day) => /^-?[1-9][0-9]?$/.test(day) && Math.abs(Number(day)) <= 31,
        ))
    )
      return false;
  }
  return true;
}
function invalidRawDate(component: ICAL.Component) {
  try {
    if (
      component.getAllProperties("uid").length !== 1 ||
      ["dtstart", "dtend", "recurrence-id"].some(
        (name) => component.getAllProperties(name).length > 1,
      )
    )
      return true;
    for (const rule of component.getAllProperties("rrule")) {
      const raw = rule.toJSON()[3] as Record<string, unknown>;
      if (raw && typeof raw.until === "string") {
        dateValue(raw.until.slice(0, 10));
        if (
          raw.until.length > 10 &&
          !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ?$/.test(
            raw.until,
          )
        )
          return true;
      }
    }
    for (const name of ["dtstart", "dtend", "recurrence-id", "rdate", "exdate"])
      for (const property of component.getAllProperties(name)) {
        for (const value of property.toJSON().slice(3)) {
          const dates = Array.isArray(value) ? value : [value];
          for (const date of dates) {
            if (
              typeof date !== "string" ||
              date.startsWith("P") ||
              date.startsWith("-P")
            )
              continue;
            dateValue(date.slice(0, 10));
            if (
              date.length > 10 &&
              !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ?$/.test(
                date,
              )
            )
              return true;
          }
        }
      }
    return false;
  } catch {
    return true;
  }
}
function checkEmbeddedZones(root: ICAL.Component) {
  const zones = root.getAllSubcomponents("vtimezone");
  if (zones.length > 50) throw new Error("CALENDAR_SIZE");
  for (const zone of zones)
    for (const observance of zone.getAllSubcomponents()) {
      if (observance.getAllProperties("rrule").length > 1)
        throw new Error("CALENDAR_TIMEZONE");
      for (const property of observance.getAllProperties("rrule")) {
        const text: string = property.toICALString().slice(6);
        if (text.length > 256) throw new Error("CALENDAR_TIMEZONE");
        const parts: Record<string, string> = Object.fromEntries(
          text.split(";").map((part) => part.split("=")),
        );
        if (
          parts.FREQ !== "YEARLY" ||
          Object.keys(parts).some(
            (key) =>
              ![
                "FREQ",
                "UNTIL",
                "COUNT",
                "INTERVAL",
                "BYMONTH",
                "BYDAY",
                "BYMONTHDAY",
                "WKST",
              ].includes(key),
          ) ||
          (parts.BYDAY && parts.BYMONTHDAY) ||
          (parts.INTERVAL &&
            (!/^\d+$/.test(parts.INTERVAL) ||
              Number(parts.INTERVAL) < 1 ||
              Number(parts.INTERVAL) > 10))
        )
          throw new Error("CALENDAR_TIMEZONE");
        if (
          parts.BYMONTH &&
          !parts.BYMONTH.split(",").every(
            (n) => /^\d{1,2}$/.test(n) && Number(n) >= 1 && Number(n) <= 12,
          )
        )
          throw new Error("CALENDAR_TIMEZONE");
        if (
          parts.BYDAY &&
          !parts.BYDAY.split(",").every((n) =>
            /^(?:-?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/.test(n),
          )
        )
          throw new Error("CALENDAR_TIMEZONE");
        if (
          parts.BYMONTHDAY &&
          !parts.BYMONTHDAY.split(",").every(
            (n) => /^-?[1-9][0-9]?$/.test(n) && Math.abs(Number(n)) <= 31,
          )
        )
          throw new Error("CALENDAR_TIMEZONE");
      }
    }
}
export function parseCalendarFiles(
  files: { name: string; text: string }[],
  range: { from: string; to: string; timezone: string },
) {
  calendarRange(range.from, range.to, range.timezone);
  const calendars: CalendarSnapshot["calendars"] = [],
    events: CalendarEvent[] = [];
  let components = 0,
    iterations = 0;
  const deadline = Date.now() + 8000;
  for (const file of files) {
    if (
      file.text.length > CALENDAR_EXPANDED_LIMIT ||
      (file.text.match(/^BEGIN:/gim)?.length ?? 0) > 15000
    )
      throw new Error("CALENDAR_SIZE");
    let depth = 0;
    for (const line of file.text.split(/\r?\n/)) {
      if (/^BEGIN:/i.test(line) && ++depth > 12)
        throw new Error("CALENDAR_FORMAT");
      if (/^END:/i.test(line)) depth--;
    }
    let root: ICAL.Component;
    try {
      root = new ICAL.Component(ICAL.parse(file.text));
    } catch {
      throw new Error("CALENDAR_FORMAT");
    }
    if (root.name !== "vcalendar") throw new Error("CALENDAR_FORMAT");
    checkEmbeddedZones(root);
    const title = safeText(root.getFirstPropertyValue("x-wr-calname"), 200);
    const id =
      safeText(root.getFirstPropertyValue("x-wr-relcalid"), 500) ||
      title ||
      "ics-unlabelled";
    if (calendars.some((c) => c.id === id))
      throw new Error("CALENDAR_DUPLICATE_SOURCE");
    const sourceZone = root.getFirstPropertyValue("x-wr-timezone");
    const timezone =
      typeof sourceZone === "string"
        ? calendarTimezone(sourceZone)
        : range.timezone;
    const rawEvents = root.getAllSubcomponents("vevent");
    components += rawEvents.length;
    if (components > 10000) throw new Error("CALENDAR_SIZE");
    const seen = new Set<string>();
    const add = (
      item: ICAL.Event,
      start: ICAL.Time,
      end: ICAL.Time,
      original?: ICAL.Time,
      forcedIssue?: string,
    ) => {
      if (Date.now() > deadline) throw new Error("CALENDAR_SIZE");
      let startValue = "",
        endValue = "",
        recurrenceId: string | undefined;
      const uid = safeText(item.uid, 500);
      let issue =
        forcedIssue || (!uid ? "缺少活動 UID，請重新匯出完整日曆" : undefined);
      try {
        startValue = icalTime(
          start,
          item.component.getFirstProperty("dtstart"),
          timezone,
        );
        endValue = icalTime(
          end,
          item.component.getFirstProperty("dtend") ??
            item.component.getFirstProperty("dtstart"),
          timezone,
        );
        if (original)
          recurrenceId = icalTime(
            original,
            item.component.getFirstProperty("recurrence-id") ??
              item.component.getFirstProperty("dtstart"),
            timezone,
          );
        const startDate = calendarDate(startValue, range.timezone),
          endDate = calendarDate(endValue, range.timezone);
        if (
          !forcedIssue &&
          (startDate >= range.to ||
            endDate < range.from ||
            (endDate === range.from && endDate !== startDate))
        )
          return;
        if (endValue < startValue) issue = "活動結束早於開始，請核對日期";
        if (Boolean(start.isDate) !== Boolean(end.isDate))
          issue = "活動開始與結束的日期型態不同，請核對";
      } catch {
        issue = "活動時區或日期無法確定，請核對原始資料";
      }
      const key = calendarKey(
        id,
        uid || digest(item.component.toString()),
        recurrenceId,
      );
      if (seen.has(key)) {
        events.find((e) => e.key === key)!.issue =
          "同一活動實例出現多個版本，請核對來源";
        return;
      }
      seen.add(key);
      events.push({
        key,
        calendarId: id,
        uid,
        ...(recurrenceId ? { recurrenceId } : {}),
        title: safeText(item.summary, 500),
        description: safeText(item.description, 8000),
        start: startValue,
        end: endValue,
        allDay: Boolean(start?.isDate),
        cancelled:
          String(
            item.component.getFirstPropertyValue("status") ?? "",
          ).toUpperCase() === "CANCELLED",
        color:
          safeText(item.component.getFirstPropertyValue("color"), 100) ||
          undefined,
        issue,
        version: digest(item.component.toString()),
      });
      if (events.length > CALENDAR_EVENT_LIMIT)
        throw new Error("CALENDAR_SIZE");
    };
    const masters = new Set(
      rawEvents
        .filter((c) => !c.hasProperty("recurrence-id"))
        .map((c) => String(c.getFirstPropertyValue("uid"))),
    );
    const exceptions = new Map<string, ICAL.Component[]>();
    for (const c of rawEvents.filter((c) => c.hasProperty("recurrence-id"))) {
      const uid = String(c.getFirstPropertyValue("uid"));
      exceptions.set(uid, [...(exceptions.get(uid) ?? []), c]);
    }
    for (const component of rawEvents) {
      let item: ICAL.Event;
      try {
        item = new ICAL.Event(component, {
          strictExceptions: true,
          exceptions: component.hasProperty("recurrence-id")
            ? []
            : (exceptions.get(String(component.getFirstPropertyValue("uid"))) ??
              []),
        });
      } catch {
        throw new Error("CALENDAR_FORMAT");
      }
      try {
        if (invalidRawDate(component)) {
          add(
            item,
            undefined as unknown as ICAL.Time,
            undefined as unknown as ICAL.Time,
            undefined,
            "活動含無效日期，請核對原始資料",
          );
          continue;
        }

        if (item.isRecurrenceException()) {
          // Also inspect exceptions individually: a moved occurrence may enter the window from outside it.
          if (item.modifiesFuture()) {
            add(
              item,
              item.startDate,
              item.endDate,
              item.recurrenceId,
              "此重複活動修改了本次及未來活動，請先核對",
            );
            continue;
          }
          add(
            item,
            item.startDate,
            item.endDate,
            item.recurrenceId,
            masters.has(item.uid)
              ? undefined
              : "重複活動缺少原始系列，請核對匯出檔",
          );
          continue;
        }
        if (!item.isRecurring()) {
          add(item, item.startDate, item.endDate);
          continue;
        }
        const types = item.getRecurrenceTypes();
        if (types.SECONDLY || types.MINUTELY || types.HOURLY) {
          add(
            item,
            item.startDate,
            item.endDate,
            undefined,
            "請核對每小時或更頻繁的重複活動",
          );
          continue;
        }
        if (!boundedRule(component)) {
          add(
            item,
            item.startDate,
            item.endDate,
            undefined,
            "此重複規則需先核對，或改用 Google 授權展開完整活動",
          );
          continue;
        }
        const iterator = item.iterator();
        let next: ICAL.Time | undefined;
        while ((next = iterator.next())) {
          if (++iterations > 30000) throw new Error("CALENDAR_SIZE");
          if (next.toString().slice(0, 10) > range.to) break;
          const details = item.getOccurrenceDetails(next);
          // Exceptions are emitted separately above so a moved date is never doubled.
          if (details.item !== item) continue;
          add(item, details.startDate, details.endDate, next);
        }
      } catch (error) {
        if (error instanceof Error && error.message === "CALENDAR_SIZE")
          throw error;
        add(
          item,
          undefined as unknown as ICAL.Time,
          undefined as unknown as ICAL.Time,
          undefined,
          "無法完整解析此活動，請核對日期或重複規則",
        );
      }
    }
    calendars.push({
      id,
      name: title || file.name.replace(/\.ics$/i, ""),
      count: events.filter((e) => e.calendarId === id).length,
    });
  }
  return {
    calendars,
    events,
    contentHash: calendarContentHash(events, calendars),
  };
}
