import { NextRequest, NextResponse } from "next/server";
import {
  body,
  failure,
  headers,
  principal,
  store,
} from "@/lib/customer-workspaces/http";
import {
  beginCalendarGoogle,
  disconnectCalendarGoogle,
  CALENDAR_STATE_COOKIE,
  calendarGoogleReady,
  calendarSyncReady,
  listGoogleCalendars,
  readGoogleCalendar,
} from "@/lib/customer-workspaces/calendar-google";
import {
  calendarAccess,
  calendarStatus,
  commitCalendar,
  previewCalendar,
  undoCalendar,
} from "@/lib/customer-workspaces/calendar-import";
import {
  refreshCalendarBinding,
  verifyGoogleCalendarPreview,
} from "@/lib/customer-workspaces/calendar-sync";
import { isCalendarKind } from "@/lib/customer-workspaces/calendar-types";
import { sendCustomerLifecycleMail } from "@/lib/workspace-auth/mail";
import { intakePreview } from "@/lib/customer-intake/config";
import {
  syncOnboardingProgress,
  finishOnboardingImport,
} from "@/lib/customer-intake/onboarding";
import { scheduleStandardSheetSync } from "@/lib/customer-workspaces/standard-sheet-jobs";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  try {
    const input = await body(request, 2 * 1024 * 1024),
      account = await principal(request),
      { slug } = await context.params;
    if (typeof input.propertyId !== "string") throw new Error("INVALID_INPUT");
    await store.limit(`calendar:${account.id}`, 100);
    const args = [store, account.id, slug, input.propertyId] as const;
    const { workspace } = await calendarAccess(...args);
    if (input.action === "connect") {
      const result = await beginCalendarGoogle(...args),
        response = NextResponse.json({ url: result.url }, { headers });
      response.cookies.set(CALENDAR_STATE_COOKIE, result.nonce, {
        httpOnly: true,
        secure: request.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/api/customer-calendar/callback",
        maxAge: 600,
      });
      return response;
    }
    let result: unknown;
    switch (input.action) {
      case "status":
        result = {
          ...(await calendarStatus(...args)),
          googleReady: calendarGoogleReady(),
          syncReady: calendarSyncReady(),
        };
        break;
      case "calendars":
        result = await listGoogleCalendars(...args);
        break;
      case "read":
        if (
          !isCalendarKind(input.kind) ||
          typeof input.from !== "string" ||
          typeof input.to !== "string" ||
          typeof input.timezone !== "string" ||
          !Array.isArray(input.calendarIds)
        )
          throw new Error("INVALID_INPUT");
        result = await readGoogleCalendar(...args, {
          kind: input.kind,
          from: input.from,
          to: input.to,
          timezone: input.timezone,
          calendarIds: input.calendarIds as string[],
        });
        break;
      case "preview":
        result = await previewCalendar(
          ...args,
          input.snapshotId,
          input.mapping,
          input.bindingId,
        );
        break;
      case "refresh":
        result = await refreshCalendarBinding(...args, input.bindingId);
        break;
      case "commit":
        await verifyGoogleCalendarPreview(...args, input.previewId);
        result = await commitCalendar(...args, input);
        break;
      case "disconnect":
        result = await disconnectCalendarGoogle(...args, input);
        break;
      case "undo":
        result = await undoCalendar(...args, input);
        break;
      default:
        throw new Error("INVALID_INPUT");
    }
    if (
      input.action === "commit" ||
      input.action === "undo" ||
      input.action === "disconnect"
    ) {
      // A notification/status refresh failure cannot turn a committed import into failure.
      try {
        await syncOnboardingProgress(store, account.id, slug);
      } catch {
        /* Retryable status projection. */
      }
      if (input.action === "commit") {
        try {
          await finishOnboardingImport(
            store,
            account,
            slug,
            input.propertyId,
            String(input.previewId),
            sendCustomerLifecycleMail,
            intakePreview(),
          );
        } catch {
          /* Saved import remains authoritative; retry sends an unaccepted receipt once. */
        }
      }
      await scheduleStandardSheetSync(store, workspace.id);
    }
    return NextResponse.json(result, { headers });
  } catch (error) {
    return failure(error);
  }
}
