import { type NextRequest, NextResponse } from 'next/server';
import { previewManualBooking } from '@/lib/booking-sources/iron-gate-manual.server';
import { manualBody, manualContext, manualError,
  privateHeaders } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function POST(request: NextRequest) {
  try {
    const { principal, config } = await manualContext(request, true);
    const result = await previewManualBooking(principal, config, await manualBody(request));
    return NextResponse.json(result, { headers: privateHeaders });
  } catch (error) { return manualError(error); }
}
