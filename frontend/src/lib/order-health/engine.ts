import { analysisCopy, sourceStayKind, type StayKind } from "../hospitality-mode.ts";
import { createHash } from "node:crypto";
import { buildBookingCohorts } from "./momentum.ts";
import { buildAnalysis, taipeiDate } from "./analytics.ts";
import type {
  Answers,
  Field,
  Job,
  Night,
  Question,
  Report,
  Table,
} from "./types.ts";
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const day = 86400000;
const value = (t: Table, r: Table["rows"][number], f: Field) =>
  t.mapping[f] === undefined ? "" : (r.cells[t.mapping[f]!] ?? "");
const distinct = (t: Table, f: Field) => [
  ...new Set(t.rows.map((r) => value(t, r, f)).filter(Boolean)),
];
const question = (
  id: string,
  title: string,
  note: string,
  options: [string, string][],
): Question => ({
  id,
  title,
  note,
  options: [
    ...options.map(([value, label]) => ({ value, label })),
    { value: "skip", label: "不確定，先略過" },
  ],
});
function compatibleTables(tables: Table[]) {
  return (
    tables.length > 1 &&
    tables.every(
      (t) =>
        hash([t.headers, t.mapping]) ===
        hash([tables[0].headers, tables[0].mapping]),
    )
  );
}
export function selectedTables(job: Pick<Job, "tables" | "answers">): Table[] {
  const key = job.answers.table;
  if (job.tables.length === 1) return job.tables;
  if (key === "all" && compatibleTables(job.tables))
    return [
      {
        ...job.tables[0],
        id: "all",
        title: "合併明細",
        rows: job.tables.flatMap((t) =>
          t.rows.map((r) => ({ ...r, source: t.title })),
        ),
      },
    ];
  return job.tables.filter((t) => t.id === key);
}
export function questions(
  job: Pick<Job, "tables" | "answers" | "questions" | "receptionKind">,
): Question[] {
  const previous = [...job.questions];
  const add = (q: Question) => {
    if (previous.length < 5 && !previous.some((p) => p.id === q.id))
      previous.push(q);
  };
  if (job.tables.length > 1 && !job.answers.table) {
    add(
      question(
        "table",
        "哪張工作表是本次要分析的明細？",
        "請選明細，不包含月度摘要。只有欄位一致的明細表可合併，重複編號會隔離。",
        [
          ...job.tables.map(
            (t) =>
              [t.id, `${t.title}（${t.rows.length} 列）`] as [string, string],
          ),
          ...(compatibleTables(job.tables)
            ? [["all", "合併全部同欄位明細表"] as [string, string]]
            : []),
        ],
      ),
    );
    return previous;
  }
  const tables = selectedTables(job);
  if (!tables.length) return previous;
  const t = tables[0];
  if (t.mapping.property !== undefined) {
    const properties = distinct(t, "property");
    if (properties.length)
      add(
        question(
          "property",
          "哪個館別屬於目前旅宿？",
          "只納入你選擇的館別；空白館別會排除。",
          properties.slice(0, 30).map((p) => [p, p]),
        ),
      );
  }
  add(
    question(
      "unit",
      "每一列代表什麼？",
      "依接客形式與每列記法計算；不確定時先核對資料。",
      job.receptionKind === "villa" ? [
        ["stay", "A. 一筆包棟一列：9/1 入住、9/3 退房"],
        ["night", "B. 包棟每晚一列：9/1 一列、9/2 一列"],
        ["split", "C. 同筆包棟按房間拆列（有共同訂單編號）"],
      ] : job.receptionKind === "mixed" ? [
        ["stay", "A. 包棟一筆一列；散客每間房一列"],
        ["night", "B. 包棟或散客房間，都是每晚一列"],
        ["multi", "C. 每筆訂單一列；散客有訂房間數"],
      ] : [
        ["stay", "一間房的一段住宿"],
        ["night", "一間房的一晚"],
        ["multi", "多間房的一筆訂單（有房數欄）"],
      ],
    ),
  );
  if (
    t.rows.some((r) =>
      ["checkIn", "checkOut", "booked"].some((f) =>
        /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(value(t, r, f as Field)),
      ),
    )
  )
    add(
      question(
        "date",
        "例如 03/04/2026，哪個是正確日期順序？",
        "此設定套用本表的日／月短格式；混用格式的列會排除。",
        [
          ["dmy", "日／月／年（4 月 3 日）"],
          ["mdy", "月／日／年（3 月 4 日）"],
        ],
      ),
    );
  if (t.mapping.status === undefined)
    add(
      question(
        "active",
        "這份資料是否已經排除取消訂單？",
        "沒有狀態欄，需確認才能納入；不確定時暫停本份分析。",
        [
          ["yes", "是，只包含有效訂單"],
          ["no", "否，仍包含取消訂單"],
        ],
      ),
    );
  if (t.mapping.amount !== undefined)
    add(
      question(
        "money",
        `「${t.headers[t.mapping.amount]}」代表什麼金額？`,
        "只將完整房費納入分析。訂金、撥款或未知口徑僅分析房晚。",
        [
          ["total", "這一列涵蓋的完整房費"],
          ["night", "每間房每晚房費"],
          ["none", "訂金、平台撥款或其他金額"],
        ],
      ),
    );
  if (t.mapping.booked !== undefined)
    add(
      question(
        "booked",
        `「${t.headers[t.mapping.booked]}」是客人下訂日期嗎？`,
        "確認後才計算提前預訂天數。",
        [
          ["yes", "是，客人實際下訂日"],
          ["no", "不是，是登記或其他日期"],
        ],
      ),
    );
  return previous;
}
export function dateValue(v: string, mode: string | undefined): string | null {
  let y: number, m: number, d: number;
  let match = v.match(
    /^(\d{3,4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?(?:[ T]00:00(?::00)?)?$/,
  );
  if (match) {
    y = +match[1];
    if (y < 1911) y += 1911;
    m = +match[2];
    d = +match[3];
  } else {
    match = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!match || !["dmy", "mdy"].includes(mode || "")) return null;
    y = +match[3];
    m = +(mode === "dmy" ? match[2] : match[1]);
    d = +(mode === "dmy" ? match[1] : match[2]);
  }
  if (y < 2000 || y > 2100) return null;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    n = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(+n) && n.toISOString().slice(0, 10) === iso
    ? iso
    : null;
}
function amountValue(v: string): number | null {
  const cleaned = v
    .replace(/^(?:NT\$|TWD|NTD|新台幣)\s*/i, "")
    .replace(/^\$/, "")
    .replace(/,/g, "")
    .trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n <= 100000000 ? n : null;
}
export function analyze(
  job: Pick<Job, "id" | "sourceHash" | "sourceTitle" | "tables" | "answers" | "receptionKind">,
  now = new Date(),
): Report {
  const tables = selectedTables(job),
    a: Answers = job.answers;
  if (tables.length !== 1 || !["stay", "night", "multi", ...(job.receptionKind === "villa" ? ["split"] : [])].includes(a.unit))
    throw Error("HEALTH_UNIT");
  const t = tables[0];
  const reception = job.receptionKind ?? "rooms";
  if (reception === "mixed" && t.mapping.stayKind === undefined) throw Error("HEALTH_MIXED_KIND");
  if (a.unit === "split" && (t.mapping.orderId === undefined || t.mapping.room === undefined)) throw Error("HEALTH_VILLA_SPLIT");
  if (t.mapping.checkIn === undefined) throw Error("HEALTH_DATES");
  if (t.mapping.status === undefined && a.active !== "yes")
    throw Error("HEALTH_STATUS");
  const excluded: Report["excluded"] = [],
    limitations = new Set<string>();
  const uncertainDates = new Set<string>();
  const markUncertain = (start: string | null, end: string | null) => {
    if (!start || !end || end <= start || (Date.parse(end) - Date.parse(start)) / day > 366) return;
    for (let time = Date.parse(start); time < Date.parse(end); time += day) uncertainDates.add(new Date(time).toISOString().slice(0, 10));
  };
  let segments: {
    kind: StayKind;
    refs: string[];
    ref: string;
    id: string;
    start: string;
    end: string;
    room: string;
    count: number;
    money: number | null;
    channel: string;
    booked: string | null;
  }[] = [];
  const currencies = distinct(t, "currency").map((c) => c.toUpperCase());
  const moneyEnabled =
    ["total", "night"].includes(a.money) &&
    currencies.every((c) => ["TWD", "NTD", "新台幣", "台幣"].includes(c));
  if (!moneyEnabled) limitations.add("金額口徑或幣別未確認，暫不分析房費。");
  if (t.mapping.currency === undefined && moneyEnabled)
    limitations.add(
      "來源未提供幣別，金額以來源數值呈現；請確認為同一幣別，不進行匯率換算。",
    );
  let sourceNightCount = 0;
  for (const row of t.rows) {
    const ref = `${row.source ?? t.title}!${row.row}`,
      get = (f: Field) => value(t, row, f),
      reject = (reason: string) => {
        excluded.push({ ref, reason });
        if (reason === "取消或作廢" || reason === "非選定館別或館別未知") return;
        const start = dateValue(get("checkIn"), a.date);
        const length = a.unit === "night" ? 1 : Number(get("nights"));
        const end = dateValue(get("checkOut"), a.date) ?? (start && Number.isInteger(length) && length > 0 && length <= 366 ? new Date(Date.parse(start) + length * day).toISOString().slice(0, 10) : null);
        markUncertain(start, end);
      };
    if (
      t.mapping.property !== undefined &&
      (!a.property || a.property === "skip" || get("property") !== a.property)
    ) {
      reject("非選定館別或館別未知");
      continue;
    }
    if (t.mapping.status !== undefined) {
      const status = get("status").toLowerCase();
      if (
        ![
          "confirmed",
          "booked",
          "checkedin",
          "checkedout",
          "checked in",
          "checked out",
          "已確認",
          "確認",
          "成立",
          "已成立",
          "已入住",
          "已退房",
          "有效",
          "已訂",
          "完成",
        ].includes(status)
      ) {
        reject(/取消|作廢|cancel/.test(status) ? "取消或作廢" : "狀態無法確認");
        continue;
      }
    }
    const start = dateValue(get("checkIn"), a.date);
    if (!start) {
      reject("入住日期無法確認");
      continue;
    }
    const nights = get("nights") ? Number(get("nights")) : null;
    let end = get("checkOut") ? dateValue(get("checkOut"), a.date) : null;
    if (get("checkOut") && !end) {
      reject("退房日期無法確認");
      continue;
    }
    if (!end) {
      if (a.unit === "night")
        end = new Date(Date.parse(start) + day).toISOString().slice(0, 10);
      else if (
        nights &&
        Number.isInteger(nights) &&
        nights > 0 &&
        nights <= 366
      )
        end = new Date(Date.parse(start) + nights * day)
          .toISOString()
          .slice(0, 10);
    }
    const length = end ? (Date.parse(end) - Date.parse(start)) / day : 0;
    if (
      !end ||
      length <= 0 ||
      length > 366 ||
      (a.unit === "night" && length !== 1) ||
      (nights !== null && nights !== length)
    ) {
      reject("住宿晚數缺漏或日期互相衝突");
      continue;
    }
    const tagged = sourceStayKind(get("stayKind"));
    const kind = reception === "mixed" ? tagged : reception;
    if (!kind || (get("stayKind") && tagged !== kind)) {
      reject("接客形式不明或與旅宿設定不符"); continue;
    }
    const rawCount = get("roomCount"),
      count = kind === "villa" ? 1 : a.unit === "multi" ? Number(rawCount) : 1;
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 100 ||
      (kind !== "villa" && a.unit !== "multi" && rawCount && Number(rawCount) !== 1)
    ) {
      reject("房數不明或與列的定義不一致");
      continue;
    }
    const room = get("room");
    if (kind !== "villa" && /包棟|全棟|整棟|whole.?house|villa/i.test(room)) {
      reject("標示包棟但接客形式為散客，請核對");
      continue;
    }
    const booked = a.booked === "yes" ? dateValue(get("booked"), a.date) : null;
    sourceNightCount += length * count;
    if (sourceNightCount > 200000) throw Error("HEALTH_SIZE");
    segments.push({
      kind, refs: [ref],
      ref,
      id: get("orderId"),
      start,
      end,
      room: kind === "villa" && a.unit !== "split" ? "整棟" : room || "未提供房號／房型",
      count,
      money: moneyEnabled ? amountValue(get("amount")) : null,
      channel: get("channel") || "未分類",
      booked: booked && booked <= start ? booked : null,
    });
  }
  // Explicitly confirmed per-room prices can be summed into one whole-villa stay.
  // A shared order ID + identical stay/channel/booked metadata + distinct rooms are required.
  if (a.unit === "split") {
    const groups = new Map<string, typeof segments>();
    for (const s of segments) {
      if (!s.id) { markUncertain(s.start, s.end); excluded.push({ ref: s.ref, reason: "包棟拆房列缺少共同訂單編號，無法合併" }); continue; }
      const group = groups.get(s.id) ?? []; group.push(s); groups.set(s.id, group);
    }
    segments = [...groups.values()].flatMap((group) => {
      const first = group[0];
      if (group.some((s) => s.start !== first.start || s.end !== first.end || s.channel !== first.channel || s.booked !== first.booked || s.room === "未提供房號／房型") ||
          new Set(group.map((s) => s.room)).size !== group.length) {
        group.forEach((s) => { markUncertain(s.start, s.end); excluded.push({ ref: s.ref, reason: "包棟拆房列重複或日期／通路不一致，整組隔離" }); }); return [];
      }
      return [{ ...first, refs: group.flatMap((s) => s.refs), room: "整棟", count: 1,
        money: group.every((s) => s.money !== null) ? group.reduce((n, s) => n + s.money!, 0) : null }];
    });
  }
  // Repeated IDs may be modifications, split stays, or repeated totals. Quarantine the whole group.
  const ids = new Map<string, number>();
  segments.forEach((s) => {
    if (s.id) ids.set(s.id, (ids.get(s.id) || 0) + 1);
  });
  const signatures = new Map<string, number>();
  segments.forEach((s) => {
    const k = hash({ ...s, ref: undefined, refs: undefined, id: undefined });
    signatures.set(k, (signatures.get(k) || 0) + 1);
  });
  const conflictRefs = new Set<string>();
  const roomHeader =
    t.mapping.room === undefined
      ? ""
      : t.headers[t.mapping.room].toLowerCase().replace(/[ _-]/g, "");
  const occupied = new Map<number, typeof segments>();
  const physicalRooms = ["房號", "roomnumber"].includes(roomHeader);
  for (const s of segments) for (let time = Date.parse(s.start); time < Date.parse(s.end); time += day) {
    const list = occupied.get(time) ?? []; list.push(s); occupied.set(time, list);
  }
  for (const list of occupied.values()) {
    if (list.length > 1 && list.some((s) => s.kind === "villa"))
      list.forEach((s) => s.refs.forEach((ref) => conflictRefs.add(ref)));
    const roomGroups = new Map<string, typeof segments>();
    const nightlyIds = new Map<string, typeof segments>();
    for (const s of list) {
      if (physicalRooms && s.count === 1 && s.room !== "未提供房號／房型") {
        const group = roomGroups.get(s.room) ?? []; group.push(s); roomGroups.set(s.room, group);
      }
      if (a.unit === "night" && s.id) { const group = nightlyIds.get(s.id) ?? []; group.push(s); nightlyIds.set(s.id, group); }
    }
    for (const group of [...roomGroups.values(), ...nightlyIds.values()]) if (group.length > 1)
      group.forEach((s) => s.refs.forEach((ref) => conflictRefs.add(ref)));
  }
  const safe = segments.filter((s) => {
    if (s.id && (ids.get(s.id) || 0) > 1 && a.unit !== "night") {
      excluded.push({
        ref: s.ref,
        reason: "同一訂單編號有多列，需釐清改期或重複總價",
      });
      return false;
    }
    if (
      !s.id &&
      (signatures.get(hash({ ...s, ref: undefined, refs: undefined, id: undefined })) || 0) > 1
    ) {
      excluded.push({
        ref: s.ref,
        reason: "無訂單編號且明細完全相同，疑似重複",
      });
      return false;
    }
    if (conflictRefs.has(s.ref)) {
      s.refs.forEach((ref) => excluded.push({ ref, reason: reception === "rooms" ? "同一實體房號在同晚有重疊明細，整組隔離" : "同晚包棟與其他訂單重疊，整組隔離" }));
      return false;
    }
    return true;
  });
  const safeRefs = new Set(safe.map((s) => s.ref));
  segments.filter((s) => !safeRefs.has(s.ref)).forEach((s) => markUncertain(s.start, s.end));
  let expandedCount = 0;
  const expanded: Night[] = [];
  for (const s of safe) {
    const length = (Date.parse(s.end) - Date.parse(s.start)) / day;
    for (let i = 0; i < length; i++) {
      expandedCount += s.count;
      if (expandedCount > 200000) throw Error("HEALTH_SIZE");
      expanded.push({
        kind: s.kind,
        date: new Date(Date.parse(s.start) + i * day)
          .toISOString()
          .slice(0, 10),
        room: s.room,
        channel: s.channel,
        count: s.count,
        amount:
          s.money === null
            ? null
            : a.money === "night"
              ? s.money * s.count
              : s.money / length,
        booked: s.booked,
        refs: s.refs,
        allocated: a.money === "total" && length > 1,
      });
    }
  }
  if (!expanded.length) throw Error("HEALTH_EMPTY");
  const from = expanded.reduce(
      (v, n) => (n.date < v ? n.date : v),
      expanded[0].date,
    ),
    to = expanded.reduce((v, n) => (n.date > v ? n.date : v), from),
    nights = expanded.reduce((v, n) => v + n.count, 0),
    known = expanded.filter((n) => n.amount !== null),
    unknownAmountNights = expanded
      .filter((n) => n.amount === null)
      .reduce((v, n) => v + n.count, 0),
    positive = known.filter((n) => n.amount! > 0),
    sum = (ns: Night[]) => ns.reduce((v, n) => v + (n.amount ?? 0), 0),
    round = (n: number) => Math.round(n * 100) / 100;
  const total = known.length ? round(sum(known)) : null,
    adr = positive.length
      ? round(sum(positive) / positive.reduce((v, n) => v + n.count, 0))
      : null;
  const grouped = (field: "date" | "room" | "channel") => {
    const groups = new Map<string, Night[]>();
    for (const n of expanded) {
      const key = field === "date" ? n.date.slice(0, 7) : n[field];
      const existing = groups.get(key);
      if (existing) existing.push(n);
      else groups.set(key, [n]);
    }
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, ns]) => ({
        key,
        nights: ns.reduce((v, n) => v + n.count, 0),
        amount: ns.some((n) => n.amount !== null) ? round(sum(ns)) : null,
        ns,
      }));
  };
  const leads = expanded
    .filter((n) => n.booked)
    .flatMap(
      (n) =>
        Array(n.count).fill(
          (Date.parse(n.date) - Date.parse(n.booked!)) / day,
        ) as number[],
    )
    .sort((a, b) => a - b);
  // Lead time must refer to arrival, not the individual stay night.
  const leadByStay = safe
    .filter((s) => s.booked)
    .flatMap(
      (s) =>
        Array((s.count * (Date.parse(s.end) - Date.parse(s.start))) / day).fill(
          (Date.parse(s.start) - Date.parse(s.booked!)) / day,
        ) as number[],
    )
    .sort((a, b) => a - b);
  limitations.add("未核實每日可售庫存與停賣歷史，因此不顯示住房率與未來空檔。");
  limitations.add(
    "只分析所提供的有效明細，不代表期間完整；前期對照只比較本次可見紀錄，不能視為已核實的全店成長率。",
  );
  limitations.add(reception === "villa" ? "每棟每晚只計一次；整棟一次接待一組，不乘房間數。包棟拆房列僅在共同訂單編號、日期一致及房號不重複時合併。" : "房號／房型依來源分組，無法辨識房型內實體房間的重疊庫存。");
  if (reception === "mixed") limitations.add("包棟與散客分開計算晚數和平均價格；同一棟包棟與分房訂單重疊時隔離，未確認形式的列排除。");
  if (expanded.some((n) => n.allocated))
    limitations.add("跨晚房費平均分攤至入住日，月度與星期金額為分攤估算。");
  if (unknownAmountNights)
    limitations.add(
      `${unknownAmountNights} 房晚缺少可信金額；房費為已知部分加總。`,
    );
  limitations.add("零元房晚計入已訂房晚，平均房晚價格只使用金額大於零的房晚。");
  const refs = safe.flatMap((s) => s.refs),
    facts: Report["facts"] = [
      {
        id: "nights",
        label: "已訂房晚",
        value: nights,
        unit: "房晚",
        basis: "有效明細按入住日展開；退房日不計",
        refs,
      },
    ];
  if (total !== null)
    facts.push({
      id: "amount",
      label: "可分析房費",
      value: total,
      unit: "來源幣別",
      basis: "已知完整房費；不是實收或淨利",
      refs: [...new Set(known.flatMap((n) => n.refs))],
    });
  if (adr !== null)
    facts.push({
      id: "adr",
      label: "平均房晚價格",
      value: adr,
      unit: "來源幣別／房晚",
      basis: "正金額房費 ÷ 正金額房晚；不含零元及未知金額",
      refs: [...new Set(positive.flatMap((n) => n.refs))],
    });
  const channels = grouped("channel")
    .map(({ key, nights, amount }) => ({ channel: key, nights, amount }))
    .sort((a, b) => b.nights - a.nights);
  if (channels.length)
    facts.push({
      id: "top-channel",
      label: `${channels[0].channel} 房晚`,
      value: channels[0].nights,
      unit: "房晚",
      basis: "依入住日與來源通路分組",
      refs: [
        ...new Set(
          expanded
            .filter((n) => n.channel === channels[0].channel)
            .flatMap((n) => n.refs),
        ),
      ],
    });
  for (const [field, prefix] of [
    ["date", "month"],
    ["channel", "channel"],
  ] as const) {
    for (const g of grouped(field)) {
      const evidence = [...new Set(g.ns.flatMap((n) => n.refs))];
      facts.push({
        id: `${prefix}-${g.key}-nights`,
        label: `${g.key} 已訂房晚`,
        value: g.nights,
        unit: "房晚",
        basis: "依入住日計算；來源未保證期間完整",
        refs: evidence,
      });
      if (g.amount !== null)
        facts.push({
          id: `${prefix}-${g.key}-amount`,
          label: `${g.key} 已知房費`,
          value: g.amount,
          unit: "來源幣別",
          basis: "已知房費；跨晚總額均分屬估算，未提供金額的房晚不計",
          refs: [
            ...new Set(
              g.ns.filter((n) => n.amount !== null).flatMap((n) => n.refs),
            ),
          ],
        });
    }
  }
  return {
    id: job.id,
    receptionKind: reception,
    uncertainDates: [...uncertainDates].sort(),
    snapshot: hash({ version: 4, reception, source: job.sourceHash, answers: a }),
    createdAt: now.toISOString(),
    sourceTitle: job.sourceTitle,
    from,
    to,
    nights,
    amount: total,
    adr: reception === "mixed" ? null : adr,
    occupancy: null,
    inventory: null,
    monthly: grouped("date").map(({ key, nights, amount }) => ({
      month: key,
      nights,
      amount,
    })),
    channels,
    rooms: grouped("room").map(({ key, nights, amount, ns }) => ({
      room: key,
      nights,
      amount,
      weekdays: Array.from({ length: 7 }, (_, d) =>
        ns
          .filter((n) => new Date(n.date).getUTCDay() === d)
          .reduce((v, n) => v + n.count, 0),
      ),
    })),
    lead: {
      median: leadByStay.length
        ? (leadByStay[Math.floor((leadByStay.length - 1) / 2)] +
            leadByStay[Math.floor(leadByStay.length / 2)]) /
          2
        : null,
      knownNights: leads.length,
      totalNights: nights,
    },
    includedRows: refs.length,
    excluded,
    unknownAmountNights,
    analysis: { ...buildAnalysis(expanded, safe, a, excluded, taipeiDate(now), reception), momentumVersion: 1, cohorts: buildBookingCohorts(safe, a, taipeiDate(now)) },
    limitations: [...limitations].map((s) => analysisCopy(s, reception)),
    facts: (reception === "mixed" ? facts.filter((f) => f.id === "amount" || f.id.endsWith("-amount")) : facts).map((f) => ({ ...f, label: analysisCopy(f.label, reception), unit: analysisCopy(f.unit, reception), basis: analysisCopy(f.basis, reception) })),
    insights: reception === "mixed" ? [{ title: "兩種接客形式分開查看", body: "包棟晚數與散客房晚使用不同單位，請分別查看表現。", factIds: [] }] : [
      {
        title: "有效明細已整理",
        body: analysisCopy(`已納入 ${refs.length} 列，共 ${nights} 房晚。先檢查排除清單，再決定是否補齊資料。`, reception),
        factIds: ["nights"],
      },
      ...(channels.length
        ? [
            {
              title: "主要接單來源",
              body: analysisCopy(`${channels[0].channel} 目前有 ${channels[0].nights} 房晚。可接著檢查各通路的金額覆蓋與房晚分布。`, reception),
              factIds: ["top-channel"],
            },
          ]
        : []),
    ],
  };
}
