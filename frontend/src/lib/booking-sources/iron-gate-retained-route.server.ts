import { type NextRequest, NextResponse } from 'next/server';
import { principalFor, sessionMember } from '../workspace-auth/session';
import { manualBody, manualError, privateHeaders, requestKey } from './iron-gate-manual-route.server.ts';
import { offlandRetainedConfig, canWriteRetained, previewRetainedBooking,
  commitRetainedBooking } from './iron-gate-retained.server.ts';

export async function retainedContext(request: NextRequest, write = false) {
  if (write && (request.headers.get('origin') !== request.nextUrl.origin ||
    request.headers.get('content-type')?.split(';')[0].toLowerCase() !== 'application/json'))
    throw Error('MANUAL_INVALID_REQUEST');
  const property = request.nextUrl.searchParams.get('property');
  if (property !== null && property !== 'offland') throw Error('MANUAL_FORBIDDEN');
  const current = await sessionMember(request);
  if (current?.mustResetPassword) throw Error('MANUAL_FORBIDDEN');
  const principal = await principalFor(request);
  if (!principal) throw Error('MANUAL_UNAUTHORIZED');
  if (!(principal.allProperties || principal.propertyIds.includes('offland')) ||
    write && !canWriteRetained(principal)) throw Error('MANUAL_FORBIDDEN');
  return { principal, config: offlandRetainedConfig() };
}

export function retainedError(error: unknown, key?: string) {
  const code = error instanceof Error ? error.message : 'MANUAL_UNAVAILABLE';
  // A failed read has no write outcome. Preserve the last UI state and offer retry.
  if (!key && ['MANUAL_READBACK_MISMATCH', 'MANUAL_RESULT_UNKNOWN'].includes(code))
    return NextResponse.json({ code: 'MANUAL_READ_UNAVAILABLE' }, { status: 503, headers: privateHeaders });
  if (code === 'FORBIDDEN') return manualError(Error('MANUAL_FORBIDDEN'), key);
  if (code.startsWith('RETENTION_') || code.startsWith('RESCHEDULE_') ||
    ['INVALID_BOOKING_STATUS', 'BOOKING_OPERATION_PENDING', 'SOURCE_REVIEW_REQUIRED',
      'PROPERTY_READ_ONLY', 'BOOKING_VERSION_CONFLICT', 'AUTHORITY_MOVED',
      'CHANNEL_PREVIOUS_OPERATION_UNRESOLVED'].includes(code))
    return NextResponse.json({ code }, { status: 409, headers: privateHeaders });
  return manualError(error, key);
}

export async function retainedCommand(request: NextRequest,
  context: { params: Promise<{ bookingId: string }> }, mode: 'retain' | 'reschedule', preview = false) {
  let key: string | undefined;
  try {
    const { principal, config } = await retainedContext(request, true);
    if (!preview) key = requestKey(request);
    const { bookingId } = await context.params;
    const body = await manualBody(request);
    const result = preview ? await previewRetainedBooking(principal, config, bookingId, mode, body) :
      await commitRetainedBooking(principal, config, bookingId, mode, body, key!);
    return NextResponse.json(result, { headers: privateHeaders });
  } catch (error) { return retainedError(error, key); }
}
