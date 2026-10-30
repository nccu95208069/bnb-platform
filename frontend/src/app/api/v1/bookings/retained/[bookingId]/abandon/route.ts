import { type NextRequest, NextResponse } from 'next/server';
import { abandonRetainedRequest } from '@/lib/booking-sources/iron-gate-retained.server';
import { retainedContext, retainedError } from '@/lib/booking-sources/iron-gate-retained-route.server';
import { manualBody, requestKey, privateHeaders } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function POST(request: NextRequest, context: { params: Promise<{ bookingId: string }> }) {
  let key: string | undefined;
  try {
    const { principal, config } = await retainedContext(request, true);
    key = requestKey(request);
    const { bookingId } = await context.params;
    const result = await abandonRetainedRequest(principal, config, bookingId,
      await manualBody(request), key);
    return NextResponse.json(result, { headers: privateHeaders });
  } catch (error) { return retainedError(error, key); }
}
