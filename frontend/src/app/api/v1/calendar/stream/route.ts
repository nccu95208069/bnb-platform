import { NextRequest } from 'next/server';
import { principalFor } from '@/lib/workspace-auth/session';
import { allowedProperty } from '@/lib/workspace-auth/projection';
import { calendarStreamConfig, streamProperties } from '@/lib/calendar-realtime/config.server';
import { calendarEventStream } from '@/lib/calendar-realtime/stream.server';
import { subscribeCalendarChanges } from '@/lib/calendar-realtime/subscribe.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const headers = { 'Cache-Control': 'private, no-store, no-transform', Vary: 'Cookie, Authorization' };

export async function GET(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    if (origin && origin !== request.nextUrl.origin || request.headers.get('sec-fetch-site') === 'cross-site')
      return Response.json({ code: 'FORBIDDEN' }, { status: 403, headers });
    const properties = streamProperties(request.nextUrl.searchParams.get('properties'));
    const principal = await principalFor(request);
    if (!principal) return Response.json({ code: 'UNAUTHORIZED' }, { status: 401, headers });
    if (properties.some(property => !allowedProperty(principal, property)))
      return Response.json({ code: 'FORBIDDEN' }, { status: 403, headers });
    const config = calendarStreamConfig(properties);
    const originalScope = JSON.stringify([principal.id, principal.role, principal.viewPrices,
      principal.allProperties, [...principal.propertyIds].sort()]);
    return new Response(calendarEventStream({
      targets: config.targets,
      signal: request.signal,
      subscribe: callbacks => subscribeCalendarChanges(config, callbacks),
      authorized: async () => {
        // principalFor caches within one request. A fresh wrapper is required to
        // check current membership/credential revocations during a long stream.
        const current = await principalFor({ cookies: request.cookies });
        return !!current && properties.every(property => allowedProperty(current, property)) &&
          originalScope === JSON.stringify([current.id, current.role, current.viewPrices,
            current.allProperties, [...current.propertyIds].sort()]);
      },
    }), { headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' } });
  } catch (error) {
    const invalid = error instanceof Error && error.message === 'INVALID_PROPERTIES';
    return Response.json({ code: invalid ? 'INVALID_PROPERTIES' : 'CALENDAR_STREAM_UNAVAILABLE' },
      { status: invalid ? 400 : 503, headers });
  }
}
