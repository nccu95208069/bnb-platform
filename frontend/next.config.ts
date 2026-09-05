import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: { "/api/v1/bookings/calendar": ["./.calendar-data/source-snapshot.json"] },
  allowedDevOrigins: process.env.PAYMENT_SANDBOX_PREVIEW_ORIGIN
    ? [new URL(process.env.PAYMENT_SANDBOX_PREVIEW_ORIGIN).hostname]
    : [],
};

export default nextConfig;
