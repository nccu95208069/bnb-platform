import { NextRequest, NextResponse } from "next/server";

// Local test harness only: never expose its fixed synthetic identity in a deployment.
export const dynamic = "force-dynamic";
async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.PAYMENT_SANDBOX_ENABLED !== "true" ||
    !["127.0.0.1:3000", "localhost:3000"].includes(
      request.headers.get("host") ?? "",
    )
  ) {
    return NextResponse.json({ detail: "sandbox_disabled" }, { status: 404 });
  }
  if (
    request.method === "POST" &&
    (request.headers.get("x-payment-sandbox") !== "1" ||
      (request.headers.get("origin") &&
        !["http://127.0.0.1:3000", "http://localhost:3000"].includes(
          request.headers.get("origin")!,
        )))
  ) {
    return NextResponse.json(
      { detail: "same_origin_required" },
      { status: 403 },
    );
  }
  const { path } = await context.params;
  const suffix = path.join("/");
  // No arbitrary upstream URLs or reset/repair endpoints.
  const allowed =
    /^(calendar|workflow\/missions(?:\/[0-9a-f-]+(?:\/(advance|confirm|resume|clarify|resolve|cancel))?)?|workflow\/tools\/check_order)$/;
  if (!allowed.test(suffix))
    return NextResponse.json({ detail: "not_found" }, { status: 404 });
  const upstream =
    suffix === "calendar"
      ? "/sandbox/calendar"
      : "/api/v1/tenants/sandbox-tenant/properties/sandbox-property/payment-workflow/" +
        suffix.slice(9);
  try {
    const response = await fetch(
      "http://127.0.0.1:8765" + upstream + request.nextUrl.search,
      {
        method: request.method,
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Sandbox": "1",
        },
        body: request.method === "POST" ? await request.text() : undefined,
        signal: AbortSignal.timeout(15000),
      },
    );
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { detail: "測試服務暫時無法連線，已保存的任務可稍後繼續。" },
      { status: 503 },
    );
  }
}
export { proxy as GET, proxy as POST };
