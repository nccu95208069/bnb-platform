const PLATFORM: Record<string, string> = {
  booking: 'booking', 'booking.com': 'booking', agoda: 'agoda',
  airbnb: 'airbnb', line: 'direct', ctrip: 'ctrip', owljourney: 'owljourney',
  '奧丁丁': 'owljourney',
};

export function sweetfunCalendarPlatform(value: unknown): string {
  return typeof value === 'string' ? PLATFORM[value.trim().toLowerCase()] ?? 'other' : 'other';
}
