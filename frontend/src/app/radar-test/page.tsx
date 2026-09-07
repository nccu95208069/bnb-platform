import type { Metadata } from "next";
import { notFound } from "next/navigation";

import RadarDashboard from "@/components/competitor-radar/radar-dashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Daili｜競品雷達",
  description: "貼上住宿網址，核對各 OTA 的公開價格與可售狀態。",
  robots: { index: false, follow: false },
};

export default function RadarTestPage() {
  if (process.env.RADAR_PREVIEW_MODE !== "true") notFound();
  return <RadarDashboard />;
}
