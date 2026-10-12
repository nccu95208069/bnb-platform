import { NextRequest, NextResponse } from "next/server";
import { available, failure, headers, principal, store } from "@/lib/customer-workspaces/http";
import { FILE_IMPORT_LIMIT, stageImportFile } from "@/lib/customer-workspaces/file-import";
import { importAccess } from "@/lib/customer-workspaces/sheet-import";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  try {
    available();
    if (request.headers.get("origin") !== request.nextUrl.origin)
      throw new Error("FORBIDDEN");
    const account = await principal(request);
    const { slug } = await context.params;
    await store.limit(`file-import:${account.id}`, 30);
    const propertyId = request.nextUrl.searchParams.get("propertyId") ?? "";
    const filename = request.nextUrl.searchParams.get("filename") ?? "";
    // Check the tenant and physical property before reading or parsing bytes.
    await importAccess(store, account.id, slug, propertyId);
    const length = request.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > FILE_IMPORT_LIMIT))
      throw new Error("FILE_IMPORT_SIZE");
    const reader = request.body?.getReader();
    if (!reader) throw new Error("FILE_IMPORT_FORMAT");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FILE_IMPORT_LIMIT) {
        await reader.cancel();
        throw new Error("FILE_IMPORT_SIZE");
      }
      chunks.push(value);
    }
    const staged = await stageImportFile(
      store, account.id, slug, propertyId, Buffer.concat(chunks), filename,
    );
    return NextResponse.json(staged, { headers });
  } catch (error) {
    return failure(error);
  }
}
