import { analysisCopy, type ReceptionKind, type StayKind } from "../hospitality-mode.ts";
import type { Analysis, AnalysisCell, Answers, Fact, Night, Report } from "./types.ts";

const DAY = 86400000;
export const round = (n: number) => Math.round(n * 100) / 100;
export const formatNumber = (n: number | null) => n === null ? "—" : n.toLocaleString("zh-TW", { maximumFractionDigits: 1 });
export const taipeiDate = (now = new Date()) => new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
export const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
export const validDate = (s: unknown): s is string => typeof s === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
export type Period = { from: string; to: string };
export type ViewFilter = Period & { kind?: StayKind; channel?: string; room?: string };
export const PRESETS = [
  ["last30", "近 30 天"], ["last7", "近 7 天"], ["thisMonth", "本月至今"],
  ["lastMonth", "上個月"], ["next30", "未來 30 天"], ["all", "全部資料"],
] as const;
export function presetPeriod(key: string, report: Report, today = taipeiDate()): Period {
  if (key === "all") return { from: report.from, to: report.to };
  if (key === "next30") return { from: today, to: shiftDate(today, 29) };
  if (key === "nextMonth") {
    const from = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 0)).toISOString().slice(0, 10);
    return { from, to };
  }
  if (key === "thisMonth") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (key === "lastMonth") {
    const to = shiftDate(`${today.slice(0, 7)}-01`, -1);
    return { from: `${to.slice(0, 7)}-01`, to };
  }
  return { from: shiftDate(today, key === "last7" ? -7 : -30), to: shiftDate(today, -1) };
}
export function checkedFilter(value: unknown, report: Report): ViewFilter {
  const fallback = presetPeriod("last30", report);
  if (!value || typeof value !== "object") value = fallback;
  const input = value as Partial<ViewFilter>;
  if (!validDate(input.from) || !validDate(input.to) || input.from > input.to || daysBetween(input.from, input.to) > 3660)
    throw Error("INVALID_INPUT");
  if (input.channel && !report.channels.some((c) => c.channel === input.channel)) throw Error("INVALID_INPUT");
  if (input.room && !report.rooms.some((r) => r.room === input.room)) throw Error("INVALID_INPUT");
  if (report.analysis && !report.analysis.dimensions && (input.channel || input.room)) throw Error("HEALTH_DIMENSIONS");
  if (input.kind && input.kind !== "villa" && input.kind !== "rooms") throw Error("INVALID_INPUT");
  const kind = report.receptionKind === "mixed" ? input.kind ?? (report.analysis?.cells.some((c) => c.kind === "villa") ? "villa" : "rooms") : report.receptionKind === "villa" ? "villa" : "rooms";
  if (report.receptionKind !== "mixed" && input.kind && input.kind !== kind) throw Error("INVALID_INPUT");
  return { kind, from: input.from, to: input.to, ...(input.channel ? { channel: input.channel } : {}), ...(input.room ? { room: input.room } : {}) };
}

