import "./service.css";
import { ServiceJoin } from "@/components/customer-intake/service-join";
import {
  intakeEnabled,
  intakePreview,
  SHEET_SHARE_EMAIL,
  INTAKE_RECIPIENT,
} from "@/lib/customer-intake/config";
export const dynamic = "force-dynamic";
export const metadata = {
  title: { absolute: "民宿 OS｜把時間，留給款待" },
  description:
    "給包棟、單房與混合經營的民宿：整理旅宿與房間、帶入 Google Sheet 訂房資料，或由專人協助開始。",
  openGraph: {
    title: "民宿 OS｜把時間，留給款待",
    description: "用一份清楚的房況日曆，開始整理旅宿訂房。",
    siteName: "民宿 OS",
    type: "website",
    images: [],
  },
};
export default function Page() {
  return (
    <ServiceJoin
      enabled={intakeEnabled()}
      preview={intakePreview()}
      shareEmail={SHEET_SHARE_EMAIL}
      contactEmail={INTAKE_RECIPIENT}
    />
  );
}
