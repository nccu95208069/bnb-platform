import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/website-booking/config";
import { prepareConnection, connectionStatus } from "@/lib/website-booking/connections";
import { bearer, failure, headers, inputBody, store } from "@/lib/website-booking/http";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    if (request.headers.has("cookie")) throw Error("UNAUTHORIZED");
    const client = serviceClient(bearer(request));
    const input = await inputBody(request);
    const result = input.action === "prepare" ? await prepareConnection(store, client, input) : await connectionStatus(store, client, input);
    return NextResponse.json(result, { headers });
  } catch (error) { return failure(error); }
}
