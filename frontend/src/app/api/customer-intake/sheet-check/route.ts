import { NextRequest, NextResponse } from "next/server";
import { intakeEnabled } from "@/lib/customer-intake/config";
import { digest } from "@/lib/customer-workspaces/auth";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { headers, failure } from "@/lib/customer-workspaces/http";
import { checkSharedSheet } from "@/lib/customer-workspaces/shared-sheet";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    if (!intakeEnabled()) throw new Error("FEATURE_UNAVAILABLE");
    if (request.headers.get("origin") !== request.nextUrl.origin)
      throw new Error("FORBIDDEN");
    const store = new RedisCustomerStore();
    await store.limit(
      `sheet-check:${digest(request.headers.get("x-vercel-forwarded-for") || "shared")}`,
      20,
    );
    await store.limit("sheet-check:global", 200);
    const raw = await request.text();
    if (raw.length > 1000) throw new Error("INVALID_INPUT");
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new Error("INVALID_INPUT");
    }
    const result = await checkSharedSheet(input?.url);
    return NextResponse.json(result, { headers });
  } catch (e) {
    return failure(e);
  }
}
