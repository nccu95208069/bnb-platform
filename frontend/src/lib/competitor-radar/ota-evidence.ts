export interface ReturnedStayContext {
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  children?: number;
  rooms?: number;
  currency?: string;
}
export function contextMatches(requested: Required<ReturnedStayContext>, returned: ReturnedStayContext): boolean {
  return Object.entries(requested).every(([key, value]) => returned[key as keyof ReturnedStayContext] === value);
}
export function sameListing(expected: string, returned: string | undefined): boolean {
  try {
    const a = new URL(expected), b = new URL(returned ?? "");
    return b.protocol === "https:" && !b.username && !b.password && (!b.port || b.port === "443") &&
      a.hostname === b.hostname && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch { return false; }
}


/** Raw fields read from the active property Offer region and visible search controls. */
export interface AgodaRenderedEvidence {
  finalUrl?: string;
  sourceName?: string;
  checkIn?: string;
  checkOut?: string;
  currency?: string;
  offerContextUrl?: string;
  offerStatusText?: string;
  blocked?: boolean;
  hasBookableOffer?: boolean;
}

export function verifyAgodaEvidence(
  expected: Required<ReturnedStayContext> & { sourceUrl: string; roomNumber?: string },
  observed: AgodaRenderedEvidence,
) {
  const returned: ReturnedStayContext = { checkIn: observed.checkIn, checkOut: observed.checkOut, currency: observed.currency };
  let offerDatesMatch = false;
  try {
    // This link is read from the returned Offer region, never location.search or the input URL.
    const offer = new URL(observed.offerContextUrl ?? "", observed.finalUrl);
    const source = new URL(expected.sourceUrl);
    const integer = (key: string) => {
      const raw = offer.searchParams.get(key);
      return raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
    };
    if (offer.protocol === "https:" && offer.hostname === source.hostname && offer.pathname === "/search" && /^\d+$/.test(offer.searchParams.get("selectedproperty") ?? "")) {
      returned.adults = integer("adults"); returned.children = integer("children"); returned.rooms = integer("rooms");
      offerDatesMatch = offer.searchParams.get("checkIn")?.slice(0, 10) === observed.checkIn &&
        offer.searchParams.get("checkOut")?.slice(0, 10) === observed.checkOut;
    }
  } catch { /* Incomplete returned context remains unknown. */ }
  const listingMatches = sameListing(expected.sourceUrl, observed.finalUrl) && /sweetfun|水芳/i.test(observed.sourceName ?? "") &&
    (!expected.roomNumber || new RegExp(`(?:^|[^0-9])${expected.roomNumber.replace(/[^0-9]/g, "")}(?:[^0-9]|$)`).test(observed.sourceName ?? ""));
  const stay = { checkIn: expected.checkIn, checkOut: expected.checkOut, adults: expected.adults, children: expected.children, rooms: expected.rooms, currency: expected.currency };
  const contextVerified = !observed.blocked && listingMatches && offerDatesMatch && contextMatches(stay, returned);
  const soldOut = contextVerified && !observed.hasBookableOffer &&
    /Looks like we.re sold out\. Try changing your dates\./i.test(observed.offerStatusText ?? "");
  return { contextVerified, dateVerified: contextVerified, soldOut, returnedContext: returned };
}
