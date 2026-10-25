import { type NextRequest, NextResponse } from 'next/server';
import { confirmManualRoomHandling } from '@/lib/booking-sources/iron-gate-manual.server';
import { manualBody, manualContext, manualError, privateHeaders,
  requestKey } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function POST(request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }) {
  let key: string | undefined;
  try {
    const { principal, config } = await manualContext(request, true);
    key = requestKey(request);
    const { bookingId } = await params;
    const result = await confirmManualRoomHandling(principal, config, bookingId,
      await manualBody(request), key);
    return NextResponse.json(result, { headers: privateHeaders });
  } catch (error) { return manualError(error, key); }
}
