import { type NextRequest, NextResponse } from 'next/server';
import { previewManualAmend } from '@/lib/booking-sources/iron-gate-manual.server';
import { manualBody, manualContext, manualError,
  privateHeaders } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function POST(request: NextRequest,
  context: { params: Promise<{ bookingId: string }> }) {
  try {
    const { principal, config } = await manualContext(request, true);
    const { bookingId } = await context.params;
    const result = await previewManualAmend(principal, config, bookingId,
      await manualBody(request));
    return NextResponse.json(result, { headers: privateHeaders });
  } catch (error) { return manualError(error); }
}
