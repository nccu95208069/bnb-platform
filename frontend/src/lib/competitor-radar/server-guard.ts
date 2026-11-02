import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 5;

interface RateBucket {
  startedAt: number;
  count: number;
}

type GuardResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      detail: string;
      headers?: Record<string, string>;
    };

type GuardGlobal = typeof globalThis & {
  __competitorRadarRateBuckets?: Map<string, RateBucket>;
};

const guardGlobal = globalThis as GuardGlobal;
const rateBuckets =
  guardGlobal.__competitorRadarRateBuckets ?? new Map<string, RateBucket>();
guardGlobal.__competitorRadarRateBuckets = rateBuckets;

function requestIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost || request.headers.get("host");
  if (!origin || !host) return false;

  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function consumeRateLimit(request: NextRequest): GuardResult {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(key);
  }

  const key = requestIp(request);
  const current = rateBuckets.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return { ok: true };
  }

  if (current.count >= RATE_LIMIT) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((RATE_WINDOW_MS - (now - current.startedAt)) / 1000),
    );
    return {
      ok: false,
      status: 429,
      detail: "分析次數過多，請稍後再試。",
      headers: { "Retry-After": String(retryAfterSeconds) },
    };
  }

  current.count += 1;
  return { ok: true };
}

async function authorizeWorkspace(request: NextRequest): Promise<GuardResult> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) {
    return { ok: false, status: 401, detail: "請先登入後再分析競品。" };
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return { ok: false, status: 503, detail: "登入驗證服務尚未設定。" };
  }

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const userResult = await supabase.auth.getUser(token);
  if (userResult.error || !userResult.data.user) {
    return { ok: false, status: 401, detail: "登入狀態已失效，請重新登入。" };
  }

  const membershipResult = await supabase.rpc("claim_workspace_membership");
  if (membershipResult.error) {
    return { ok: false, status: 403, detail: "無法確認旅宿工作區權限。" };
  }

  const payload = membershipResult.data as {
    memberships?: Array<{ role?: string; status?: string }>;
  } | null;
  const membership = payload?.memberships?.[0];
  if (!membership || membership.status !== "active") {
    return { ok: false, status: 403, detail: "這個帳號沒有可用的旅宿工作區權限。" };
  }
  if (membership.role === "viewer_no_price") {
    return { ok: false, status: 403, detail: "此角色沒有查看價格的權限。" };
  }

  return { ok: true };
}

/**
 * Protects a comparatively expensive outbound-fetch endpoint.
 *
 * - Public demo: same-origin browser requests only, plus a small per-IP budget.
 * - Authenticated product: valid Supabase user + active workspace membership +
 *   price visibility permission, plus the same abuse budget.
 *
 * The in-memory limiter is intentionally a baseline. A multi-region production
 * rollout should replace it with a shared durable limiter.
 */
export async function guardCompetitorAnalysis(
  request: NextRequest,
): Promise<GuardResult> {
  const rateResult = consumeRateLimit(request);
  if (!rateResult.ok) return rateResult;

  if (DEMO_MODE) {
    return sameOrigin(request)
      ? { ok: true }
      : {
          ok: false,
          status: 403,
          detail: "示範環境只接受同來源頁面發出的分析請求。",
        };
  }

  return authorizeWorkspace(request);
}
