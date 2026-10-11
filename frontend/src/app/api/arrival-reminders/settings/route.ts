import { NextRequest, NextResponse } from 'next/server';
import { authenticate, CUSTOMER_COOKIE } from '@/lib/customer-workspaces/auth';
import { RedisCustomerStore } from '@/lib/customer-workspaces/store';
import { prepareRecipientPairing, saveRecipientSetting, settingView } from '@/lib/arrival-reminders/recipient-settings';
import { failure, headers, jsonInput, sameOrigin } from '@/lib/arrival-reminders/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const responseHeaders = { ...headers, Vary: 'Cookie' };
function scope(request: NextRequest) {
  const workspace = request.nextUrl.searchParams.get('workspace');
  const property = request.nextUrl.searchParams.get('property');
  if (!workspace || !property || property.length > 80) throw Error('INVALID_INPUT');
  return { workspace, property };
}
export async function GET(request: NextRequest) {
  try {
    const { workspace, property } = scope(request);
    const store = new RedisCustomerStore();
    const actor = await authenticate(store, request.cookies.get(CUSTOMER_COOKIE)?.value);
    return NextResponse.json(await settingView(store, actor.id, workspace, property), { headers: responseHeaders });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    const { workspace, property } = scope(request), input = await jsonInput(request);
    const store = new RedisCustomerStore();
    const actor = await authenticate(store, request.cookies.get(CUSTOMER_COOKIE)?.value);
    await store.limit(`arrival-setting:${actor.id}`, 30);
    if (input.action === 'save') return NextResponse.json(await saveRecipientSetting(store, actor.id, workspace, property, input), { headers: responseHeaders });
    if (input.action === 'pair') return NextResponse.json(await prepareRecipientPairing(store, actor.id, workspace, property), { headers: responseHeaders });
    throw Error('INVALID_INPUT');
  } catch (error) { return failure(error); }
}
