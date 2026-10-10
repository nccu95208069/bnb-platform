import { NextRequest, NextResponse } from 'next/server';
export const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization', 'Referrer-Policy': 'no-referrer' };
export async function jsonInput(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw Error('INVALID_INPUT');
  const reader = request.body?.getReader();
  if (!reader) throw Error('INVALID_INPUT');
  let size = 0; const chunks: Uint8Array[] = [];
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 8192) { await reader.cancel(); throw Error('INVALID_INPUT'); } chunks.push(value); }
  let input; try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Error('INVALID_INPUT'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('INVALID_INPUT');
  return input as Record<string, unknown>;
}
export function sameOrigin(request: NextRequest) { if (request.headers.get('origin') !== request.nextUrl.origin) throw Error('FORBIDDEN'); }
export function failure(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const errors: Record<string, [number, string]> = {
    UNAUTHORIZED: [401, '請先登入。'], FORBIDDEN: [403, '此帳號沒有這間旅宿的提醒權限。'],
    NOT_FOUND: [404, '找不到旅宿或提醒。'], INVALID_INPUT: [400, '請確認輸入資料。'],
    VERSION_CONFLICT: [409, '備註或狀態已更新，請重新載入後確認。'],
    ARRIVAL_SOURCE_UNCONFIRMED: [503, '來源尚待核對，暫時不能確認入住備註。請稍後重新載入。'],
  };
  const [status, detail] = errors[code] ?? [503, '暫時無法讀取或保存入住提醒，請稍後重試。'];
  return NextResponse.json({ code: errors[code] ? code : 'ARRIVAL_UNAVAILABLE', detail }, { status, headers });
}
