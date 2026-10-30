import type { NextRequest } from 'next/server';
import { retainedCommand } from '@/lib/booking-sources/iron-gate-retained-route.server';
export async function POST(request: NextRequest, context: { params: Promise<{ bookingId: string }> }) {
  return retainedCommand(request, context, 'reschedule', true);
}
