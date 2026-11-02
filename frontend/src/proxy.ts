import { NextRequest, NextResponse } from "next/server";

/** A fixed-snapshot Preview exposes only sign-in and the read-only calendar. */
export function proxy(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview" ||
    process.env.IRON_GATE_PREVIEW_OWNER_ONLY !== "true") return NextResponse.next();
  const path = request.nextUrl.pathname;
  if (path.startsWith("/_next/") || path === "/favicon.ico" || path === "/icon.png")
    return NextResponse.next();
  if (path === "/") return NextResponse.redirect(new URL("/calendar", request.url));
  if (request.method === "GET" && (path === "/calendar" || path === "/calendar-access" ||
    path === "/api/v1/bookings/calendar")) return NextResponse.next();
  if (path === "/api/calendar-session" &&
    ["GET", "POST", "DELETE"].includes(request.method)) return NextResponse.next();
  return new NextResponse(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
}
