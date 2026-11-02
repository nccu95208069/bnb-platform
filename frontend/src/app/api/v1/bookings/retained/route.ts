import { type NextRequest, NextResponse } from 'next/server';
import { listRetainedBookings } from '@/lib/booking-sources/iron-gate-retained.server';
import { retainedContext, retainedError } from '@/lib/booking-sources/iron-gate-retained-route.server';
import { privateHeaders } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function GET(request: NextRequest) {
  try {
    const { principal, config } = await retainedContext(request);
    return NextResponse.json(await listRetainedBookings(principal, config), { headers: privateHeaders });
  } catch (error) { return retainedError(error); }
}
