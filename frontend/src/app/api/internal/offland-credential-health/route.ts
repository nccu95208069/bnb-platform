import { createHash } from 'node:crypto';
import { authorizedRenewal } from '@/lib/offland-renewal-identity';
import { offlandIronGateCalendarConfig, readSweetfunIronGateCalendarSnapshot } from '@/lib/booking-sources/iron-gate-calendar.server';
import type { Principal } from '@/lib/workspace-auth/types';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization' };
// This identity can exercise only the existing OFFLAND read adapter. There is
// no mutation input, session issuance, guest data response or credential issuer.
const principal: Principal = { id: 'offland-credential-renewal', displayName: 'Credential maintenance',
  email: '', role: 'admin', allProperties: false, propertyIds: ['offland'], viewPrices: true };

export async function GET(request: Request) {
  if (!await authorizedRenewal(request.headers.get('authorization')))
    return Response.json({ ok: false }, { status: 403, headers });
  const url = new URL(request.url), start = url.searchParams.get('start'), end = url.searchParams.get('end');
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    return Response.json({ ok: false }, { status: 400, headers });
  try {
    const config = offlandIronGateCalendarConfig();
    const snapshot = await readSweetfunIronGateCalendarSnapshot(start, end, principal, config);
    const comparable = { bookings: snapshot.bookings, inventoryVersion: snapshot.inventoryVersion,
      authorityEpoch: snapshot.authorityEpoch, soldRoomNights: snapshot.soldRoomNights,
      blockedRoomNights: snapshot.blockedRoomNights };
    return Response.json({ ok: true, property: 'offland', credentialId: config.grant.credentialId,
      inventoryVersion: snapshot.inventoryVersion, authorityEpoch: snapshot.authorityEpoch,
      soldRoomNights: snapshot.soldRoomNights, blockedRoomNights: snapshot.blockedRoomNights,
      digest: createHash('sha256').update(JSON.stringify(comparable)).digest('hex') }, { headers });
  } catch {
    return Response.json({ ok: false, code: 'OFFLAND_CALENDAR_READ_FAILED' }, { status: 503, headers });
  }
}
