import { recordIntegratedPayment } from '@/lib/booking-sources/iron-gate-finance-payment.server';
import { type NextRequest, NextResponse } from 'next/server';
import { ironGateManualPaymentConfig, readManualPayment } from '@/lib/booking-sources/iron-gate-manual-payment.server';
import { manualBody, manualContext, manualError, privateHeaders,
  requestKey } from '@/lib/booking-sources/iron-gate-manual-route.server';

export async function GET(request: NextRequest,
  context: { params: Promise<{ bookingId: string }> }) {
  try {
    const { principal } = await manualContext(request);
    const { bookingId } = await context.params;
    return NextResponse.json(await readManualPayment(principal,
      ironGateManualPaymentConfig(), bookingId), { headers: privateHeaders });
  } catch (error) { return manualError(error); }
}

export async function POST(request: NextRequest,
  context: { params: Promise<{ bookingId: string }> }) {
  let key: string | undefined;
  try {
    const { principal } = await manualContext(request, true);
    key = requestKey(request);
    const { bookingId } = await context.params;
    const result = await recordIntegratedPayment(principal,
      bookingId, await manualBody(request), key);
    return NextResponse.json(result, { status: 201, headers: privateHeaders });
  } catch (error) { return manualError(error, key); }
}
