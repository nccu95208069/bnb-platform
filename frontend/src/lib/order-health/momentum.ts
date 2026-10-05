import type { StayKind } from "../hospitality-mode.ts";
import type { Answers, BookingCohort, Report } from "./types.ts";
import { daysBetween, formatNumber as n, round, shiftDate, totalCells, type Period } from "./analytics.ts";

export type BookingSegment = {
  id: string; kind: StayKind; start: string; end: string; count: number;
  money: number | null; booked: string | null; channel: string; refs: string[];
};

// Private IDs are used only while grouping. Reports retain anonymous cohorts and
// source references, never the original booking ID or any guest information.
export function buildBookingCohorts(segments: BookingSegment[], answers: Answers, asOf: string): BookingCohort[] {
  const groups = new Map<string, BookingSegment[]>();
  segments.forEach((s, index) => {
    const key = s.id ? `id:${s.id}` : `row:${index}`;
    const group = groups.get(key) ?? [];
    group.push(s); groups.set(key, group);
  });
  const records: BookingCohort[] = [];
  const append = (group: BookingSegment[], identityKnown: boolean) => {
    const first = group[0];
    const spans = group.map((s) => ({ from: s.start, to: s.end })).sort((a, b) => a.from.localeCompare(b.from));
    const stays: Period[] = [];
    for (const span of spans) {
      const last = stays.at(-1);
      if (last && span.from <= last.to) { if (span.to > last.to) last.to = span.to; }
      else stays.push({ ...span });
    }
    let nights = 0, amount = 0, knownNights = 0, pricedNights = 0;
    for (const s of group) {
      const length = daysBetween(s.start, s.end) - 1;
      const units = length * s.count;
      nights += units;
      if (s.money !== null) {
        const price = answers.money === "night" ? s.money * units : s.money;
        amount += price; knownNights += units;
        if (price > 0) pricedNights += units;
      }
    }
    const fullStay = answers.unit !== "night" && identityKnown;
    const fullPrice = fullStay && knownNights === nights;
    records.push({
      kind: first.kind, channel: first.channel,
      booked: first.booked && first.booked <= asOf ? first.booked : null,
      stays, nightSpans: group.map((s) => ({ from: s.start, to: s.end, count: s.count })), orders: identityKnown ? 1 : null, nights, amount,
      knownNights, pricedNights,
      fullPriceOrders: fullPrice ? 1 : 0, fullPriceAmount: fullPrice ? amount : 0,
      fullStayOrders: fullStay ? 1 : 0,
      fullStayNights: fullStay ? stays.reduce((sum, span) => sum + daysBetween(span.from, span.to) - 1, 0) : 0,
      refs: group.flatMap((s) => s.refs),
    });
  };
  for (const group of groups.values()) {
    const first = group[0];
    const consistent = group.every((s) => s.kind === first.kind && s.channel === first.channel && s.booked === first.booked);
    if (!consistent) { group.forEach((s) => append([s], false)); continue; }
    const identityKnown = Boolean(first.id) || (answers.unit !== "night" && (first.kind === "villa" || answers.unit === "multi"));
    append(group, identityKnown);
  }
  const cohorts = new Map<string, BookingCohort>();
  for (const record of records) {
    const key = JSON.stringify([record.kind, record.channel, record.booked, record.stays, record.nightSpans, record.orders !== null, record.fullStayOrders > 0, record.fullPriceOrders > 0]);
    const prior = cohorts.get(key);
    if (!prior) { cohorts.set(key, { ...record, nightSpans: record.nightSpans.map((s) => ({ ...s })) }); continue; }
    if (prior.orders !== null && record.orders !== null) prior.orders += record.orders;
    for (const field of ["nights", "amount", "knownNights", "pricedNights", "fullPriceOrders", "fullPriceAmount", "fullStayOrders", "fullStayNights"] as const)
      prior[field] += record[field];
    prior.nightSpans.forEach((span, index) => { span.count += record.nightSpans[index].count; });
    prior.refs.push(...record.refs);
  }
  return [...cohorts.values()].map((c) => ({ ...c, amount: round(c.amount), fullPriceAmount: round(c.fullPriceAmount), refs: [...new Set(c.refs)] }));
}

