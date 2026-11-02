import { NextRequest, NextResponse } from "next/server";
import { principalFor } from "@/lib/workspace-auth/session";
import { CalendarAppearanceStore } from "@/lib/calendar-appearance-store";
import { CALENDAR_PALETTES, DEFAULT_PALETTE, isPaletteId } from "@/lib/calendar-palettes";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
async function account(request: NextRequest): Promise<string | null> {
  return (await principalFor(request))?.id ?? null;
}
export async function GET(request: NextRequest) {
  try {
    const id = await account(request);
    return NextResponse.json({ scope: id ? "account" : "device", palette: id ? await new CalendarAppearanceStore().read(id) : DEFAULT_PALETTE, presets: CALENDAR_PALETTES }, { headers });
  } catch {
    return NextResponse.json({ detail: "暫時無法讀取個人配色，請稍後重試。" }, { status: 503, headers });
  }
}
export async function PUT(request: NextRequest) {
  if (request.headers.get("origin") !== `${request.nextUrl.protocol}//${request.headers.get("host")}`) return NextResponse.json({ detail: "請從本站設定配色。" }, { status: 403, headers });
  try {
    const id = await account(request);
    if (!id) return NextResponse.json({ detail: "登入已過期，請重新登入後儲存。" }, { status: 401, headers });
    const text = await request.text();
    let input;
    try { input = text.length <= 256 ? JSON.parse(text) : null; } catch { input = null; }
    if (!input || Object.keys(input).some((key) => key !== "palette") || !isPaletteId(input.palette)) return NextResponse.json({ detail: "請選擇提供的五種配色之一。" }, { status: 400, headers });
    const palette = await new CalendarAppearanceStore().save(id, input.palette);
    return NextResponse.json({ scope: "account", palette }, { headers });
  } catch {
    return NextResponse.json({ detail: "尚未確認配色儲存成功，請重新載入後再試。" }, { status: 503, headers });
  }
}
