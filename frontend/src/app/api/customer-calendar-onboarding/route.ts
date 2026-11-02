import { NextRequest, NextResponse } from "next/server";
import { body, failure, headers, store } from "@/lib/customer-workspaces/http";
import {
  previewAvailable,
  optionalAccount,
  limitCalendarPreview,
} from "@/lib/customer-workspaces/calendar-onboarding-http";
import {
  ONBOARDING_COOKIE,
  PREVIEW_SECONDS,
  draftHash,
  draftForHash,
  previewContext,
  startCalendarOnboarding,
  updateCalendarDraft,
  calendarOnboardingView,
  prepareCalendarSave,
  finishCalendarOnboarding,
} from "@/lib/customer-workspaces/calendar-onboarding";
import {
  CALENDAR_STATE_COOKIE,
  calendarGoogleReady,
  calendarSyncReady,
  listGoogleCalendars,
  readGoogleCalendar,
} from "@/lib/customer-workspaces/calendar-google";
import { beginGoogleSignIn } from "@/lib/customer-workspaces/google-signin";
import { previewCalendar } from "@/lib/customer-workspaces/calendar-import";
import { isCalendarKind } from "@/lib/customer-workspaces/calendar-types";
import { scheduleStandardSheetSync } from "@/lib/customer-workspaces/standard-sheet-jobs";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: NextRequest) {
  try {
    previewAvailable();
    const hash = draftHash(request.cookies.get(ONBOARDING_COOKIE)?.value);
    return NextResponse.json(
      {
        ...(await calendarOnboardingView(
          store,
          hash,
          await optionalAccount(request),
        )),
        configured: calendarGoogleReady(),
        syncReady: calendarSyncReady(),
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    previewAvailable();
    const input = await body(request, 2 * 1024 * 1024);
    if (input.action === "start") {
      await limitCalendarPreview(request, "start", 10);
      const started = await startCalendarOnboarding(
        store,
        input,
        request.cookies.get(ONBOARDING_COOKIE)?.value,
      );
      const response = NextResponse.json(
        { url: "/join/calendar" },
        { headers },
      );
      response.cookies.set(ONBOARDING_COOKIE, started.cookie, {
        httpOnly: true,
        secure: request.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/",
        maxAge: Math.max(
          1,
          Math.min(
            PREVIEW_SECONDS,
            Math.ceil((started.draft.expiresAt - Date.now()) / 1000),
          ),
        ),
      });
      return response;
    }
    const hash = draftHash(request.cookies.get(ONBOARDING_COOKIE)?.value),
      saved = await draftForHash(store, hash),
      draft = saved.value;
    await store.limit(`calendar-preview:${hash}`, 100);
    const { args } = previewContext(store, hash, draft);
    if (input.propertyId !== undefined && input.propertyId !== draft.propertyId)
      throw new Error("NOT_FOUND");
    if (input.action === "status")
      return NextResponse.json(
        (
          await calendarOnboardingView(
            store,
            hash,
            await optionalAccount(request),
          )
        ).status,
        { headers },
      );
    if (input.action === "commit") {
      const account = await optionalAccount(request);
      if (draft.completed) {
        if (!account) throw new Error("UNAUTHORIZED");
        return NextResponse.json(
          {
            completed: await finishCalendarOnboarding(
              store,
              hash,
              account,
              input.accountId,
            ),
          },
          { headers },
        );
      }
      await prepareCalendarSave(store, hash, input);
      if (!account?.emailVerifiedAt || input.accountId !== account.id)
        return NextResponse.json(
          {
            loginRequired: true,
            account:
              account?.emailVerifiedAt &&
              (!draft.claimEmail || draft.claimEmail === account.email) &&
              (!draft.googleAccountId || draft.googleAccountId === account.id)
                ? { id: account.id, email: account.email }
                : null,
          },
          { headers },
        );
      const result = await finishCalendarOnboarding(
        store,
        hash,
        account,
        input.accountId,
      );
      await scheduleStandardSheetSync(store, draft.workspaceId);
      return NextResponse.json({ completed: result }, { headers });
    }
    if (input.action === "edit") {
      await updateCalendarDraft(store, hash, saved, {
        prepared: undefined,
        loginRequestId: undefined,
        claimEmail: draft.googleIdentity
          ? (draft.claimEmail ?? draft.googleIdentity.email)
          : undefined,
      });
      return NextResponse.json({ ok: true }, { headers });
    }
    if (draft.prepared || draft.completed)
      throw new Error("CALENDAR_PREVIEW_LOCKED");
    if (input.action === "connect") {
      await limitCalendarPreview(request, "google", 15);
      const started = await beginGoogleSignIn(store, hash),
        response = NextResponse.json({ url: started.url }, { headers });
      response.cookies.set(CALENDAR_STATE_COOKIE, started.browser, {
        httpOnly: true,
        secure: request.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/api/customer-calendar/callback",
        maxAge: 600,
      });
      return response;
    }
    if (input.action === "calendars")
      return NextResponse.json(await listGoogleCalendars(...args), { headers });
    if (input.action === "read") {
      await limitCalendarPreview(request, "read", 20);
      if (
        !isCalendarKind(input.kind) ||
        typeof input.from !== "string" ||
        typeof input.to !== "string" ||
        typeof input.timezone !== "string" ||
        !Array.isArray(input.calendarIds)
      )
        throw new Error("INVALID_INPUT");
      const source = await readGoogleCalendar(...args, {
        kind: input.kind,
        from: input.from,
        to: input.to,
        timezone: input.timezone,
        calendarIds: input.calendarIds as string[],
      });
      await updateCalendarDraft(store, hash, saved, {
        kind: input.kind,
        sourceId: source.id,
        previewId: undefined,
      });
      return NextResponse.json(source, { headers });
    }
    if (input.action === "preview") {
      if (input.snapshotId !== draft.sourceId || input.bindingId)
        throw new Error("NOT_FOUND");
      const preview = await previewCalendar(
        ...args,
        input.snapshotId,
        input.mapping,
      );
      await updateCalendarDraft(store, hash, saved, { previewId: preview.id });
      return NextResponse.json(preview, { headers });
    }
    throw new Error("INVALID_INPUT");
  } catch (error) {
    return failure(error);
  }
}
