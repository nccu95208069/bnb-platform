// Shared by the login UI; destination never expands the user's server permissions.
export function customerReturnPath(value: string | null): string | null {
  if (typeof value !== "string" || !value || value.length > 300 || !/^\/w\/[a-z0-9][a-z0-9-]{2,47}\/(calendar|orders(?:\/[a-f0-9-]{36})?|availability|finance|revenue|settings|import|arrivals)(\?[^#]*)?$/.test(value)) return null;
  const url = new URL(value, 'https://os.invalid');
  const allowed = new Set(['property', 'order', 'status', 'date']);
  if ([...url.searchParams].some(([key, val]) => !allowed.has(key) || !/^[a-zA-Z0-9_-]{1,80}$/.test(val))) return null;
  return url.pathname + url.search;
}
