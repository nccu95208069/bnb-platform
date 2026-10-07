import { NextResponse } from 'next/server';
import { activeSources } from '@/lib/booking-sources/config';
import { authorized } from '@/lib/sheet-monitor/runner';
import { dailyObservation } from '@/lib/calendar-changes/daily-observation';
export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!authorized(request.headers.get('authorization'), process.env.CRON_SECRET)) return reply({ code: 'UNAUTHORIZED' }, 401);
  if (process.env.CALENDAR_DAILY_OBSERVATION_ENABLED !== 'true') return reply({ status: 'disabled' });
  const results = await Promise.all(activeSources().map(async source => {
    try { return { property_id: source.property.id, ...await dailyObservation(source.property.id) }; }
    catch { return { property_id: source.property.id, status: 'needs_attention', code: 'DAILY_OBSERVATION_UNCONFIRMED' }; }
  }));
  return reply({ results });
}
