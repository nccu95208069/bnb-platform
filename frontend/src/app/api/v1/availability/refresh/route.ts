import { activeSources } from '@/lib/booking-sources/config';
import { NextRequest, NextResponse } from "next/server";
import { principalFor } from "@/lib/workspace-auth/session";
import { allowedProperty } from "@/lib/workspace-auth/projection";
import { privateHeaders, sameOrigin } from "@/lib/workspace-auth/http";
import { refreshOwlNest } from "@/lib/owlnest-refresh";

export const runtime="nodejs";
export const maxDuration=60;
export async function POST(request:NextRequest) {
  const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:privateHeaders});
  try {
    sameOrigin(request);
    const principal=await principalFor(request);
    if (!principal) return reply({detail:"請先登入。"},401);
    const property=request.nextUrl.searchParams.get("property") ?? "sweetfun";
    if (!activeSources().some(s=>s.property.id===property)) return reply({detail:"此旅宿尚未接入定價來源。"},422);
    if (!principal.viewPrices || !["owner","admin","god"].includes(principal.role) || !allowedProperty(principal,property)) return reply({detail:"只有此旅宿管理者可以更新 OwlNest 價格。"},403);
    return reply(await refreshOwlNest(undefined,property));
  } catch(error) {
    const code=error instanceof Error ? error.message : "";
    const errors:Record<string,[number,string]>={
      FORBIDDEN:[403,"請從 Sweetfun OS 重新操作。"],
      OWLNEST_NOT_CONFIGURED:[503,"尚未完成 OwlNest 讀取連線設定，請聯絡管理者。"],
      OWLNEST_AUTH_EXPIRED:[503,"OwlNest 登入已失效，請管理者更新連線後重試。"],
      PRICE_REFRESH_BUSY:[409,"已有價格更新進行中，請稍後重新整理。"],
      PRICE_REFRESH_CONFLICT:[409,"價格已被另一個更新作業變更，請重新整理後再試。"],
      PRICE_REFRESH_UNCONFIRMED:[503,"尚無法確認更新結果，請重新整理查看抓取時間。"],
    };
    const [status,detail]=errors[code] ?? [503,"未能取得完整的 OwlNest 價格，保留上次價格，請稍後重試。"];
    return reply({detail},status);
  }
}
