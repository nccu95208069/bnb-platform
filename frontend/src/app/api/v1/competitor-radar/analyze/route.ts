import { type NextRequest, NextResponse } from "next/server";

import { analyzeCompetitorProperty } from "@/lib/competitor-radar/analyze-property";
import { guardCompetitorAnalysis } from "@/lib/competitor-radar/server-guard";
import { PublicUrlError } from "@/lib/competitor-radar/website";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface AnalyzeRequest {
  url?: unknown;
}

export async function POST(request: NextRequest) {
  const guard = await guardCompetitorAnalysis(request);
  if (!guard.ok) {
    return NextResponse.json(
      { detail: guard.detail },
      { status: guard.status, headers: guard.headers },
    );
  }

  let body: AnalyzeRequest;
  try {
    body = (await request.json()) as AnalyzeRequest;
  } catch {
    return NextResponse.json({ detail: "請提供 JSON 請求內容。" }, { status: 400 });
  }

  if (typeof body.url !== "string" || !body.url.trim()) {
    return NextResponse.json({ detail: "請提供要分析的住宿網址。" }, { status: 422 });
  }
  if (body.url.length > 2048) {
    return NextResponse.json({ detail: "網址過長。" }, { status: 422 });
  }

  try {
    const analysis = await analyzeCompetitorProperty(body.url.trim());
    return NextResponse.json(analysis, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof PublicUrlError) {
      return NextResponse.json({ detail: error.message }, { status: 422 });
    }
    console.error("competitor-radar analyze failed", error);
    return NextResponse.json(
      { detail: "分析過程發生非預期錯誤，未寫入任何資料。" },
      { status: 500 },
    );
  }
}
