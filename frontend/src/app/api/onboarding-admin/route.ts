import { NextRequest, NextResponse } from "next/server";
import { principalFor } from "@/lib/workspace-auth/session";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { headers, failure } from "@/lib/customer-workspaces/http";
import {
  listApplications,
  reviewApplication,
} from "@/lib/customer-intake/onboarding";
import { intakePreview } from "@/lib/customer-intake/config";
import { sendCustomerLifecycleMail } from "@/lib/workspace-auth/mail";
import {
  listSupportRequests,
  reviewSupport,
} from "@/lib/customer-workspaces/support";
export const runtime = "nodejs";
export const maxDuration = 60;
async function operator(request: NextRequest) {
  const actor = await principalFor(request);
  if (!actor || !["owner", "god"].includes(actor.role))
    throw new Error("FORBIDDEN");
  return actor;
}
export async function GET(request: NextRequest) {
  try {
    await operator(request);
    return NextResponse.json(
      {
        applications: await listApplications(new RedisCustomerStore()),
        support: await listSupportRequests(new RedisCustomerStore()),
      },
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: NextRequest) {
  try {
    if (request.headers.get("origin") !== request.nextUrl.origin)
      throw new Error("FORBIDDEN");
    const actor = await operator(request),
      raw = await request.text();
    if (raw.length > 4000) throw new Error("INVALID_INPUT");
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new Error("INVALID_INPUT");
    }
    const store = new RedisCustomerStore();
    await store.limit(`intake-admin:${actor.id}`, 100);
    if (
      ["source-approve", "support-reply", "support-resolve"].includes(
        input.action,
      )
    )
      return NextResponse.json(
        await reviewSupport(
          store,
          actor.id,
          input,
          sendCustomerLifecycleMail,
          intakePreview(),
        ),
        { headers },
      );
    const result = await reviewApplication(
      store,
      input.id,
      actor.id,
      input.action,
      input,
      sendCustomerLifecycleMail,
      intakePreview(),
    );
    return NextResponse.json(result, { headers });
  } catch (e) {
    return failure(e);
  }
}
