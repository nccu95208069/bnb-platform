import { NextRequest, NextResponse } from "next/server";
import {
  body,
  failure,
  headers,
  principal,
  store,
} from "@/lib/customer-workspaces/http";
import {
  createBooking,
  loadWorkspace,
  view,
} from "@/lib/customer-workspaces/service";
export const runtime = "nodejs";
type Context = { params: Promise<{ slug: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    const account = await principal(request),
      { slug } = await context.params;
    const { workspace, member } = await loadWorkspace(store, account.id, slug);
    return NextResponse.json(view(workspace, member), { headers });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const input = await body(request),
      account = await principal(request),
      { slug } = await context.params;
    await store.limit(`write:${account.id}`, 300);
    const result = await createBooking(store, account.id, slug, input);
    return NextResponse.json(
      { bookingId: result.booking.id, workspace: result.workspace },
      { status: 201, headers },
    );
  } catch (error) {
    return failure(error);
  }
}
