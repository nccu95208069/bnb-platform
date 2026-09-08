/** Next dev may normalize 127.0.0.1 to localhost internally. Keep the exception exact and local. */
export function radarSameOrigin(origin: string | null, serverOrigin: string, host: string | null): boolean {
  if (!origin) return false;
  if (process.env.RADAR_DESKTOP_QUEUE_DIR && !process.env.VERCEL) return host === "127.0.0.1:43118" && origin === "http://127.0.0.1:43118";
  return origin === serverOrigin;
}
