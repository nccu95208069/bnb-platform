import { NextRequest, NextResponse } from "next/server";
import { enabled } from "@/lib/customer-workspaces/auth";
import { fields } from "@/lib/website-booking/config";
import { discoverWorkerBindings, notificationWorker } from "@/lib/website-booking/notifications";
import { bearer, failure, headers, inputBody, store } from "@/lib/website-booking/http";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    if (request.headers.has("cookie")) throw Error("UNAUTHORIZED");
    const worker = notificationWorker(bearer(request), "notifications");
    if (!enabled()) throw Error("WEBSITE_BOOKING_UNAVAILABLE");
    const input = await inputBody(request, 1024);
    fields(input, ["schemaVersion", "action"]);
    if (input.schemaVersion !== 1 || input.action !== "discover") throw Error("INVALID_INPUT");
    return NextResponse.json({ schemaVersion: 1, bindings: await discoverWorkerBindings(store, worker),
      channels: worker.channels ?? ["guestEmail", "ownerEmail", "ownerLine"] }, { headers });
  } catch (error) { return failure(error); }
}
