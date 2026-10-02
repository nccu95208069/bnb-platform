import { NextRequest, NextResponse } from "next/server";
import {
  body,
  failure,
  headers,
  principal,
  store,
} from "@/lib/customer-workspaces/http";
import {
  beginGoogle,
  GOOGLE_STATE_COOKIE,
  readSheet,
  sheetTabs,
  sourceFor,
} from "@/lib/customer-workspaces/customer-google";
import {
  commitImport,
  previewImport,
  undoImport,
} from "@/lib/customer-workspaces/sheet-import";
import type { Mapping } from "@/lib/customer-workspaces/sheet-import";
export const runtime = "nodejs";
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  try {
    const input = await body(request),
      account = await principal(request),
      { slug } = await context.params;
    await store.limit(`import:${account.id}`, 100);
    if (typeof input.propertyId !== "string") throw new Error("INVALID_INPUT");
    const args = [store, account.id, slug, input.propertyId] as const;
    if (input.action === "connect") {
      const result = await beginGoogle(...args);
      const response = NextResponse.json({ url: result.url }, { headers });
      response.cookies.set(GOOGLE_STATE_COOKIE, result.nonce, {
        httpOnly: true,
        secure: request.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/api/customer-google/callback",
        maxAge: 600,
      });
      return response;
    }
    let result: unknown;
    switch (input.action) {
      case "tabs":
        result = await sheetTabs(...args, input.url);
        break;
      case "read":
        result = await readSheet(...args, input.spreadsheetId, input.sheetId);
        break;
      case "preview":
        result = await previewImport(
          ...args,
          await sourceFor(...args, input.sourceId),
          input.mapping as Mapping,
        );
        break;
      case "commit":
        result = await commitImport(...args, input.previewId, input.selected);
        break;
      case "undo":
        result = await undoImport(...args, input.batchId, input.version);
        break;
      default:
        throw new Error("INVALID_INPUT");
    }
    return NextResponse.json(result, { headers });
  } catch (error) {
    return failure(error);
  }
}
