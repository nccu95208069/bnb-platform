import { after, NextRequest, NextResponse } from "next/server";
import { bearer, failure, headers, inputBody, store } from "@/lib/website-booking/http";
import { serviceClient } from "@/lib/website-booking/config";
import { studioAuthOperation } from "@/lib/website-booking/studio-auth";
import { sendStudioAuthMail } from "@/lib/workspace-auth/mail";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  try {
    const client = serviceClient(bearer(request));
    const input = await inputBody(request, 4096);
    return NextResponse.json(await studioAuthOperation(store, client, input, sendStudioAuthMail, work => after(work)), { headers });
  } catch (error) { return failure(error); }
}