export type MomentumScope = { kind: StayKind; channel?: string };
export const percentChange = (current: number | null, previous: number | null) =>
  current !== null && previous !== null && previous > 0 ? round((current - previous) / previous * 100) : null;
export const monthPeriod = (month: string): Period => ({
  from: `${month}-01`,
  to: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10),
});
export const shiftMonth = (month: string, offset: number) => {
  const year = Number(month.slice(0, 4)), index = Number(month.slice(5, 7)) - 1;
  return new Date(Date.UTC(year, index + offset, 1)).toISOString().slice(0, 7);
};
export const previousYearMonth = (month: string) => `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;
const inRange = (date: string | null, p: Period): boolean => Boolean(date && date >= p.from && date <= p.to);
export const overlaps = (c: BookingCohort, p: Period) => c.stays.some((s) => s.from <= p.to && s.to > p.from);
const scopedCohorts = (report: Report, scope: MomentumScope) => (report.analysis?.cohorts ?? [])
  .filter((c) => c.kind === scope.kind && (!scope.channel || c.channel === scope.channel));
const scopedCells = (report: Report, scope: MomentumScope) => (report.analysis?.cells ?? [])
  .filter((c) => (c.kind ?? "rooms") === scope.kind && (!scope.channel || c.channel === scope.channel));

export function cohortSummary(rows: BookingCohort[]) {
  const sum = (field: "nights" | "amount" | "knownNights" | "pricedNights" | "fullPriceOrders" | "fullPriceAmount" | "fullStayOrders" | "fullStayNights") => rows.reduce((n, r) => n + r[field], 0);
  const nights = sum("nights"), knownNights = sum("knownNights"), pricedNights = sum("pricedNights");
  const knownOrders = rows.reduce((n, r) => n + (r.orders ?? 0), 0);
  const unidentifiedRows = rows.filter((r) => r.orders === null).reduce((n, r) => n + r.refs.length, 0);
  const fullPriceOrders = sum("fullPriceOrders"), fullStayOrders = sum("fullStayOrders");
  return {
    orders: unidentifiedRows ? null : knownOrders, knownOrders, unidentifiedRows, nights,
    amount: knownNights ? round(sum("amount")) : null,
    adr: pricedNights ? round(sum("amount") / pricedNights) : null,
    ticket: fullPriceOrders ? round(sum("fullPriceAmount") / fullPriceOrders) : null,
    los: fullStayOrders ? round(sum("fullStayNights") / fullStayOrders) : null,
    coverage: nights ? round(knownNights / nights * 100) : null,
    knownNights, pricedNights, fullPriceOrders,
    refs: [...new Set(rows.flatMap((r) => r.refs))],
  };
}
export type CohortSummary = ReturnType<typeof cohortSummary>;
export type Attention = { id: string; tone: "watch" | "positive" | "neutral"; title: string; detail: string; action: string; channel?: string };
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null;
};

export function momentumView(report: Report, scope: MomentumScope) {
  const asOf = report.analysis?.asOf ?? report.createdAt.slice(0, 10);
  const rows = scopedCohorts(report, scope);
  const dated = rows.filter((c) => c.booked && c.booked <= asOf);
  const all = cohortSummary(rows), datedTotal = cohortSummary(dated);
  const dateCoverage = all.nights ? round(datedTotal.nights / all.nights * 100) : null;
  const available = Boolean(report.analysis?.cohorts && dated.length);
  const dates = dated.map((r) => r.booked!).sort();
  const firstBooking = dates[0] ?? null;
  const range = (from: number, to: number): Period => ({ from: shiftDate(asOf, from), to: shiftDate(asOf, to) });
  const summary = (p: Period) => cohortSummary(dated.filter((c) => inRange(c.booked, p)));
  const recentPeriod = range(-7, -1), previousPeriod = range(-14, -8);
  const recent = summary(recentPeriod), previous = summary(previousPeriod);
  const today = summary(range(0, 0)), yesterday = summary(range(-1, -1));
  const comparison = available && Boolean(firstBooking && firstBooking <= previousPeriod.from);
  const countable = dated.length > 0 && dated.every((c) => c.orders !== null);
  const measure: "orders" | "nights" = countable ? "orders" : "nights";
  const measureLabel = countable ? "筆訂單" : scope.kind === "villa" ? "包棟晚數" : "房晚";
  const change = comparison ? percentChange(recent[measure], previous[measure]) : null;
  const amountChange = comparison && recent.coverage === 100 && previous.coverage === 100 ? percentChange(recent.amount, previous.amount) : null;
  const priceChange = comparison ? percentChange(recent.adr, previous.adr) : null;
  const daily = Array.from({ length: 30 }, (_, i) => {
    const date = shiftDate(asOf, i - 30);
    return { date, ...summary({ from: date, to: date }) };
  });
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const period = range(-(8 - i) * 7, -(7 - i) * 7 - 1);
    return { ...period, ...summary(period) };
  });
  const baselineWeeks = weeks.slice(-5, -1);
  const baselineReady = available && dateCoverage === 100 && Boolean(firstBooking && firstBooking <= baselineWeeks[0].from) &&
    baselineWeeks.filter((w) => (w[measure] ?? 0) > 0).length >= 3;
  const baseline = baselineReady ? median(baselineWeeks.map((w) => w[measure] ?? 0)) : null;
  const baselineChange = percentChange(recent[measure], baseline);
  const sample = recent.knownOrders + previous.knownOrders;
  const smallSample = !countable || sample < 10;
  let headline = "先補下訂日期，才能看接單動能";
  let detail = "目前能看住宿表現；補上實際下訂日期並在資料確認時選「是」，就能分析最近接單速度。";
  let tone: Attention["tone"] = "neutral";
  if (available) {
    if (change !== null) {
      headline = Math.abs(change) <= 5 ? "近 7 天接單大致持平" : change < 0 ? "近 7 天接單放緩" : "近 7 天接單增加";
      headline += `（${change > 0 ? "+" : ""}${n(change)}%）`;
      tone = smallSample ? "neutral" : change < -5 ? "watch" : change > 5 ? "positive" : "neutral";
      detail = `近 7 天可見 ${n(recent[measure])} ${measureLabel}，前 7 天 ${n(previous[measure])} ${measureLabel}。${smallSample ? "筆數少或尚未完整識別訂單，先看方向，不直接判定整體生意好壞。" : "以下拆開看接單量、價格與通路。"}`;
    } else {
      headline = `近 7 天可見 ${n(recent[measure])} ${measureLabel}`;
      detail = "目前缺少可比較的前 7 天紀錄，先呈現已有接單；不將前期資料缺漏當成成長。";
    }
  }
  const channels = [...new Set(rows.map((r) => r.channel))].map((channel) => {
    const current = cohortSummary(dated.filter((c) => c.channel === channel && inRange(c.booked, recentPeriod)));
    const prior = cohortSummary(dated.filter((c) => c.channel === channel && inRange(c.booked, previousPeriod)));
    const share = recent.nights ? round(current.nights / recent.nights * 100) : null;
    const countChange = comparison ? percentChange(current[measure], prior[measure]) : null;
    const adrChange = comparison ? percentChange(current.adr, prior.adr) : null;
    let attention = "持續觀察", reason = "先累積更多同口徑資料。";
    let tone: Attention["tone"] = "neutral";
    if (comparison && prior.nights > 0 && current.nights === 0) {
      attention = "近期未見新單"; reason = "前 7 天有接單，近 7 天未見；先核對上架、房態與來源更新。"; tone = "watch";
    } else if (countChange !== null && countChange <= -20 && prior.knownOrders >= 3) {
      attention = "接單減少"; reason = `同口徑接單減少 ${n(Math.abs(countChange))}%；核對曝光、可售日期與價格。`; tone = "watch";
    } else if (adrChange !== null && adrChange <= -10 && current.pricedNights >= 3 && prior.pricedNights >= 3) {
      attention = "新單價格下降"; reason = `新單每晚均價下降 ${n(Math.abs(adrChange))}%；先確認平假日及方案組合是否不同。`; tone = "watch";
    } else if (share !== null && share >= 60 && recent.knownOrders >= 5) {
      attention = "來源集中"; reason = `占近 7 天新增住宿單位晚數的 ${n(share)}%；可檢查是否過度依賴單一來源。`; tone = "watch";
    } else if (countChange !== null && countChange > 20 && current.knownOrders >= 3) {
      attention = "接單增加"; reason = `接單增加 ${n(countChange)}%；同時確認價格是否維持。`; tone = "positive";
    }
    return { channel, current, prior, share, change: countChange, priceChange: adrChange, attention, reason, tone };
  }).sort((a, b) => (b.current.amount ?? 0) - (a.current.amount ?? 0) || b.current.nights - a.current.nights);
  const futurePeriod = range(0, 29);
  const futureRows = rows.filter((c) => overlaps(c, futurePeriod));
  const futureOrders = cohortSummary(futureRows);
  const future = totalCells(scopedCells(report, scope).filter((c) => inRange(c.date, futurePeriod)));
  const priceByStayDay = [false, true].map((weekend) => {
    const pick = (period: Period) => cohortSummary(dated.filter((c) => inRange(c.booked, period) && c.fullStayOrders > 0 &&
      [5, 6].includes(new Date(c.stays[0].from).getUTCDay()) === weekend));
    return { label: weekend ? "週五／六開始住宿" : "其他日開始住宿", recent: pick(recentPeriod), previous: pick(previousPeriod) };
  });
  const actions: Attention[] = [];
  if (baselineChange !== null && baselineChange < -20 && !smallSample)
    actions.push({ id: "pace", tone: "watch", title: "接單速度低於近期常態", detail: `近 7 天為 ${n(recent[measure])} ${measureLabel}，前 4 週每週中位數 ${n(baseline)}；相差 ${n(Math.abs(baselineChange))}%。`, action: "先找出放緩通路，再核對未來可售日期；不要只因單週變化就全面降價。" });
  const watch = channels.find((c) => c.tone === "watch");
  if (watch) actions.push({ id: "channel", tone: "watch", title: `${watch.channel}：${watch.attention}`, detail: watch.reason, action: "展開通路明細，對照新單數量與成交價格。", channel: watch.channel });
  if (priceChange !== null && priceChange <= -10 && recent.pricedNights >= 3 && previous.pricedNights >= 3)
    actions.push({ id: "price", tone: "watch", title: "近期新單價格值得核對", detail: `平均每晚價格 ${n(recent.adr)}，前 7 天 ${n(previous.adr)}。`, action: "先拆平假日、房型／包棟方案與通路組合，再決定是否調整折扣。" });
  if (!available || dateCoverage !== 100)
    actions.push({ id: "dates", tone: "neutral", title: "補齊下訂日期", detail: `${dateCoverage === null ? "尚無" : `${n(dateCoverage)}% 的住宿晚數有`}可確認的下訂日期，近期接單仍可能少算。`, action: "確認欄位是實際下訂日，補齊後重新更新資料。" });
  if (all.unidentifiedRows)
    actions.push({ id: "identity", tone: "neutral", title: "部分訂單無法完整計數", detail: `${all.unidentifiedRows} 列缺少可確認的訂單識別，未直接當成訂單筆數。`, action: "補上穩定訂單編號；同一訂單的拆列使用相同編號。" });
  if (!actions.length) actions.push({ id: "maintain", tone: "positive", title: "持續追蹤接單量與價格", detail: available ? "目前未觸發明顯的量價下降提醒。" : "目前可先查看每月住宿表現。", action: "每次更新後，先看近 7 天量價，再看接下來月份的累積訂房。" });
  return { asOf, available, rows, all, dateCoverage, countable, measure, measureLabel, recentPeriod, previousPeriod,
    today, yesterday, recent, previous, comparison, change, amountChange, priceChange, daily, weeks,
    baseline, baselineChange, smallSample, headline, detail, tone, channels, future, futureOrders, futurePeriod,
    priceByStayDay, actions: actions.slice(0, 4) };
}
export type MomentumView = ReturnType<typeof momentumView>;

export function monthlyView(report: Report, scope: MomentumScope, month: string, basis: "stay" | "booked") {
  const period = monthPeriod(month), rows = scopedCohorts(report, scope);
  const asOf = report.analysis?.asOf ?? report.createdAt.slice(0, 10);
  const future = basis === "booked" && period.from > asOf;
  const selected = rows.filter((c) => basis === "booked" ? inRange(c.booked, period) : overlaps(c, period));
  const bookings = cohortSummary(selected);
  const cells = scopedCells(report, scope).filter((c) => inRange(c.date, period));
  const stay = totalCells(cells);
  const datedNights = selected.filter((c) => c.booked).reduce((n, c) => n + c.nights, 0);
  const totalNights = selected.reduce((n, c) => n + c.nights, 0);
  const dateCoverage = totalNights ? round(datedNights / totalNights * 100) : null;
  const daily = Array.from({ length: daysBetween(period.from, period.to) }, (_, i) => {
    const date = shiftDate(period.from, i);
    if (basis === "booked" && date > asOf) return { date, orders: null, nights: null, amount: null, adr: null, future: true };
    const booking = cohortSummary(selected.filter((c) => c.booked === date));
    const day = totalCells(cells.filter((c) => c.date === date));
    return { date, future: false, orders: basis === "booked" ? booking.orders : null,
      nights: basis === "booked" ? booking.nights : day.nights,
      amount: basis === "booked" ? booking.amount : day.amount,
      adr: basis === "booked" ? booking.adr : day.adr };
  });
  return { month, period, basis, future, ...bookings, orders: !report.analysis?.cohorts || future ? null : bookings.orders, amount: basis === "stay" ? stay.amount : bookings.amount,
    nights: basis === "stay" ? stay.nights : bookings.nights,
    adr: basis === "stay" ? stay.adr : bookings.adr, coverage: basis === "stay" ? stay.coverage : bookings.coverage,
    refs: basis === "stay" ? stay.refs : bookings.refs,
    dateCoverage, observed: selected.length > 0 || (basis === "stay" && cells.length > 0), daily };
}
export type MonthlyView = ReturnType<typeof monthlyView>;

function nightsWithin(c: BookingCohort, period: Period) {
  return c.nightSpans.reduce((n, s) => {
    const from = s.from > period.from ? s.from : period.from;
    const end = s.to < shiftDate(period.to, 1) ? s.to : shiftDate(period.to, 1);
    return n + Math.max(0, daysBetween(from, end) - 1) * s.count;
  }, 0);
}
// Reconstruction from surviving current records, NOT a historical snapshot or
// net pickup. No missing booking dates are imputed.
export function pacingView(report: Report, scope: MomentumScope, month: string) {
  const asOf = report.analysis?.asOf ?? report.createdAt.slice(0, 10);
  const period = monthPeriod(month), priorPeriod = monthPeriod(previousYearMonth(month));
  const rows = scopedCohorts(report, scope);
  const current = rows.filter((c) => overlaps(c, period)), prior = rows.filter((c) => overlaps(c, priorPeriod));
  const offset = daysBetween(period.from, asOf) - 1;
  const cutoff = asOf < period.to ? asOf : period.to;
  const priorCutoff = shiftDate(priorPeriod.from, Math.min(offset, daysBetween(priorPeriod.from, priorPeriod.to) - 1));
  const at = (items: BookingCohort[], target: Period, date: string) => {
    const chosen = items.filter((c) => c.booked && c.booked <= date);
    const summary = cohortSummary(chosen);
    return { ...summary, nights: round(chosen.reduce((sum, c) => sum + nightsWithin(c, target), 0)) };
  };
  const currentAt = at(current, period, cutoff), priorAt = at(prior, priorPeriod, priorCutoff);
  const dateComplete = current.length > 0 && prior.length > 0 && [...current, ...prior].every((c) => c.booked);
  const previousExists = prior.some((c) => c.booked);
  const change = dateComplete && previousExists ? percentChange(currentAt.nights, priorAt.nights) : null;
  const milestones = [-90, -60, -45, -30, -21, -14, -7, 0, 7, 14, 21, daysBetween(period.from, period.to) - 1];
  const points = milestones.map((days) => {
    const date = shiftDate(period.from, days);
    const priorDate = shiftDate(priorPeriod.from, Math.min(days, daysBetween(priorPeriod.from, priorPeriod.to) - 1));
    return { label: days < 0 ? `提前 ${-days} 天` : `${Number(month.slice(5, 7))}/${days + 1}`,
      date, value: date <= asOf && current.some((c) => c.booked) ? at(current, period, date).nights : null,
      previous: previousExists ? at(prior, priorPeriod, priorDate).nights : null };
  });
  return { current: currentAt, previous: priorAt, previousExists, dateComplete, change, cutoff, priorCutoff, points,
    title: change === null ? "先看目前累積進度" : change < -5 ? "目前可見訂房比去年同進度少" : change > 5 ? "目前可見訂房比去年同進度多" : "目前可見訂房與去年同進度接近" };
}
