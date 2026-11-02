import { GET as check } from "../route";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  const url = new URL(request.url);
  url.searchParams.set("source", source);
  return check(new Request(url, { method: "GET", headers: request.headers, signal: request.signal }));
}
export const POST = GET;
