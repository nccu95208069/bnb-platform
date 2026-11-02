import { NextRequest, NextResponse } from "next/server";
import { notificationWorker } from "@/lib/website-booking/notifications";
import { consumeLinePairing } from "@/lib/website-booking/line-pairing";
import { bearer, failure, headers, inputBody, store } from "@/lib/website-booking/http";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    if (request.headers.has("cookie")) throw Error("UNAUTHORIZED");
    const worker = notificationWorker(bearer(request), "line_binding");
    return NextResponse.json(await consumeLinePairing(store, worker, await inputBody(request, 2048)), { headers });
  } catch (error) { return failure(error); }
}
