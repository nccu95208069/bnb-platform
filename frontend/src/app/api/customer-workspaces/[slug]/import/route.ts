import { NextRequest, NextResponse } from "next/server";
import { scheduleStandardSheetSync } from "@/lib/customer-workspaces/standard-sheet-jobs";
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
  importAccess,
} from "@/lib/customer-workspaces/sheet-import";
import type {
  Mapping,
  ImportPreview,
} from "@/lib/customer-workspaces/sheet-import";
import {
  sharedImportPermission,
  syncOnboardingProgress,
  finishOnboardingImport,
  requestImportHelp,
} from "@/lib/customer-intake/onboarding";
import {
  bindPropertySource,
  propertySupport,
} from "@/lib/customer-workspaces/support";
import {
  sharedTabs,
  sharedSource,
} from "@/lib/customer-workspaces/shared-sheet";
import { sendCustomerLifecycleMail } from "@/lib/workspace-auth/mail";
import { intakePreview } from "@/lib/customer-intake/config";
import { digest } from "@/lib/customer-workspaces/auth";
export const runtime = "nodejs";
export const maxDuration = 60;
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
    const { workspace, property } = await importAccess(...args);
    if (input.action === "bind")
      return NextResponse.json(
        await bindPropertySource(
          store,
          account,
          slug,
          input.propertyId,
          input,
          sendCustomerLifecycleMail,
          intakePreview(),
        ),
        { headers },
      );
    if (input.action === "help")
      return NextResponse.json(
        workspace.onboarding && workspace.properties[0]?.id === input.propertyId
          ? await requestImportHelp(
              ...args,
              input.message,
              sendCustomerLifecycleMail,
              intakePreview(),
            )
          : await propertySupport(
              store,
              account,
              slug,
              input.propertyId,
              input.message,
              sendCustomerLifecycleMail,
              intakePreview(),
            ),
        { headers },
      );
    const existingBatch =
      input.action === "commit" &&
      workspace.importBatches?.some((b) => b.id === input.previewId);
    const shared =
      (property.setup?.sheetUrl ||
        (workspace.onboarding &&
          workspace.properties[0]?.id === input.propertyId)) &&
      input.action !== "undo" &&
      !existingBatch
        ? await sharedImportPermission(...args)
        : null;
    if (input.action === "connect") {
      if (shared) throw new Error("INVALID_INPUT");
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
        result = shared
          ? await sharedTabs(shared.url)
          : await sheetTabs(...args, input.url);
        break;
      case "read":
        result = shared
          ? await sharedSource(...args, shared.url, input.sheetId)
          : await readSheet(...args, input.spreadsheetId, input.sheetId);
        break;
      case "preview":
        result = await previewImport(
          ...args,
          await sourceFor(...args, input.sourceId),
          input.mapping as Mapping,
        );
        break;
      case "commit":
        if (
          shared &&
          !workspace.importBatches?.some((b) => b.id === input.previewId)
        ) {
          if (input.confirmed !== true)
            throw new Error("FORMAT_CONFIRMATION_REQUIRED");
          const staged = (
            await store.read<ImportPreview>(`import-preview:${input.previewId}`)
          ).value;
          if (
            !staged ||
            staged.accountId !== account.id ||
            staged.workspaceId !== workspace.id ||
            staged.propertyId !== input.propertyId
          )
            throw new Error("NOT_FOUND");
          const fresh = await sharedSource(
            ...args,
            shared.url,
            staged.source.sheetId,
          );
          if (digest(JSON.stringify(fresh.rows)) !== staged.sourceHash)
            throw new Error("SOURCE_CHANGED");
        }
        if (input.confirmed !== true)
          throw new Error("FORMAT_CONFIRMATION_REQUIRED");
        result = await commitImport(
          ...args,
          input.previewId,
          input.selected,
          input.confirmedEmpty === true,
        );
        await finishOnboardingImport(
          store,
          account,
          slug,
          input.propertyId,
          String(input.previewId),
          sendCustomerLifecycleMail,
          intakePreview(),
        );
        break;
      case "undo":
        result = await undoImport(...args, input.batchId, input.version);
        await syncOnboardingProgress(store, account.id, slug);
        break;
      default:
        throw new Error("INVALID_INPUT");
    }
    if (input.action === "commit" || input.action === "undo")
      await scheduleStandardSheetSync(store, workspace.id);
    return NextResponse.json(result, { headers });
  } catch (error) {
    return failure(error);
  }
}
