import { NextRequest, NextResponse } from 'next/server';
import { authenticateChangeClient, digest, readChangeBody, validateChange } from '@/lib/calendar-changes/contract';
import { processChange } from '@/lib/calendar-changes/process';
import { activeProperty, changeDependencies, changeEnabled } from '@/lib/calendar-changes/runtime';
import type { ChangeReceipt } from '@/lib/calendar-changes/store';
import { principalFor } from '@/lib/workspace-auth/session';
import { allowedProperty } from '@/lib/workspace-auth/projection';
import { readBookingSnapshot } from '@/lib/booking-sources/snapshot';
import { sourceDefinition } from '@/lib/booking-sources/config';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
const proof = (receipt: ChangeReceipt) => ({ ...receipt, status_url: `/api/v1/calendar/changes?${new URLSearchParams({ property: receipt.property_id, event_id: receipt.event_id })}` });
function errorReply(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const status: Record<string, number> = { INVALID_CHANGE: 400, INVALID_PRICING_SNAPSHOT: 400, INVALID_PRICING_CELL: 400, INVALID_SALES_PROBABILITY: 400, PRICING_PROPERTY_MISMATCH: 400, CHANGE_FORBIDDEN: 403, CHANGE_ID_REUSED: 409, CHANGE_TOO_LARGE: 413, CHANGE_QUEUE_FULL: 429 };
  return reply({ code: status[code] ? code : 'CHANGE_TEMPORARILY_UNAVAILABLE', verified: false }, status[code] ?? 503);
}
export async function POST(request: NextRequest) {
  try {
    const client = authenticateChangeClient(request.headers.get('authorization'));
    if (!client) return reply({ code: 'UNAUTHORIZED', verified: false }, 401);
    if (!changeEnabled()) return reply({ code: 'CHANGE_DISABLED', verified: false }, 503);
    const event = validateChange(await readChangeBody(request), client);
    if (!activeProperty(event.property_id)) return reply({ code: 'CHANGE_FORBIDDEN', verified: false }, 403);
    const deps = changeDependencies();
    const saved = await deps.store.enqueue(client.id, event, new Date().toISOString());
    const receipt = await processChange(saved, deps);
    const status = receipt.status === 'applied' ? 200 : ['superseded', 'partially_applied', 'failed'].includes(receipt.status) ? 409 : 202;
    return reply(proof(receipt), status);
  } catch (error) { return errorReply(error); }
}
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams, property = params.get('property') ?? 'sweetfun', eventId = params.get('event_id');
    const client = authenticateChangeClient(request.headers.get('authorization'));
    if (request.headers.has('authorization') && !client) return reply({ code: 'UNAUTHORIZED' }, 401);
    if (client) {
      if (!client.properties.includes(property as 'sweetfun' | 'offland') || !activeProperty(property)) return reply({ code: 'CHANGE_FORBIDDEN' }, 403);
      if (!eventId || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,127}$/.test(eventId)) return reply({ code: 'INVALID_CHANGE' }, 400);
      const saved = await changeDependencies().store.read(property, client.id, eventId);
      // A receipt proves publication at completed_at. It is not a claim that no
      // newer event has been processed since then.
      return saved ? reply(proof(saved.value.receipt)) : reply({ code: 'CHANGE_NOT_FOUND', verified: false }, 404);
    }
    const principal = await principalFor(request);
    if (!principal) return reply({ code: 'UNAUTHORIZED' }, 401);
    if (!allowedProperty(principal, property) || !activeProperty(property)) return reply({ code: 'CHANGE_FORBIDDEN' }, 403);
    if (eventId) return reply({ code: 'CHANGE_FORBIDDEN' }, 403);
    const store = changeDependencies().store;
    const [bookings, revision, prices, inventory] = await Promise.all([
      readBookingSnapshot(sourceDefinition(property)), store.revision(property),
      principal.viewPrices ? store.rawPrice(property) : null, principal.viewPrices ? store.rawInventory(property) : null,
    ]);
    return reply({ property_id: property, revision: digest(JSON.stringify([bookings?.source.snapshot_version, bookings?.source.sync?.status, revision, prices, inventory])).slice(0, 20) });
  } catch (error) { return errorReply(error); }
}
