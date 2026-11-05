import { type NextRequest, NextResponse } from 'next/server';
import { principalFor, sessionMember } from '@/lib/workspace-auth/session';
import { ironGateManualConfig } from '@/lib/booking-sources/iron-gate-manual.server';
import { offlandRetainedConfig } from '@/lib/booking-sources/iron-gate-retained.server';
import { readIronGateNotes } from '@/lib/booking-sources/iron-gate-notes.server';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET(request: NextRequest,
  context: { params: Promise<{ bookingId: string }> }) {
  try {
    const principal = await principalFor(request);
    if (!principal) return NextResponse.json({ code: 'NOTES_UNAUTHORIZED' }, { status: 401, headers });
    const member = await sessionMember(request);
    const property = request.nextUrl.searchParams.get('property');
    if (member?.mustResetPassword || !principal.viewPrices ||
      !['sweetfun', 'offland'].includes(property ?? '') ||
      !(principal.allProperties || principal.propertyIds.includes(property!)))
      return NextResponse.json({ code: 'NOTES_FORBIDDEN' }, { status: 403, headers });
    const { bookingId } = await context.params;
    const scope = property as 'sweetfun' | 'offland';
    const config = scope === 'sweetfun' ? ironGateManualConfig() : offlandRetainedConfig();
    return NextResponse.json(await readIronGateNotes(principal, config, scope, bookingId), { headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const status = code === 'NOTES_INVALID_REQUEST' ? 400 :
      ['NOTES_FORBIDDEN', 'MANUAL_FORBIDDEN', 'FORBIDDEN'].includes(code) ? 403 :
      code === 'BOOKING_NOT_FOUND' ? 404 : 503;
    return NextResponse.json({ code: status === 503 ? 'NOTES_UNAVAILABLE' :
      status === 404 ? 'NOTES_NOT_FOUND' : status === 403 ? 'NOTES_FORBIDDEN' : 'NOTES_INVALID_REQUEST' },
    { status, headers });
  }
}
