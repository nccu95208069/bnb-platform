import { NextRequest, NextResponse } from "next/server";
import { failure, headers, store } from "@/lib/customer-workspaces/http";
import {
  previewAvailable,
  limitCalendarPreview,
} from "@/lib/customer-workspaces/calendar-onboarding-http";
import {
  ONBOARDING_COOKIE,
  draftHash,
  draftForHash,
  previewContext,
  updateCalendarDraft,
} from "@/lib/customer-workspaces/calendar-onboarding";
import { uploadCalendar } from "@/lib/customer-workspaces/calendar-import";
import { CALENDAR_UPLOAD_LIMIT } from "@/lib/customer-workspaces/calendar-source";
import { isCalendarKind } from "@/lib/customer-workspaces/calendar-types";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  try {
    previewAvailable();
    if (request.headers.get("origin") !== request.nextUrl.origin)
      throw new Error("FORBIDDEN");
    const hash = draftHash(request.cookies.get(ONBOARDING_COOKIE)?.value),
      saved = await draftForHash(store, hash),
      draft = saved.value;
    if (draft.prepared || draft.completed)
      throw new Error("CALENDAR_PREVIEW_LOCKED");
    await limitCalendarPreview(request, "upload", 10);
    const q = request.nextUrl.searchParams,
      kind = q.get("kind"),
      filename = q.get("filename") ?? "";
    if (!isCalendarKind(kind) || q.get("propertyId") !== draft.propertyId)
      throw new Error("INVALID_INPUT");
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
    const { args } = previewContext(store, hash, draft);
    const source = await uploadCalendar(
      ...args,
      Buffer.concat(chunks),
      filename,
      {
        kind,
        from: q.get("from") ?? "",
        to: q.get("to") ?? "",
        timezone: q.get("timezone") ?? "",
      },
    );
    await updateCalendarDraft(store, hash, saved, {
      sourceId: source.id,
      previewId: undefined,
      kind,
    });
    return NextResponse.json(source, { headers });
  } catch (error) {
    return failure(error);
  }
}
