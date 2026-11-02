import { NextRequest, NextResponse } from "next/server";
import {
  available,
  failure,
  headers,
  principal,
  store,
} from "@/lib/customer-workspaces/http";
import {
  calendarAccess,
  uploadCalendar,
} from "@/lib/customer-workspaces/calendar-import";
import { CALENDAR_UPLOAD_LIMIT } from "@/lib/customer-workspaces/calendar-source";
import { isCalendarKind } from "@/lib/customer-workspaces/calendar-types";
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
    const account = await principal(request),
      { slug } = await context.params,
      query = request.nextUrl.searchParams;
    await store.limit(`calendar-upload:${account.id}`, 30);
    const propertyId = query.get("propertyId") ?? "",
      kind = query.get("kind"),
      filename = query.get("filename") ?? "";
    if (!isCalendarKind(kind) || filename.length > 500)
      throw new Error("INVALID_INPUT");
    await calendarAccess(store, account.id, slug, propertyId);
    const length = request.headers.get("content-length");
    if (
      length &&
      (!/^\d+$/.test(length) || Number(length) > CALENDAR_UPLOAD_LIMIT)
    )
      throw new Error("CALENDAR_SIZE");
    const reader = request.body?.getReader();
    if (!reader) throw new Error("CALENDAR_FORMAT");
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CALENDAR_UPLOAD_LIMIT) {
        await reader.cancel();
        throw new Error("CALENDAR_SIZE");
      }
      chunks.push(value);
    }
    return NextResponse.json(
      await uploadCalendar(
        store,
        account.id,
        slug,
        propertyId,
        Buffer.concat(chunks),
        filename,
        {
          kind,
          from: query.get("from") ?? "",
          to: query.get("to") ?? "",
          timezone: query.get("timezone") ?? "",
        },
      ),
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
