import { NextRequest, NextResponse } from "next/server";
import { body, failure, headers, principal, store } from "@/lib/customer-workspaces/http";
import { issueSourceCode, ownerSourceAction, ownerSourceGrants } from "@/lib/customer-sources/grants";

export const runtime = "nodejs";
type Context = { params: Promise<{ slug: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    const account = await principal(request), { slug } = await context.params;
    return NextResponse.json(await ownerSourceGrants(store, account.id, slug), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const input = await body(request, 8192), account = await principal(request), { slug } = await context.params;
    await store.limit(`source-owner:${account.id}`, 120);
    const result = input.action === "issue" ? await issueSourceCode(store, account, slug, input) :
      await ownerSourceAction(store, account, slug, input);
    return NextResponse.json(result, { headers });
  } catch (error) { return failure(error); }
}
