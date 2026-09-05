import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: process.env.PAYMENT_SANDBOX_PREVIEW_ORIGIN
    ? [new URL(process.env.PAYMENT_SANDBOX_PREVIEW_ORIGIN).hostname]
    : [],
};

export default nextConfig;
