import { type NextRequest, NextResponse } from 'next/server';
import { recoverIntegratedPayment } from '@/lib/booking-sources/iron-gate-finance-payment.server';
import { manualContext, manualError,
  privateHeaders } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function GET(request: NextRequest,
  context: { params: Promise<{ requestKey: string }> }) {
  try {
    const { principal } = await manualContext(request);
    const { requestKey } = await context.params;
    const result = await recoverIntegratedPayment(principal, requestKey);
    return NextResponse.json(result, { headers: privateHeaders });
  } catch (error) { return manualError(error); }
}
