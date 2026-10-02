import "./service.css";
import { cookies } from "next/headers";
import { SERVICE_THEME_COOKIE, serviceTheme } from "@/lib/customer-intake/theme";
import { ServiceIntakeRouter } from "@/components/customer-intake/service-intake-router";
import {
  intakeEnabled,
  intakePreview,
  SHEET_SHARE_EMAIL,
  INTAKE_RECIPIENT,
} from "@/lib/customer-intake/config";
export const dynamic = "force-dynamic";
export default async function JoinLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const initialTheme = serviceTheme(
    (await cookies()).get(SERVICE_THEME_COOKIE)?.value,
  );
  return (
    <>
      <ServiceIntakeRouter
        initialTheme={initialTheme}
        enabled={intakeEnabled()}
        preview={intakePreview()}
        shareEmail={SHEET_SHARE_EMAIL}
        contactEmail={INTAKE_RECIPIENT}
      />
      {children}
    </>
  );
}
