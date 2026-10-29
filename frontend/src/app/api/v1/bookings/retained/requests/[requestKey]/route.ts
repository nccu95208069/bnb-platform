import { type NextRequest, NextResponse } from 'next/server';
import { retainedRequestResult } from '@/lib/booking-sources/iron-gate-retained.server';
import { retainedContext, retainedError } from '@/lib/booking-sources/iron-gate-retained-route.server';
import { privateHeaders } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function GET(request: NextRequest, context: { params: Promise<{ requestKey: string }> }) {
  let key: string | undefined;
  try {
    const { principal, config } = await retainedContext(request);
    key = (await context.params).requestKey;
    return NextResponse.json(await retainedRequestResult(principal, config, key), { headers: privateHeaders });
  } catch (error) { return retainedError(error, key); }
}
