import type { Principal } from '../workspace-auth/types';
import { callIronGate, type ManualConfig } from './iron-gate-manual.server.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read just the current order note with the existing scoped booking credential. */
export async function readIronGateNotes(principal: Principal, config: ManualConfig,
  property: 'sweetfun' | 'offland', bookingId: string, send: typeof fetch = fetch) {
  if (!UUID.test(bookingId)) throw Error('NOTES_INVALID_REQUEST');
  if (!principal.id || !principal.viewPrices ||
    !(principal.allProperties || principal.propertyIds.includes(property)))
    throw Error('NOTES_FORBIDDEN');
  if (config.calendar.mode !== 'authority' ||
    (config.calendar.propertyKey ?? 'sweetfun') !== property ||
    config.grant.propertyId !== config.calendar.grant.propertyId ||
    config.grant.workspaceId !== config.calendar.grant.workspaceId)
    throw Error('NOTES_UNAVAILABLE');
  const raw = await callIronGate(config, principal, 'GET',
    `/v1/properties/${config.grant.propertyId}/bookings/${bookingId}`,
    null, null, send, ['booking:read'], ['notes'], 512 * 1024, 'read');
  if (raw.id !== bookingId || raw.propertyId !== config.grant.propertyId ||
    raw.workspaceId !== config.grant.workspaceId ||
    !Number.isSafeInteger(raw.version) || Number(raw.version) < 1 ||
    !(raw.notes === null || typeof raw.notes === 'string'))
    throw Error('NOTES_UNAVAILABLE');
  return { bookingId, property, version: Number(raw.version), notes: raw.notes };
}
