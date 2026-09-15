import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import RadarDashboard from "@/components/competitor-radar/radar-dashboard";
import GithubRadar from "@/components/competitor-radar/github-radar";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Daili｜競品雷達",
  description: "貼上住宿網址，核對各 OTA 的公開價格與可售狀態。",
  robots: { index: false, follow: false },
};

export default async function RadarTestPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  if (process.env.RADAR_PREVIEW_MODE !== "true") notFound();
  const query = await searchParams;
  if (query.view === "github-funinn" || query.view === "github-sweetfun") {
    if (process.env.VERCEL || (await headers()).get("host") !== "127.0.0.1:43118" || !process.env.RADAR_DESKTOP_QUEUE_DIR) {
      notFound();
    }
    return <GithubRadar propertyKey={query.view === "github-funinn" ? "funinn" : "sweetfun"} />;
  }
  return <RadarDashboard />;
}
