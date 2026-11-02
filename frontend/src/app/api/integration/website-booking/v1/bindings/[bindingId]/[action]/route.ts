import { NextRequest, NextResponse } from "next/server";
import { guestAction } from "@/lib/website-booking/booking";
import { bearer, failure, headers, inputBody, store } from "@/lib/website-booking/http";
export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ bindingId: string; action: string }> }) {
  try {
    if (request.headers.has("cookie")) throw Error("UNAUTHORIZED");
    const { bindingId, action } = await context.params;
    const result = await guestAction(store, bindingId, bearer(request), action, await inputBody(request, 16384), request.headers.get("idempotency-key"));
    return NextResponse.json(result, { headers });
  } catch (error) { return failure(error); }
}
