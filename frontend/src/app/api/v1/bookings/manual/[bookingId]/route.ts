import { type NextRequest, NextResponse } from 'next/server';
import { amendManualBooking, readManualBooking } from '@/lib/booking-sources/iron-gate-manual.server';
import { manualBody, manualContext, manualError, privateHeaders,
  requestKey } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function GET(request: NextRequest,
  context: { params: Promise<{ bookingId: string }> }) {
  try {
    const { principal, config } = await manualContext(request);
    const { bookingId } = await context.params;
    const result = await readManualBooking(principal, config, bookingId);
    return NextResponse.json(result, { headers: privateHeaders });
  } catch (error) { return manualError(error); }
}

export async function PATCH(request: NextRequest,
  context: { params: Promise<{ bookingId: string }> }) {
  let key: string | undefined;
  try {
    const { principal, config } = await manualContext(request, true);
    key = requestKey(request);
    const { bookingId } = await context.params;
    const result = await amendManualBooking(principal, config, bookingId,
      await manualBody(request), key);
    return NextResponse.json(result, { status: result.operationState === 'sync_pending' ? 202 : 200,
      headers: privateHeaders });
  } catch (error) { return manualError(error, key); }
}
