import { randomUUID } from "node:crypto";
export const range = {
  from: "2026-10-01",
  to: "2027-10-01",
  timezone: "Asia/Taipei",
};
export function fixture() {
  const workspace = {
    id: "calendar-workspace",
    slug: "calendar-inn",
    name: "Synthetic calendar inn",
    version: 1,
    members: [
      {
        accountId: "calendar-owner",
        role: "owner",
        active: true,
        allProperties: true,
        propertyIds: [],
      },
    ],
    properties: [
      {
        id: "property",
        name: "Synthetic",
        kind: "mixed",
        sourceMode: "native",
        rooms: [
          { id: "101", name: "山景房" },
          { id: "102", name: "庭院房" },
        ],
        villaRoomIds: ["101", "102"],
        setup: {
          mode: "calendar",
          calendarKind: "google_calendar",
          unresolvedCount: 1,
        },
      },
    ],
    bookings: [],
    audit: [],
  };
  const data = new Map([
    [`slug:${workspace.slug}`, JSON.stringify(workspace.id)],
    [`workspace:${workspace.id}`, JSON.stringify(workspace)],
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
  return {
    store,
    workspace,
    args: [store, "calendar-owner", workspace.slug, "property"],
    current: async () => (await store.read(`workspace:${workspace.id}`)).value,
    put: async (w) => data.set(`workspace:${workspace.id}`, JSON.stringify(w)),
  };
}
export function ics(
  events,
  { id = "room-cal", name = "房間日曆", extra = "" } = {},
) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic fixtures//EN\r\nX-WR-RELCALID:${id}\r\nX-WR-CALNAME:${name}\r\n${extra}${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
}
export function event({
  uid = randomUUID(),
  start = "20261010",
  end = "20261012",
  title = "山景房 客人：測試旅客",
  extra = "",
  allDay = true,
  description = "",
} = {}) {
  return `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART${allDay ? ";VALUE=DATE" : ""}:${start}\r\nDTEND${allDay ? ";VALUE=DATE" : ""}:${end}\r\nSUMMARY:${title}\r\n${description ? `DESCRIPTION:${description}\r\n` : ""}${extra}END:VEVENT`;
}
export const mapping = (overrides = {}) => ({
  calendarIds: ["room-cal"],
  rooms: { "room-cal": ["101"] },
  dateMode: "stay",
  titleRooms: false,
  extractLabels: true,
  overrides,
  ...{},
});
export function googleConfig() {
  process.env.CUSTOMER_CALENDAR_CLIENT_ID = "synthetic-calendar-client";
  process.env.CUSTOMER_CALENDAR_CLIENT_SECRET = "synthetic-secret";
  process.env.CUSTOMER_CALENDAR_REDIRECT_URI =
    "https://test.local/api/customer-calendar/callback";
  process.env.CUSTOMER_CALENDAR_TOKEN_KEY = Buffer.alloc(32, 8).toString(
    "base64",
  );
  process.env.CUSTOMER_CALENDAR_SYNC_ENABLED = "true";
  process.env.CRON_SECRET = "synthetic-cron-secret";
}
export const scopes =
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly";
