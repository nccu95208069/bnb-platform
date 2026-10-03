import { NextRequest, NextResponse } from "next/server";
import {
  body,
  failure,
  headers,
  principal,
  store,
} from "@/lib/customer-workspaces/http";
import {
  bindStandardSheet,
  createStandardSheet,
  standardSheetStatus,
  standardWorkbookForOwner,
  syncStandardSheet,
} from "@/lib/customer-workspaces/standard-sheet-sync";
import { standardSheetConfiguration } from "@/lib/customer-workspaces/standard-sheet-google";
export const runtime = "nodejs";
export const maxDuration = 120;
type Context = { params: Promise<{ slug: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    const account = await principal(request),
      { slug } = await context.params;
    if (request.nextUrl.searchParams.get("download") === "1")
      return NextResponse.json(
        await standardWorkbookForOwner(store, account.id, slug),
        {
          headers: {
            ...headers,
            "Content-Disposition": `attachment; filename="${slug}-standard.json"`,
          },
        },
      );
    return NextResponse.json(
      {
        ...(await standardSheetStatus(store, account.id, slug)),
        ...standardSheetConfiguration(),
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const input = await body(request),
      account = await principal(request),
      { slug } = await context.params;
    await store.limit(`standard-sheet:${account.id}`, 30);
    if (input.action === "bind")
      await bindStandardSheet(store, account.id, slug, input.url);
    else if (input.action === "create")
      await createStandardSheet(store, account.id, slug);
    else if (input.action !== "sync") throw new Error("INVALID_INPUT");
    return NextResponse.json(
      {
        ...(await syncStandardSheet(store, account.id, slug)),
        ...standardSheetConfiguration(),
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
