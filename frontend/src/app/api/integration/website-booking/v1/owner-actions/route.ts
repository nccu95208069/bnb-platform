import { NextRequest, NextResponse } from "next/server";
import { notificationWorker } from "@/lib/website-booking/notifications";
import { ownerAction } from "@/lib/website-booking/owner-actions";
import { bearer, failure, headers, inputBody, store } from "@/lib/website-booking/http";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    if (request.headers.has("cookie")) throw Error("UNAUTHORIZED");
    const worker = notificationWorker(bearer(request), "owner_actions");
    return NextResponse.json(await ownerAction(store, worker, await inputBody(request, 4096)), { headers });
  } catch (error) { return failure(error); }
}
