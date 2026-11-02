import { NextRequest, NextResponse } from "next/server";
import { authenticate, CUSTOMER_COOKIE } from "@/lib/customer-workspaces/auth";
import { body } from "@/lib/customer-workspaces/http";
import { failure, store } from "@/lib/website-booking/http";
import { setWebsiteSales, websiteManagement } from "@/lib/website-booking/management";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "Referrer-Policy": "no-referrer" };
type Context = { params: Promise<{ slug: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    const account = await authenticate(store, request.cookies.get(CUSTOMER_COOKIE)?.value);
    return NextResponse.json(await websiteManagement(store, account.id, (await context.params).slug), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const input = await body(request, 8192);
    const account = await authenticate(store, request.cookies.get(CUSTOMER_COOKIE)?.value);
    await store.limit(`website-management:${account.id}`, 60);
    return NextResponse.json(await setWebsiteSales(store, account.id, (await context.params).slug, input), { headers });
  } catch (error) { return failure(error); }
}
