import { digest } from "./auth.ts";
import { calendarDate } from "./calendar-source.ts";
import { dateValue, money, normalizeStays, textValue } from "./service.ts";
import type { Property } from "./types.ts";
import type {
  CalendarSnapshot,
  CalendarMapping,
  CalendarEventOverride,
  CalendarPreviewRow,
  CalendarDraft,
} from "./calendar-types.ts";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function validateCalendarMapping(
  input: unknown,
  source: CalendarSnapshot,
  property: Property,
): CalendarMapping {
  if (
    !record(input) ||
    !Array.isArray(input.calendarIds) ||
    !input.calendarIds.length ||
    input.calendarIds.length > 30 ||
    input.calendarIds.some(
      (id) =>
        typeof id !== "string" || !source.calendars.some((c) => c.id === id),
    ) ||
    !record(input.rooms) ||
    !record(input.overrides) ||
    !["stay", "arrival"].includes(String(input.dateMode)) ||
    typeof input.titleRooms !== "boolean" ||
    typeof input.extractLabels !== "boolean"
  )
    throw new Error("INVALID_INPUT");
  const ids = [...new Set(input.calendarIds as string[])].sort();
  const rooms: Record<string, string[]> = Object.create(null);
  function roomIds(value: unknown) {
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      value.some((id) => !property.rooms.some((r) => r.id === id))
    )
      throw new Error("INVALID_INPUT");
    return [...new Set(value as string[])].sort();
  }
  for (const [key, value] of Object.entries(input.rooms)) {
    if (!ids.includes(key)) throw new Error("INVALID_INPUT");
    rooms[key] = roomIds(value);
  }
  const overrides: Record<string, CalendarEventOverride> = Object.create(null);
  if (Object.keys(input.overrides).length > 2000)
    throw new Error("CALENDAR_SIZE");
  for (const [key, value] of Object.entries(input.overrides)) {
    if (!source.events.some((e) => e.key === key) || !record(value))
      throw new Error("INVALID_INPUT");
    if (
      Object.keys(value).some(
        (k) =>
          ![
            "disposition",
            "reason",
            "roomIds",
            "checkIn",
            "checkOut",
            "group",
            "guestName",
            "total",
            "paid",
          ].includes(k),
      )
    )
      throw new Error("INVALID_INPUT");
    const row: CalendarEventOverride = {};
    if (value.disposition !== undefined) {
      if (!["booking", "block", "ignore"].includes(String(value.disposition)))
        throw new Error("INVALID_INPUT");
      row.disposition =
        value.disposition as CalendarEventOverride["disposition"];
    }
    if (value.reason !== undefined)
      row.reason = textValue(value.reason, 500) ?? "";
    if (row.disposition === "ignore" && !row.reason)
      throw new Error("CALENDAR_IGNORE_REASON");
    if (value.roomIds !== undefined) row.roomIds = roomIds(value.roomIds);
    if (value.checkIn !== undefined) row.checkIn = dateValue(value.checkIn);
    if (value.checkOut !== undefined) row.checkOut = dateValue(value.checkOut);
    if (value.group !== undefined)
      row.group = textValue(value.group, 100) ?? "";
    if (value.guestName !== undefined)
      row.guestName = textValue(value.guestName, 100) ?? "";
    if (value.total !== undefined) row.total = money(value.total);
    if (value.paid !== undefined) row.paid = money(value.paid);
    overrides[key] = row;
  }
  return {
    calendarIds: ids,
    rooms,
    overrides,
    dateMode: input.dateMode as CalendarMapping["dateMode"],
    titleRooms: input.titleRooms,
    extractLabels: input.extractLabels,
  };
}
const after = (date: string, nights: number) =>
  dateValue(
    new Date(Date.parse(date) + nights * 86400000).toISOString().slice(0, 10),
  );
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function label(text: string, names: string, amount = false) {
  const match = [
    ...text.matchAll(
      new RegExp(
        `(?:^|[\\s|｜,，;；])(?:${names})\\s*[:：=]?\\s*${amount ? "(?:NT\\$|TWD|\\$)?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)(?=$|[\\s|｜;；元，])" : "([^\\s|｜,，;；]+)"}`,
        "gi",
      ),
    ),
  ].map((m) => m[1]);
  if (new Set(match).size > 1) throw new Error("同一活動的欄位值互相矛盾");
  return match[0] ?? null;
}
function knownMoney(value: string | null) {
  if (value === null) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value))
    throw new Error("金額格式不明");
  return money(Number(value.replaceAll(",", "")));
}
function uniqueMoney(values: (number | null)[], title: string) {
  const known = [...new Set(values.filter((n): n is number => n !== null))];
  if (known.length > 1) throw new Error(`同一訂單的${title}不同，請核對整組`);
  return known[0] ?? null;
}
export const calendarFingerprint = (draft: CalendarDraft) =>
  digest(JSON.stringify(draft));

