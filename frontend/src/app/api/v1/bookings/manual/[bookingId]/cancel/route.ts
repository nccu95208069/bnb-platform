import { type NextRequest, NextResponse } from 'next/server';
import { cancelManualBooking } from '@/lib/booking-sources/iron-gate-manual.server';
import { manualBody, manualContext, manualError, privateHeaders,
  requestKey } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function POST(request: NextRequest,
  context: { params: Promise<{ bookingId: string }> }) {
  let key: string | undefined;
  try {
    const { principal, config } = await manualContext(request, true);
    key = requestKey(request);
    const { bookingId } = await context.params;
    const result = await cancelManualBooking(principal, config, bookingId,
      await manualBody(request), key);
    return NextResponse.json(result, { status: result.operationState === 'sync_pending' ? 202 : 200,
      headers: privateHeaders });
  } catch (error) { return manualError(error, key); }
}
