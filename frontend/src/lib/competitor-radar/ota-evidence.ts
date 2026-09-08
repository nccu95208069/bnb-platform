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
