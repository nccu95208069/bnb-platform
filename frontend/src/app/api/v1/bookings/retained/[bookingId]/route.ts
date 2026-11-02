import { type NextRequest, NextResponse } from 'next/server';
import { readRetainedBooking } from '@/lib/booking-sources/iron-gate-retained.server';
import { retainedContext, retainedError } from '@/lib/booking-sources/iron-gate-retained-route.server';
import { privateHeaders } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function GET(request: NextRequest, context: { params: Promise<{ bookingId: string }> }) {
  try {
    const { principal, config } = await retainedContext(request);
    const { bookingId } = await context.params;
    return NextResponse.json(await readRetainedBooking(principal, config, bookingId), { headers: privateHeaders });
  } catch (error) { return retainedError(error); }
}
