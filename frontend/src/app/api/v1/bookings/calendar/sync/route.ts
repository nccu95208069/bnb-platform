import { NextRequest, NextResponse } from 'next/server';
import { GET as readCalendar } from '../route';
import { createCalendarDelta, validCalendarManifest } from '@/lib/calendar-sync';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const MAX_BYTES = 750_000;

// Read-only synchronization. The manifest contains row IDs and hashes, never
// guest fields. It selects differences, not permissions or source records.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    if (Number(request.headers.get('content-length') ?? '0') > MAX_BYTES)
      return NextResponse.json({ detail: '日曆更新資料過大。' }, { status: 413, headers });
    const reader = request.body?.getReader();
    if (!reader) throw Error('EMPTY');
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        return NextResponse.json({ detail: '日曆更新資料過大。' }, { status: 413, headers });
      }
      text += decoder.decode(part.value, { stream: true });
    }
    body = JSON.parse(text + decoder.decode());
  } catch {
    return NextResponse.json({ detail: '日曆更新格式無效。' }, { status: 400, headers });
  }
  if (!body || typeof body !== 'object')
    return NextResponse.json({ detail: '日曆更新格式無效。' }, { status: 400, headers });
  const input = body as { manifest?: unknown; properties?: unknown };
  if (!validCalendarManifest(input.manifest) || !Array.isArray(input.properties) || input.properties.length > 2 ||
      new Set(input.properties).size !== input.properties.length ||
      input.properties.some(id => id !== 'sweetfun' && id !== 'offland'))
    return NextResponse.json({ detail: '日曆更新格式無效。' }, { status: 400, headers });
  const url = new URL('/api/v1/bookings/calendar', request.url);
  url.searchParams.set('start', input.manifest.start);
  url.searchParams.set('end', input.manifest.end);
  if (input.properties.length) url.searchParams.set('properties', input.properties.join(','));
  // Reuse the normal authenticated, property-scoped and price-redacted reader.
  // Every update revalidates the session and reads current bookings + payments.
  const readHeaders = new Headers(request.headers);
  readHeaders.delete('content-length');
  readHeaders.delete('content-type');
  const response = await readCalendar(new NextRequest(url, { method: 'GET', headers: readHeaders }));
  if (!response.ok) return response;
  try {
    const delta = await createCalendarDelta(input.manifest, await response.json());
    const resultHeaders = new Headers(response.headers);
    resultHeaders.delete('content-length');
    resultHeaders.set('X-Calendar-Transfer', 'delta');
    return NextResponse.json(delta, { headers: resultHeaders });
  } catch {
    return NextResponse.json({ detail: '日曆更新未完成，請重新整理。' }, { status: 409, headers });
  }
}
