import { type NextRequest, NextResponse } from 'next/server';
import { ironGateManualPaymentConfig,
  manualPaymentRequestResult } from '@/lib/booking-sources/iron-gate-manual-payment.server';
import { manualContext, manualError,
  privateHeaders } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function GET(request: NextRequest,
  context: { params: Promise<{ requestKey: string }> }) {
  try {
    const { principal } = await manualContext(request);
    const { requestKey } = await context.params;
    const result = await manualPaymentRequestResult(principal,
      ironGateManualPaymentConfig(), requestKey);
    return NextResponse.json(result, { headers: privateHeaders });
  } catch (error) { return manualError(error); }
}
