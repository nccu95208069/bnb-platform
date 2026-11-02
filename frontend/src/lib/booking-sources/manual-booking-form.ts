export const dateAfter = (value: string) =>
  new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export function todayInTaipei(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function stayNights(checkIn: string, checkOut: string): string[] {
  const start = Date.parse(`${checkIn}T00:00:00Z`), end = Date.parse(`${checkOut}T00:00:00Z`);
  const count = (end - start) / 86_400_000;
  if (!Number.isInteger(count) || count < 1 || count > 366) return [];
  return Array.from({ length: count }, (_, n) => new Date(start + n * 86_400_000).toISOString().slice(0, 10));
}

export function twdCents(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const cents = Number(value) * 100;
  return Number.isSafeInteger(cents) && cents <= 1_000_000_000_000 ? cents : null;
}
