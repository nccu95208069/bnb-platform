export async function api<T>(
  url: string,
  method = "GET",
  input?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: input ? { "Content-Type": "application/json" } : undefined,
    body: input ? JSON.stringify(input) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(value.detail || "暫時無法完成，請稍後重試。"),
      { status: response.status, code: value.code },
    );
  return value as T;
}
export const field =
  "mt-1 w-full rounded-xl border border-slate-300 bg-white p-3 text-base";
export const button =
  "rounded-xl bg-teal-800 px-5 py-3 font-medium text-white disabled:opacity-50";
export const secondary =
  "rounded-xl border border-slate-300 bg-white px-4 py-2 disabled:opacity-50";
export function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function plusDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
