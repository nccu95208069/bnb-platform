import { NextResponse } from 'next/server';
import { activeSources } from '@/lib/booking-sources/config';
import { authorized } from '@/lib/sheet-monitor/runner';
import { changeDependencies, changeEnabled } from '@/lib/calendar-changes/runtime';
import { recoverChanges } from '@/lib/calendar-changes/process';
export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!authorized(request.headers.get('authorization'), process.env.CRON_SECRET)) return reply({ code: 'UNAUTHORIZED' }, 401);
  if (!changeEnabled()) return reply({ code: 'CHANGE_DISABLED' }, 503);
  try {
    const results = await Promise.all(activeSources().map(async source => ({ property_id: source.property.id, results: await recoverChanges(source.property.id, changeDependencies(), 1) })));
    return reply({ results });
  } catch { return reply({ code: 'CHANGE_TEMPORARILY_UNAVAILABLE' }, 503); }
}
