import { NextRequest, NextResponse } from 'next/server';
import { RedisCustomerStore } from '@/lib/customer-workspaces/store';
import { reminderWorker, workerOperation } from '@/lib/arrival-reminders/worker';
import { failure, headers, jsonInput } from '@/lib/arrival-reminders/http';
export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try {
    if (process.env.ARRIVAL_REMINDERS_ENABLED !== 'true') return NextResponse.json({ code: 'ARRIVAL_DISABLED' }, { status: 503, headers });
    const worker = reminderWorker(request.headers.get('authorization'));
    return NextResponse.json(await workerOperation(new RedisCustomerStore(), worker, await jsonInput(request)), { headers });
  } catch (error) { return failure(error); }
}
