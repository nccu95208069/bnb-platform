import { scorePropertyIdentity } from "./identity";
import { AGODA_EVIDENCE_VERSION, contextMatches, type ReturnedStayContext } from "./ota-evidence";
import { acceptedQuote, type QuoteEvidence } from "./quote-evidence";
import type { OtaPlatformScan, OtaScanRequest } from "./ota-types";

export interface DesktopCapture {
  capturedAt: string;
  identity: { propertyId: string; url: string; name: string; address?: string; registrationNumber?: string };
  days: Array<{
    context: ReturnedStayContext;
    rooms: Array<{ name: string; canonicalRoomId?: string; quote: QuoteEvidence }>;
  }>;
  warnings: string[];
}

const nextDay = (day: string) => new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);

/** Never trust a worker's summary amount: rebuild the result from its observations. */
export function desktopScan(request: OtaScanRequest, capture: DesktopCapture, startedAt: number): OtaPlatformScan {
  if (!capture || !capture.identity || !Array.isArray(capture.days) || !Array.isArray(capture.warnings) || capture.days.length > request.days || capture.warnings.some(w => typeof w !== "string" || w.length > 1000)) throw new Error("invalid_capture");
  const captured = Date.parse(capture.capturedAt);
  if (!Number.isFinite(captured) || captured < startedAt || captured > Date.now() + 60000) throw new Error("stale_capture");
  const url = new URL(capture.identity.url);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.endsWith(`.${request.platform}.com`)) throw new Error("invalid_source");
  // Store only the public property link, never a checkout token or session query.
  url.search = ""; url.hash = "";
  if (!capture.identity.propertyId || typeof capture.identity.name !== "string") throw new Error("missing_identity");
  const match = scorePropertyIdentity(request.property, { ...capture.identity, websiteUrl: url.href });
  const seen = new Set<string>();
  const observations = capture.days.map(day => {
    const checkIn = day.context?.checkIn;
    if (!checkIn || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || seen.has(checkIn)) throw new Error("invalid_capture_date");
    seen.add(checkIn);
    const offset = (Date.parse(checkIn + "T00:00:00Z") - Date.parse(request.startDate + "T00:00:00Z")) / 86400000;
    if (!Number.isInteger(offset) || offset < 0 || offset >= request.days) throw new Error("outside_requested_dates");
    const context = { checkIn, checkOut: nextDay(checkIn), adults: request.adults, children: 0, rooms: 1, currency: "TWD" };
    const verified = contextMatches(context, day.context);
    if (!Array.isArray(day.rooms) || day.rooms.length > 100) throw new Error("invalid_rooms");
    const offers = new Set<string>();
    const rooms = day.rooms.map(room => {
      const quote = room.quote;
      if (!quote || !quote.roomId || !quote.ratePlanId || typeof room.name !== "string" || room.name.length > 200 || !Array.isArray(quote.discountLabels)) throw new Error("invalid_offer");
      const key = `${quote.roomId}:${quote.ratePlanId}`;
      if (offers.has(key)) throw new Error("duplicate_offer");
      offers.add(key);
      const accepted = acceptedQuote({ propertyId: capture.identity.propertyId, roomId: quote.roomId, ratePlanId: quote.ratePlanId, context }, quote);
      const sourceValid = request.platform !== "agoda" || quote.source === "checkout_summary";
      const valid = verified && match.status === "confirmed";
      const amount = valid && sourceValid && "amount" in accepted ? accepted.amount : undefined;
      return {
        sourceRoomId: quote.roomId, sourceRoomName: room.name,
        canonicalRoomId: request.canonicalRooms.some(r => r.id === room.canonicalRoomId) ? room.canonicalRoomId : undefined,
        ratePlan: quote.ratePlanId,
        availability: valid ? accepted.availability : "unknown" as const,
        quantityState: "unknown" as const,
        amount, currency: amount === undefined ? undefined : "TWD",
        priceBasis: amount === undefined ? undefined : "tax_inclusive_stay_total" as const,
        sourceText: [quote.source, ...quote.discountLabels.filter(v => typeof v === "string").slice(0, 10), quote.quantityText].filter(Boolean).join(" · ").slice(0, 1000),
        sourceUrl: url.href, returnedContext: day.context, contextVerified: valid,
        priceDetails: amount === undefined ? undefined : { preTaxAmount: quote.preTaxAmount, taxesAndFees: quote.taxesAndFees, discounts: quote.discountLabels.filter(v => typeof v === "string").slice(0, 10), source: quote.source },
      };
    });
    const amounts = rooms.flatMap(room => room.amount === undefined ? [] : [room.amount]);
    const complete = verified && match.status === "confirmed" && request.canonicalRooms.every(r => rooms.some(o => o.canonicalRoomId === r.id && (o.availability === "sold_out" || o.amount !== undefined)));
    return {
      stayDate: checkIn, checkOut: context.checkOut, state: complete ? "ready" as const : "partial" as const,
      availability: rooms.some(r => r.availability === "available") ? "available" as const : complete && rooms.every(r => r.availability === "sold_out") ? "sold_out" as const : "unknown" as const,
      minAmount: amounts.length ? Math.min(...amounts) : undefined,
      currency: amounts.length ? "TWD" : undefined,
      sourceUrl: url.href, identityVerified: match.status === "confirmed", dateVerified: verified, rooms,
    };
  });
  const completedDays = observations.filter(d => d.state === "ready").length;
  return {
    platform: request.platform, state: completedDays === request.days ? "ready" : "partial",
    capturedAt: capture.capturedAt, collectionState: "attempted", evidenceVersion: AGODA_EVIDENCE_VERSION,
    requestedDays: request.days, completedDays,
    identity: { platform: request.platform, sourceUrl: url.href, sourcePropertyId: capture.identity.propertyId, sourceName: capture.identity.name, sourceAddress: capture.identity.address, sourceRegistrationNumber: capture.identity.registrationNumber, score: match.score, status: match.status, evidence: match.evidence.map(e => `${e.label}：${e.detail}`) },
    observations, warnings: capture.warnings, durationMs: Math.max(0, captured - startedAt), collector: "desktop_computer_use",
  };
}
