import { type NextRequest, NextResponse } from 'next/server';
import { createManualBooking } from '@/lib/booking-sources/iron-gate-manual.server';
import { manualBody, manualContext, manualError, privateHeaders,
  requestKey } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function POST(request: NextRequest) {
  let key: string | undefined;
  try {
    const { principal, config } = await manualContext(request, true);
    key = requestKey(request);
    const result = await createManualBooking(principal, config, await manualBody(request), key);
    return NextResponse.json(result, { status: result.operationState === 'sync_pending' ? 202 : 201,
      headers: privateHeaders });
  } catch (error) { return manualError(error, key); }
}
