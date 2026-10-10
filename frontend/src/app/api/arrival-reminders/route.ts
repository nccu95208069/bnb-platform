import { NextRequest, NextResponse } from 'next/server';
import { principalFor } from '@/lib/workspace-auth/session';
import { authenticate, CUSTOMER_COOKIE } from '@/lib/customer-workspaces/auth';
import { RedisCustomerStore } from '@/lib/customer-workspaces/store';
import { legacyList, customerList } from '@/lib/arrival-reminders/source';
import { arrivalView, markHandled } from '@/lib/arrival-reminders/service';
import { failure, headers, jsonInput, sameOrigin } from '@/lib/arrival-reminders/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
async function context(request: NextRequest) {
  const store = new RedisCustomerStore();
  const property = request.nextUrl.searchParams.get('property'), slug = request.nextUrl.searchParams.get('workspace');
  if (!property || property.length > 80 || (slug && !/^[a-z0-9][a-z0-9-]{2,47}$/.test(slug))) throw Error('INVALID_INPUT');
  if (slug) {
    const actor = await authenticate(store, request.cookies.get(CUSTOMER_COOKIE)?.value);
    return { store, actor: actor.id, list: await customerList(store, actor.id, slug, property) };
  }
  const actor = await principalFor(request);
  if (!actor) throw Error('UNAUTHORIZED');
  if (!['owner', 'god', 'admin'].includes(actor.role) || (!actor.allProperties && !actor.propertyIds.includes(property))) throw Error('FORBIDDEN');
  return { store, actor: actor.id, list: await legacyList(property) };
}
export async function GET(request: NextRequest) {
  try { const { list, store } = await context(request); return NextResponse.json(await arrivalView(store, list), { headers }); }
  catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request); const input = await jsonInput(request);
    if (input.action !== 'handled' || typeof input.id !== 'string' || typeof input.fingerprint !== 'string') throw Error('INVALID_INPUT');
    const { actor, list, store } = await context(request);
    return NextResponse.json(await markHandled(store, list, actor, input.id, input.fingerprint), { headers });
  } catch (error) { return failure(error); }
}
