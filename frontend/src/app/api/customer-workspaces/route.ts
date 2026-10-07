import { NextRequest, NextResponse } from "next/server";
import {
  body,
  failure,
  headers,
  principal,
  store,
} from "@/lib/customer-workspaces/http";
import { createWorkspace } from "@/lib/customer-workspaces/service";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const input = await body(request),
      account = await principal(request);
    await store.limit(`create:${account.id}`, 20);
    const result = await createWorkspace(store, account, input);
    return NextResponse.json(result, { status: 201, headers });
  } catch (error) {
    return failure(error);
  }
}
