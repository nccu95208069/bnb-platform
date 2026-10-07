import type { NextRequest } from "next/server";
import { authenticate, CUSTOMER_COOKIE, digest } from "./auth.ts";
import { available, store } from "./http.ts";
import { intakeEnabled, onboardingEnabled } from "../customer-intake/config.ts";
export function previewAvailable() {
  available();
  if (!intakeEnabled() || !onboardingEnabled())
    throw new Error("FEATURE_UNAVAILABLE");
}
export async function optionalAccount(request: NextRequest) {
  const cookie = request.cookies.get(CUSTOMER_COOKIE)?.value;
  if (!cookie) return undefined;
  try {
    return await authenticate(store, cookie);
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return undefined;
    throw error;
  }
}
export async function limitCalendarPreview(
  request: NextRequest,
  operation: string,
  max: number,
) {
  await store.limit(
    `calendar-preview-ip:${operation}:${digest(request.headers.get("x-vercel-forwarded-for") || "shared")}`,
    max,
  );
}
