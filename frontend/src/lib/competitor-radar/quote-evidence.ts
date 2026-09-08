import { contextMatches, type ReturnedStayContext } from "./ota-evidence";

export interface QuoteEvidence {
  propertyId: string;
  roomId: string;
  ratePlanId: string;
  context: ReturnedStayContext;
  availability: "available" | "sold_out" | "unknown";
  preTaxAmount?: number;
  taxesAndFees?: number;
  totalAmount?: number;
  includesTaxesAndFees: boolean;
  priceBasis: "stay_total" | "nightly" | "unknown";
  discountLabels: string[];
  quantity?: number;
  quantityText?: string;
  source: "property_offer" | "checkout_summary";
}

/** Compare only the final stay total of this exact property, room, plan and guest context. */
export function acceptedQuote(expected: { propertyId: string; roomId: string; ratePlanId: string; context: Required<ReturnedStayContext> }, quote: QuoteEvidence) {
  if (quote.propertyId !== expected.propertyId || quote.roomId !== expected.roomId || quote.ratePlanId !== expected.ratePlanId || !contextMatches(expected.context, quote.context)) return { availability: "unknown" as const };
  // Sold-out prices are historical/display values, not current offers.
  if (quote.availability === "sold_out") return { availability: "sold_out" as const };
  if (quote.availability !== "available") return { availability: "unknown" as const };
  const validMoney = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value > 0;
  const reconciles = quote.preTaxAmount === undefined || quote.taxesAndFees === undefined ||
    (validMoney(quote.preTaxAmount) && Number.isFinite(quote.taxesAndFees) && quote.taxesAndFees >= 0 && Math.abs(quote.preTaxAmount + quote.taxesAndFees - (quote.totalAmount ?? NaN)) <= 0.02);
  const total = quote.includesTaxesAndFees && quote.priceBasis === "stay_total" && validMoney(quote.totalAmount) && reconciles ? quote.totalAmount : undefined;
  return { availability: "available" as const, amount: total, currency: total === undefined ? undefined : quote.context.currency };
}
