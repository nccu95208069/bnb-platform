import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PreviewWorkbench from "@/components/competitor-radar/preview-workbench";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Daili｜競品雷達測試站",
  description: "旅宿身分、房型與來源資料核對測試。",
  robots: { index: false, follow: false },
};
export default function RadarTestPage() {
  if (process.env.RADAR_PREVIEW_MODE !== "true") notFound();
  return <PreviewWorkbench />;
}