type Stay = { kind?: StayKind; refs?: string[]; start: string; end: string; count: number; booked: string | null; room: string; channel: string; ref: string };
export function buildAnalysis(nights: Night[], stays: Stay[], answers: Answers, excluded: Report["excluded"], asOf = taipeiDate(), receptionKind: ReceptionKind = "rooms"): Analysis {
  // Keep report data aggregated. Source rows and guest fields are not persisted here.
  const detailedKeys = new Set(nights.map((n) => JSON.stringify([n.kind, n.date, n.channel, n.room])));
  const dimensions = detailedKeys.size <= 25000;
  const map = new Map<string, AnalysisCell>();
  const keyFor = (date: string, channel: string, room: string, kind?: StayKind) => JSON.stringify([kind, date, dimensions ? channel : "全部通路", dimensions ? room : "全部房間"]);
  for (const n of nights) {
    const key = keyFor(n.date, n.channel, n.room, n.kind);
    let cell = map.get(key);
    if (!cell) {
      cell = { kind: n.kind, date: n.date, channel: dimensions ? n.channel : "全部通路", room: dimensions ? n.room : "全部房間",
        nights: 0, amount: 0, knownNights: 0, pricedNights: 0, arrivals: 0, stayNights: 0, leadTotal: 0, leadCount: 0,
        los: [0, 0, 0, 0], lead: [0, 0, 0, 0, 0], refs: [] };
      map.set(key, cell);
    }
    cell.nights += n.count;
    if (n.amount !== null) { cell.amount += n.amount; cell.knownNights += n.count; }
    if (n.amount !== null && n.amount > 0) cell.pricedNights += n.count;
    cell.refs.push(...n.refs);
  }
  const booked = new Map<string, { kind?: StayKind; date: string; channel: string; room: string; nights: number; refs: string[] }>();
  for (const s of stays) {
    const length = daysBetween(s.start, s.end) - 1;
    const cell = map.get(keyFor(s.start, s.channel, s.room, s.kind));
    if (cell && answers.unit !== "night") {
      cell.arrivals += s.count;
      cell.stayNights += length * s.count;
      cell.los[length === 1 ? 0 : length === 2 ? 1 : length <= 4 ? 2 : 3] += s.count;
      if (s.booked && s.booked <= asOf) {
        const lead = daysBetween(s.booked, s.start) - 1;
        cell.leadTotal += lead * s.count;
        cell.leadCount += s.count;
        cell.lead[lead <= 2 ? 0 : lead <= 7 ? 1 : lead <= 30 ? 2 : lead <= 60 ? 3 : 4] += s.count;
      }
    }
    if (s.booked) {
      const key = keyFor(s.booked, s.channel, s.room, s.kind);
      const entry = booked.get(key) ?? { kind: s.kind, date: s.booked, channel: dimensions ? s.channel : "全部通路", room: dimensions ? s.room : "全部房間", nights: 0, refs: [] };
      entry.nights += length * s.count;
      entry.refs.push(...(s.refs ?? [s.ref]));
      booked.set(key, entry);
    }
  }
  return {
    version: 2, receptionKind, asOf, unit: answers.unit, dimensions,
    cells: [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).map((c) => ({ ...c, refs: [...new Set(c.refs)] })),
    bookingDates: [...booked.values()].sort((a, b) => a.date.localeCompare(b.date)).map((b) => ({ ...b, refs: [...new Set(b.refs)] })),
    quality: { included: stays.reduce((n, s) => n + (s.refs?.length ?? 1), 0), excluded: excluded.length,
      cancelled: excluded.filter((e) => /取消或作廢/.test(e.reason)).length,
      conflicts: excluded.filter((e) => /重疊|重複|改期/.test(e.reason)).length,
      unknownStatus: excluded.filter((e) => /狀態無法確認/.test(e.reason)).length },
  };
}
export function totalCells(cells: AnalysisCell[]) {
  const sum = (field: "nights" | "amount" | "knownNights" | "pricedNights" | "arrivals" | "stayNights" | "leadTotal" | "leadCount") => cells.reduce((n, c) => n + c[field], 0);
  const nights = sum("nights"), known = sum("knownNights"), paid = sum("pricedNights"), arrivals = sum("arrivals"), leadCount = sum("leadCount");
  return { nights, amount: known ? round(sum("amount")) : null, adr: paid ? round(sum("amount") / paid) : null,
    knownNights: known, pricedNights: paid, coverage: nights ? round(100 * known / nights) : null,
    arrivals, los: arrivals ? round(sum("stayNights") / arrivals) : null,
    lead: leadCount ? round(sum("leadTotal") / leadCount) : null, leadCount,
    refs: [...new Set(cells.flatMap((c) => c.refs))] };
}
export type Totals = ReturnType<typeof totalCells>;
export type Insight = { id: string; title: string; body: string; action: string; factIds: string[] };
export function analysisView(report: Report, filter: ViewFilter, today = taipeiDate()) {
  filter = checkedFilter(filter, report);
  const kind = filter.kind!;
  const copy = (text: string) => analysisCopy(text, kind);
  const analysis = report.analysis;
  const matches = (c: AnalysisCell) => (c.kind ?? "rooms") === kind && (!filter.channel || c.channel === filter.channel) && (!filter.room || c.room === filter.room);
  const scoped = (analysis?.cells ?? []).filter(matches);
  const cells = scoped.filter((c) => c.date >= filter.from && c.date <= filter.to);
  const countDays = daysBetween(filter.from, filter.to);
  const previousPeriod = { from: shiftDate(filter.from, -countDays), to: shiftDate(filter.from, -1) };
  const previousCells = scoped.filter((c) => c.date >= previousPeriod.from && c.date <= previousPeriod.to);
  const total = totalCells(cells), previous = totalCells(previousCells);
  const comparison = Boolean(analysis && previousPeriod.from >= report.from && filter.to <= report.to && filter.to < today &&
    previous.nights && total.nights);
  const delta = (current: number | null, before: number | null) => comparison && current !== null && before !== null && before > 0 ? round((current - before) / before * 100) : null;
  const aggregate = (field: "channel" | "room" | "date", rows = cells) => {
    const groups = new Map<string, AnalysisCell[]>();
    for (const c of rows) { const key = c[field]; const list = groups.get(key) ?? []; list.push(c); groups.set(key, list); }
    return [...groups].map(([name, values]) => ({ name, ...totalCells(values) })).sort((a, b) => b.nights - a.nights);
  };
  const channels = aggregate("channel"), rooms = aggregate("room");
  const weekdays = Array.from({ length: 7 }, (_, day) => {
    let occurrences = 0;
    for (let i = 0; i < countDays; i++) if (new Date(shiftDate(filter.from, i)).getUTCDay() === day) occurrences++;
    const t = totalCells(cells.filter((c) => new Date(c.date).getUTCDay() === day));
    return { day, occurrences, ...t, perDay: occurrences ? round(t.nights / occurrences) : 0 };
  });
  const distributions = (field: "los" | "lead", length: number) => Array.from({ length }, (_, i) => cells.reduce((n, c) => n + c[field][i], 0));
  const seriesGroups = new Map<string, AnalysisCell[]>();
  for (let i = 0; i < countDays; i++) {
    const date = shiftDate(filter.from, i), key = countDays > 62 ? date.slice(0, 7) : date;
    if (!seriesGroups.has(key)) seriesGroups.set(key, []);
  }
  for (const c of cells) seriesGroups.get(countDays > 62 ? c.date.slice(0, 7) : c.date)?.push(c);
  const series = [...seriesGroups].map(([date, list]) => ({ date, ...totalCells(list), observed: list.length > 0 }));
  const bookingRows = (analysis?.bookingDates ?? []).filter((b) => b.date >= shiftDate(today, -7) && b.date < today &&
    (b.kind ?? "rooms") === kind && (!filter.channel || b.channel === filter.channel) && (!filter.room || b.room === filter.room));
  const bookingNights = bookingRows.reduce((n, b) => n + b.nights, 0);
  const futureCells = scoped.filter((c) => c.date >= today && c.date <= shiftDate(today, 29));
  const future = totalCells(futureCells);
  const facts: Fact[] = [];
  const evidence = (id: string, label: string, value: number | null, unit: string, basis: string, refs = total.refs) => {
    if (value !== null) facts.push({ id, label: copy(label), value, unit: copy(unit), basis: copy(basis), refs });
  };
  const basis = `${filter.from}～${filter.to}，本次匯入的有效住宿紀錄${filter.channel ? `，通路 ${filter.channel}` : ""}${filter.room ? `，房間 ${filter.room}` : ""}；退房日不計`;
  evidence("view-nights", "期間已訂房晚", total.nights, "房晚", basis);
  evidence("view-amount", "期間已知房費", total.amount, "來源幣別", `${basis}；不是實收或淨利，跨晚總價平均分攤`);
  evidence("view-adr", "期間平均房晚價格", total.adr, "來源幣別／房晚", `${basis}；只計正金額房晚，稅費口徑依來源`);
  evidence("view-coverage", "房費資料覆蓋", total.coverage, "%", "已知金額房晚 ÷ 期間房晚（含零元）");
  if (kind === "villa" && analysis?.unit !== "night") evidence("view-arrivals", "期間入住組數", total.arrivals, "組", `${basis}；按實際入住日計算，每筆包棟住宿一組`);
  evidence("view-los", "平均住幾晚", total.los, "晚／房次", `${basis}；按期間入住的房次加權，整次住宿長度不裁切`);
  evidence("view-lead", "平均提前預訂", total.lead, "天", `${basis}；期間入住且有可信下訂日的房次加權`);
  if (comparison) {
    evidence("previous-nights", "前期已訂房晚", previous.nights, "房晚", `${previousPeriod.from}～${previousPeriod.to}；同份資料中可見的有效紀錄`, previous.refs);
    evidence("previous-amount", "前期已知房費", previous.amount, "來源幣別", `${previousPeriod.from}～${previousPeriod.to}；不保證前後期資料完整或同一金額覆蓋率`, previous.refs);
    evidence("change-nights", "房晚紀錄變化", delta(total.nights, previous.nights), "%", "（本期房晚－前期房晚）÷ 前期房晚；非已核實的全店成長率", [...new Set([...total.refs, ...previous.refs])]);
  }
  for (const [kind, groups] of [["channel", channels], ["room", rooms]] as const) groups.forEach((g, i) => {
    evidence(`${kind}-${i}-nights`, `${g.name} 已訂房晚`, g.nights, "房晚", basis, g.refs);
    evidence(`${kind}-${i}-amount`, `${g.name} 已知房費`, g.amount, "來源幣別", `${basis}；未扣佣金及成本`, g.refs);
    evidence(`${kind}-${i}-adr`, `${g.name} 平均房晚價格`, g.adr, "來源幣別／房晚", `${basis}；只計正金額房晚`, g.refs);
  });
  evidence("future-nights", "未來 30 天已訂房晚", future.nights, "房晚", `${today}～${shiftDate(today, 29)}；截至 ${report.createdAt} 這份快照已存在的訂房，非預測`, future.refs);
  if (analysis?.bookingDates.length)
    evidence("booking-seven", "近 7 天建立且目前有效的房晚", bookingNights, "房晚", `${shiftDate(today, -7)}～${shiftDate(today, -1)} 的下訂日期；非淨新增訂房（Pickup），未含後來取消的訂單`, [...new Set(bookingRows.flatMap((b) => b.refs))]);
  const insights: Insight[] = [];
  if (total.nights) {
    const change = delta(total.nights, previous.nights);
    insights.push({ id: "performance", title: change === null ? "這段期間的訂房" : change > 0 ? "房晚紀錄比前期增加" : change < 0 ? "房晚紀錄比前期減少" : "房晚紀錄與前期持平",
      body: `這段期間有 ${formatNumber(total.nights)} 房晚${total.amount !== null ? `、已知房費 ${formatNumber(total.amount)}` : ""}。${change === null ? "目前沒有可直接比較的完整前期範圍。" : `前期 ${formatNumber(previous.nights)} 房晚，紀錄${change >= 0 ? "增加" : "減少"} ${formatNumber(Math.abs(change))}%。`}`,
      action: change !== null && change < 0 ? "先看減少集中在哪個通路與星期，再決定要補哪一段需求。" : "先看主要通路及平假日分布，找出值得維持或加強的來源。",
      factIds: ["view-nights", "view-amount", "previous-nights", "change-nights"].filter((id) => facts.some((f) => f.id === id)) });
    if (channels.length && analysis?.dimensions) {
      const top = channels[0], share = round(top.nights / total.nights * 100);
      evidence("channel-top-share", `${top.name} 房晚占比`, share, "%", `${basis}；該通路房晚 ÷ 期間房晚`, top.refs);
      insights.push({ id: "channel", title: share >= 60 ? "訂房集中在單一來源" : "主要訂房來源",
        body: `${top.name} 帶來 ${formatNumber(top.nights)} 房晚，占 ${formatNumber(share)}%。`,
        action: share >= 60 ? "先比對這個通路的抽佣和取消情況，再評估是否增加其他來源。" : "比較各通路的平均房价與房費覆蓋；佣金補齊後，再看淨收益。",
        factIds: ["channel-0-nights", "channel-top-share"] });
    }
    if (total.coverage !== null && total.coverage < 100)
      insights.push({ id: "quality", title: "部分住宿缺少金額", body: `${formatNumber(total.nights - total.knownNights)} 房晚沒有可信金額，現在的房費只代表已知部分。`,
        action: "先補齐這些住宿的完整房費，再評估整體營收。", factIds: ["view-nights", "view-coverage"] });
    else if (total.lead !== null)
      insights.push({ id: "booking", title: "客人通常提前多久訂", body: `這段期間入住的可判讀房次，平均提前 ${formatNumber(total.lead)} 天預訂。`,
        action: "把促銷和剩房檢查安排在這個時間點之前；短期少單時先對照自己的預訂習慣。", factIds: ["view-lead"] });
    else if (total.los !== null)
      insights.push({ id: "los", title: "客人平均住幾晚", body: `這段期間入住的房次，平均住宿 ${formatNumber(total.los)} 晚。`,
        action: "檢查最短入住限制是否貼近客人常見住法，再評估連住方案。", factIds: ["view-los"] });
  } else insights.push({ id: "empty", title: "這段期間沒有可見紀錄", body: `本次資料在 ${filter.from}～${filter.to} 沒有符合篩選的有效住宿。`,
    action: `可先切換「全部資料」；原始報告有紀錄的日期為 ${report.from}～${report.to}。`, factIds: ["view-nights"] });
  const futureCalendar = kind === "villa" ? Array.from({ length: 30 }, (_, i) => {
    const date = shiftDate(today, i);
    const conflict = report.uncertainDates?.includes(date);
    const records = analysis?.cells.filter((c) => c.date === date) ?? [];
    const state = conflict ? "review" : records.some((c) => c.kind === "villa") ? "booked" : records.some((c) => (c.kind ?? "rooms") === "rooms") ? "rooms" : "unknown";
    return { date, state, weekend: [5, 6].includes(new Date(date).getUTCDay()) };
  }) : [];
  const singleNightGaps = futureCalendar.filter((d, i, rows) => d.state === "unknown" && i > 0 && i < rows.length - 1 &&
    ["booked", "rooms"].includes(rows[i - 1].state) && ["booked", "rooms"].includes(rows[i + 1].state)).map((d) => d.date);
  return { kind, futureCalendar, singleNightGaps, filter, total, previous, previousPeriod, comparison, change: { nights: delta(total.nights, previous.nights), amount: delta(total.amount, previous.amount), adr: delta(total.adr, previous.adr) },
    channels, rooms, weekdays, series, los: distributions("los", 4), lead: distributions("lead", 5),
    bookingNights, future, facts, insights: insights.map((i) => ({ ...i, title: copy(i.title), body: copy(i.body), action: copy(i.action) })), futurePeriod: { from: today, to: shiftDate(today, 29) },
    warning: "只比較本次匯入的紀錄，尚未核實期間完整性；未見紀錄不等於沒有訂房。" };
}
export type AnalysisView = ReturnType<typeof analysisView>;
