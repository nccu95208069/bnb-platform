import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/calendar-access", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
  outputFileTracingIncludes: {
    "/api/v1/availability": ["./.calendar-data/*source-snapshot.json"],
    "/api/v1/bookings/calendar": ["./.calendar-data/*source-snapshot.json"],
    "/api/cron/sheet-monitor": ["./.calendar-data/*source-snapshot.json"],
    "/api/cron/sheet-monitor/*": ["./.calendar-data/*source-snapshot.json"],
  },
  allowedDevOrigins: process.env.PAYMENT_SANDBOX_PREVIEW_ORIGIN
    ? [new URL(process.env.PAYMENT_SANDBOX_PREVIEW_ORIGIN).hostname]
    : [],
};

export default nextConfig;
