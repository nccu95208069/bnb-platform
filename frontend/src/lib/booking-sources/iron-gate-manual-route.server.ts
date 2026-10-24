import { type NextRequest, NextResponse } from 'next/server';
import { principalFor, sessionMember } from '../workspace-auth/session';
import { ironGateManualConfig } from './iron-gate-manual.server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function manualContext(request: NextRequest, write = false) {
  if (write && (request.headers.get('origin') !== request.nextUrl.origin ||
    request.headers.get('content-type')?.split(';')[0].toLowerCase() !== 'application/json'))
    throw Error('MANUAL_INVALID_REQUEST');
  const current = await sessionMember(request);
  if (current?.mustResetPassword) throw Error('MANUAL_FORBIDDEN');
  const principal = await principalFor(request);
  if (!principal) throw Error('MANUAL_UNAUTHORIZED');
  if (!['owner', 'admin', 'god'].includes(principal.role) ||
    !(principal.allProperties || principal.propertyIds.includes('sweetfun')) ||
    !principal.viewPrices) throw Error('MANUAL_FORBIDDEN');
  return { principal, config: ironGateManualConfig() };
}

export function requestKey(request: NextRequest): string {
  const key = request.headers.get('idempotency-key');
  if (!key || !UUID.test(key)) throw Error('MANUAL_IDEMPOTENCY_KEY_REQUIRED');
  return key;
}

export async function manualBody(request: NextRequest): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 16 * 1024))
    throw Error('MANUAL_INVALID_INPUT');
  const reader = request.body?.getReader();
  if (!reader) throw Error('MANUAL_INVALID_INPUT');
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16 * 1024) { await reader.cancel(); throw Error('MANUAL_INVALID_INPUT'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error('MANUAL_INVALID_INPUT'); }
}

export function manualError(error: unknown, key?: string) {
  const code = error instanceof Error ? error.message : 'MANUAL_UNAVAILABLE';
  if (code === 'MANUAL_RESULT_UNKNOWN' || code === 'MANUAL_READBACK_MISMATCH')
    return NextResponse.json({ outcome: 'unknown', request_key: key },
      { status: 202, headers: privateHeaders });
  const status = code === 'MANUAL_UNAUTHORIZED' ? 401 :
    code === 'MANUAL_FORBIDDEN' ? 403 :
    code === 'MANUAL_CONFIG_UNAVAILABLE' ? 404 :
    code.startsWith('MANUAL_INVALID') || code === 'MANUAL_REASON_REQUIRED' ||
      code === 'MANUAL_IDEMPOTENCY_KEY_REQUIRED' || code === 'FUTURE_RECEIPT' ||
      code === 'INVALID_AMOUNT' || code === 'INVALID_CURRENCY' ? 400 :
    code === 'ROOM_CONFLICT' || code.includes('VERSION') ||
      code.includes('NOT_READY') || code.includes('READ_ONLY') ||
      code.includes('REQUIRES') || code === 'REFUND_EXCEEDS_RECEIVED' ||
      code === 'PAYMENT_EVENT_LIMIT' || code === 'PAYMENT_EVENT_EXISTS' ||
      code === 'IDEMPOTENCY_CONFLICT' ? 409 :
    code === 'BOOKING_NOT_FOUND' || code === 'REQUEST_NOT_FOUND' ? 404 : 503;
  // Iron Gate errors use stable codes; never return guest or provider payloads.
  return NextResponse.json({ code }, { status, headers: privateHeaders });
}