export function normalizeCalendar(
  source: CalendarSnapshot,
  input: unknown,
  property: Property,
) {
  const mapping = validateCalendarMapping(input, source, property);
  const rows: CalendarPreviewRow[] = [];
  const groups = new Map<
    string,
    {
      keys: string[];
      titles: string[];
      drafts: CalendarDraft[];
      issues: string[];
    }
  >();
  let roomNights = 0;
  for (const event of source.events.filter((e) =>
    mapping.calendarIds.includes(e.calendarId),
  )) {
    const override = mapping.overrides[event.key] ?? {};
    if (override.disposition === "ignore" || event.cancelled) {
      rows.push({
        id: event.key,
        eventKeys: [event.key],
        titles: [event.title],
        draft: null,
        issues: [],
        disposition: event.cancelled ? "cancelled" : "ignored",
        fingerprint: digest(
          JSON.stringify([event.key, override.reason ?? "cancelled"]),
        ),
      });
      continue;
    }
    const text = `${event.title}\n${event.description}`;
    let externalId: string | null = override.group || null,
      extractionIssue = "";
    try {
      if (!externalId && mapping.extractLabels)
        externalId = label(text, "訂單編號|訂單號|order\\s*id");
    } catch {
      extractionIssue = "活動的訂單編號互相矛盾";
    }
    const groupKey = externalId ? `order:${externalId}` : `event:${event.key}`;
    const group = groups.get(groupKey) ?? {
      keys: [],
      titles: [],
      drafts: [],
      issues: [],
    };
    groups.set(groupKey, group);
    group.keys.push(event.key);
    group.titles.push(event.title);
    try {
      if (extractionIssue) throw new Error(extractionIssue);
      if (event.issue) throw new Error(event.issue);
      const inferredBlock =
        /(?:^|[\s|｜,，;；])(維修|自用|停賣|封房|maintenance)(?:$|[\s|｜,，;；])/i.test(
          text,
        );
      if (
        override.disposition === undefined &&
        /清潔|打掃|私人|生日|聚餐/.test(event.title)
      )
        throw new Error("請確認這是住宿、封房還是可排除的提醒");
      const kind =
        override.disposition === "block" ||
        (override.disposition === undefined && inferredBlock)
          ? "block"
          : "booking";
      let roomIds = override.roomIds ?? mapping.rooms[event.calendarId] ?? [];
      if (!roomIds.length && mapping.titleRooms)
        roomIds = property.rooms
          .filter((r) =>
            new RegExp(
              `(?:^|[\\s|｜,，;；])${escape(r.name)}(?=$|[\\s|｜,，;；])`,
              "u",
            ).test(event.title),
          )
          .map((r) => r.id);
      if (!roomIds.length) throw new Error("尚未對應房間");
      const checkIn =
        override.checkIn ?? calendarDate(event.start, source.timezone);
      let checkOut = override.checkOut;
      if (!checkOut) {
        if (mapping.dateMode === "stay")
          checkOut = calendarDate(event.end, source.timezone);
        else {
          const date = mapping.extractLabels
            ? label(text, "退房|check-?out")
            : null;
          const nights = mapping.extractLabels
            ? [
                ...text.matchAll(
                  /(?:^|[\s|｜,，;；])(\d{1,3})\s*(?:晚|nights?)(?=$|[\s|｜,，;；])/gi,
                ),
              ].map((m) => Number(m[1]))
            : [];
          if (new Set(nights).size > 1) throw new Error("活動包含不同住宿晚數");
          checkOut = date
            ? dateValue(date)
            : nights[0]
              ? after(checkIn, nights[0])
              : undefined;
        }
      }
      if (!checkOut) throw new Error("入住提醒缺少退房日期或明確晚數");
      if (checkOut <= checkIn)
        throw new Error("請填完整住宿區間；同日短時間活動不能當成住宿一晚");
      if (checkIn >= source.to || checkOut <= source.from)
        throw new Error("調整後的住宿不在本次核對區間內");
      const stays = normalizeStays(property, { checkIn, checkOut, roomIds });
      roomIds = stays[0].roomIds;
      roomNights +=
        ((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000) *
        roomIds.length;
      if (roomNights > 20000) throw new Error("CALENDAR_SIZE");
      const guestName =
        override.guestName !== undefined
          ? textValue(override.guestName, 100)
          : mapping.extractLabels
            ? textValue(label(text, "旅客|客人|姓名|guest"), 100)
            : null;
      const total =
        kind === "block"
          ? null
          : override.total !== undefined
            ? override.total
            : mapping.extractLabels
              ? knownMoney(label(text, "訂單總額|總額|total", true))
              : null;
      const paid =
        kind === "block"
          ? null
          : override.paid !== undefined
            ? override.paid
            : mapping.extractLabels
              ? knownMoney(label(text, "累計已付|訂金|已付|deposit|paid", true))
              : null;
      if (
        mapping.extractLabels &&
        /(?:USD|JPY|EUR|人民幣|美金|美元|日圓)/i.test(text) &&
        (total !== null || paid !== null)
      )
        throw new Error("目前款項以 TWD 記錄，請核對幣別並另行填寫金額");
      group.drafts.push({
        kind,
        guestName,
        reason: kind === "block" ? override.reason || "日曆封房" : null,
        externalId: textValue(externalId, 100),
        checkIn,
        checkOut,
        roomIds,
        stays,
        total,
        paid,
        ...(kind === "booking" && event.description.trim() ? { notes: event.description.trim() } : {}),
      });
    } catch (e) {
      if (e instanceof Error && e.message === "CALENDAR_SIZE") throw e;
      group.issues.push(
        e instanceof Error && e.message !== "INVALID_INPUT"
          ? e.message
          : "日期、房間或金額格式無法確定",
      );
    }
  }
  for (const group of groups.values()) {
    const row: CalendarPreviewRow = {
      id: digest(JSON.stringify([...group.keys].sort())),
      eventKeys: [...group.keys].sort(),
      titles: group.titles,
      draft: null,
      issues: [...new Set(group.issues)],
      disposition: "issue",
      fingerprint: "",
    };
    if (!row.issues.length)
      try {
        const values = group.drafts;
        if (!values.length || new Set(values.map((v) => v.kind)).size !== 1)
          throw new Error("同一訂單混有封房與住宿活動");
        const names = [
          ...new Set(values.flatMap((v) => (v.guestName ? [v.guestName] : []))),
        ];
        if (names.length > 1) throw new Error("同一訂單的客人不同，請核對整組");
        const stays = normalizeStays(property, {
          stays: values.flatMap((v) => v.stays),
        });
        row.draft = {
          kind: values[0].kind,
          guestName: names[0] ?? null,
          reason: values[0].reason,
          externalId: values[0].externalId,
          checkIn: stays[0].checkIn,
          checkOut: stays.reduce(
            (d, s) => (d > s.checkOut ? d : s.checkOut),
            stays[0].checkOut,
          ),
          roomIds: [...new Set(stays.flatMap((s) => s.roomIds))].sort(),
          stays,
          total: uniqueMoney(
            values.map((v) => v.total),
            "訂單總額",
          ),
          paid: uniqueMoney(
            values.map((v) => v.paid),
            "累計已付",
          ),
        };
        const notes = [...new Set(values.flatMap(v => v.notes ? [v.notes] : []))].join("\n\n");
        if (notes) row.draft.notes = notes;
        const overridden = row.eventKeys
          .filter((key) => Object.keys(mapping.overrides[key] ?? {}).length)
          .map((key) => [
            key,
            source.events.find((e) => e.key === key)?.version,
          ]);
        row.fingerprint = overridden.length
          ? digest(JSON.stringify([calendarFingerprint(row.draft), overridden]))
          : calendarFingerprint(row.draft);
        row.disposition = "ready";
      } catch (e) {
        row.issues.push(
          e instanceof Error && e.message === "ROOM_CONFLICT"
            ? "同組活動重複占用同一房間，請核對副本或分組"
            : e instanceof Error
              ? e.message
              : "無法轉換此組活動",
        );
      }
    rows.push(row);
  }
  return { mapping, rows: rows.sort((a, b) => a.id.localeCompare(b.id)) };
}
